const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../db');

// Verhindert, dass sich zwei Abrufe überlappen (Cron läuft alle 2 Minuten)
let _running = false;

// Speicher schonen (Shared Hosting): Mails einzeln, begrenzt und ohne große Anhänge laden
const MAX_PER_RUN      = 25;
const MAX_SOURCE_BYTES = 512 * 1024;

// Message-IDs aus In-Reply-To / References extrahieren (String oder Array)
function extractMessageIds(...values) {
  const ids = [];
  for (const v of values) {
    if (!v) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      const s = String(item);
      const matches = [...s.matchAll(/<([^>]+)>/g)].map(m => `<${m[1]}>`);
      if (matches.length) ids.push(...matches);
      else if (s.trim()) ids.push(`<${s.trim().replace(/^<|>$/g, '')}>`);
    }
  }
  return [...new Set(ids)];
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n');
}

// Eine Mail gehört nur dann ins CRM, wenn sie eine Antwort auf eine Mail aus dem
// CRM ist. Alle anderen Mails an das Postfach (Newsletter, Rechnungen, private
// Anfragen …) werden weder geladen noch gespeichert und sind für niemanden im CRM sichtbar.
//   1. In-Reply-To / References verweisen auf eine aus dem CRM gesendete Mail
//      (Kunde hat in seinem Mailprogramm auf „Antworten“ geklickt)
//   2. Fallback: Lead-Kennung [NF-123] im Betreff, falls das Mailprogramm die
//      Antwort-Header nicht mitschickt
async function findLeadId({ inReplyTo, references, subject }) {
  const refIds = extractMessageIds(inReplyTo, references);
  if (refIds.length) {
    const placeholders = refIds.map(() => '?').join(',');
    const [[row]] = await db.query(
      `SELECT le.lead_id FROM lead_emails le JOIN leads l ON l.id = le.lead_id
       WHERE le.message_id IN (${placeholders}) AND l.archived_at IS NULL
       ORDER BY le.id DESC LIMIT 1`,
      refIds
    );
    if (row) return row.lead_id;
  }
  const match = String(subject || '').match(/\[NF-(\d+)\]/i);
  if (match && /^\s*(re|aw|antw|antwort|wg|fw|fwd)\s*:/i.test(subject)) {
    const [[row]] = await db.query(
      'SELECT id FROM leads WHERE id=? AND archived_at IS NULL LIMIT 1', [parseInt(match[1])]
    );
    if (row) return row.id;
  }
  return null;
}

async function saveStatus(status) {
  const value = JSON.stringify({ ...status, at: new Date().toISOString() });
  await db.query(
    "INSERT INTO app_settings (key_name, value) VALUES ('imap_status',?) ON DUPLICATE KEY UPDATE value=?",
    [value, value]
  ).catch(() => {});
}

async function pollIncomingEmails() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    await saveStatus({ ok: false, error: 'IMAP ist nicht konfiguriert (IMAP_HOST / IMAP_USER / IMAP_PASS in .env fehlen)' });
    return;
  }
  if (_running) return;
  _running = true;

  const ownAddresses = [user, process.env.SMTP_USER].filter(Boolean).map(a => a.toLowerCase());
  const stats = { checked: 0, matched: 0, ignored: 0, failed: 0, pending: 0 };

  try {
    // Letzten erfolgreichen Abruf aus DB lesen
    const [[lastPollRow]] = await db.query(
      "SELECT value FROM app_settings WHERE key_name='imap_last_poll'"
    ).catch(() => [[null]]);

    // Erster Lauf: letzte 30 Tage; sonst: seit letztem Abruf minus 1 Tag Puffer
    // (IMAP-SINCE arbeitet nur tagesgenau, Duplikate fängt die Message-ID-Prüfung ab)
    const since = (() => {
      if (lastPollRow?.value) {
        const d = new Date(lastPollRow.value);
        if (!isNaN(d.getTime())) return new Date(d.getTime() - 24 * 60 * 60 * 1000);
      }
      return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    })();

    const client = new ImapFlow({
      host,
      port: parseInt(process.env.IMAP_PORT || '993'),
      secure: process.env.IMAP_SECURE !== 'false',
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: process.env.IMAP_REJECT_UNAUTHORIZED !== 'false' }
    });

    await client.connect();
    try {
      const lock = await client.getMailboxLock(process.env.IMAP_FOLDER || 'INBOX');
      try {
        const uids = await client.search({ since }, { uid: true });
        if (uids && uids.length > 0) {
          // Schritt 1: nur Umschläge + References-Header holen (leichtgewichtig) und
          // hier schon entscheiden, ob die Mail eine Antwort auf eine CRM-Mail ist.
          // Nur diese werden danach komplett geladen.
          const candidates = [];
          for await (const msg of client.fetch(uids, { envelope: true, headers: ['references'] }, { uid: true })) {
            const messageId = msg.envelope?.messageId;
            const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
            if (!messageId || ownAddresses.includes(from)) continue;
            const refHeader = msg.headers ? msg.headers.toString().replace(/^references:\s*/i, '') : '';
            candidates.push({ uid: msg.uid, messageId, inReplyTo: msg.envelope?.inReplyTo, references: refHeader, subject: msg.envelope?.subject || '' });
          }
          const newUids = [];
          const leadByUid = new Map();
          for (const c of candidates) {
            const [[existing]] = await db.query('SELECT 1 AS x FROM lead_emails WHERE message_id=? LIMIT 1', [c.messageId]);
            if (existing) continue;
            const leadId = await findLeadId(c);
            if (!leadId) { stats.ignored++; continue; }
            leadByUid.set(c.uid, leadId);
            newUids.push(c.uid);
          }
          newUids.sort((a, b) => a - b);

          // Schritt 2: neue Mails einzeln laden und sofort verarbeiten — nie alle
          // gleichzeitig im Speicher. Pro Lauf höchstens MAX_PER_RUN Mails, der Rest
          // folgt beim nächsten Abruf (wichtig beim ersten Import von 30 Tagen).
          const batch = newUids.slice(0, MAX_PER_RUN);
          stats.pending = newUids.length - batch.length;

          for (const uid of batch) {
            stats.checked++;
            try {
              // Text steht im MIME-Aufbau vor den Anhängen — große Anhänge
              // werden nicht mitgeladen.
              const msg = await client.fetchOne(uid, { envelope: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
              if (!msg || !msg.source) continue;
              const envelope = msg.envelope;
              const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
              const messageId = envelope?.messageId || parsed.messageId;
              if (!messageId) continue;

              const fromAddr = (parsed.from?.value?.[0]?.address || envelope?.from?.[0]?.address || '').toLowerCase();
              // Eigene Mails (z.B. Kopien im Posteingang) nicht als Kundenantwort speichern
              if (ownAddresses.includes(fromAddr)) continue;

              const fromName = parsed.from?.value?.[0]?.name || '';
              const subject  = parsed.subject || envelope?.subject || '';
              const toAddr   = parsed.to?.value?.[0]?.address || envelope?.to?.[0]?.address || user;
              const receivedAt = parsed.date || envelope?.date || new Date();
              const bodyText = (parsed.text || htmlToText(parsed.html) || '')
                .replace(/\r\n/g, '\n').trim().slice(0, 60000);

              const leadId = leadByUid.get(uid);

              await db.query(
                `INSERT IGNORE INTO lead_emails (lead_id, direction, from_address, from_name, to_address, subject, body_text, message_id, received_at, is_read)
                 VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, 0)`,
                [leadId, fromAddr, fromName || null, toAddr, subject, bodyText, messageId, receivedAt]
              );
              // Lead nach oben holen, damit die Antwort im Verlauf/Listen sichtbar wird
              await db.query('UPDATE leads SET updated_at=NOW() WHERE id=?', [leadId]).catch(() => {});
              stats.matched++;
            } catch (e) {
              // Eine kaputte Mail darf den Abruf aller anderen nicht blockieren
              stats.failed++;
              console.error('[IMAP Poller] Mail konnte nicht verarbeitet werden:', e.message);
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch (_) {}
    }

    // Letzten Poll-Zeitpunkt nur aktualisieren, wenn alles abgearbeitet ist —
    // sonst würden noch nicht geladene ältere Mails beim nächsten Lauf übersprungen
    if (!stats.pending) {
      const now = new Date().toISOString();
      await db.query(
        "INSERT INTO app_settings (key_name, value) VALUES ('imap_last_poll',?) ON DUPLICATE KEY UPDATE value=?",
        [now, now]
      ).catch(() => {});
    }
    await saveStatus({ ok: true, ...stats });
  } catch (e) {
    console.error('[IMAP Poller]', e.message);
    await saveStatus({ ok: false, error: e.responseText || e.message, ...stats });
  } finally {
    _running = false;
  }
}

module.exports = { pollIncomingEmails };
