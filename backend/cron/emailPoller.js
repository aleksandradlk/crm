const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../db');

function isConfigured() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

async function setSetting(key, value) {
  await db.query(
    'INSERT INTO app_settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
    [key, value, value]
  ).catch(() => {});
}

// Message-IDs aus In-Reply-To/References-Headern extrahieren, normalisiert als "<id>"
function extractMessageIds(...sources) {
  const ids = new Set();
  for (const src of sources) {
    const items = Array.isArray(src) ? src : [src];
    for (const item of items) {
      const str = String(item || '');
      let matched = false;
      for (const m of str.matchAll(/<([^<>\s]+)>/g)) { ids.add(`<${m[1]}>`); matched = true; }
      // Fallback: Wert ohne spitze Klammern (mailparser liefert references teils ohne)
      if (!matched && str.trim() && str.includes('@')) ids.add(`<${str.trim()}>`);
    }
  }
  return [...ids];
}

// HTML grob in Text umwandeln (Fallback wenn kein Text-Part vorhanden)
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function processMessage(msg) {
  const messageId = msg.envelope?.messageId;
  if (!messageId) return;

  // Bereits verarbeitet?
  const [[existing]] = await db.query(
    'SELECT id FROM lead_emails WHERE message_id=?', [messageId]
  ).catch(() => [[null]]);
  if (existing) return;

  // Vollständige Mail parsen (Header, Text, HTML, Encodings — inkl. Umlaute)
  const parsed = await simpleParser(msg.source);

  const fromAddr = (parsed.from?.value?.[0]?.address || msg.envelope?.from?.[0]?.address || '').toLowerCase();
  const subject  = parsed.subject || msg.envelope?.subject || '';

  // Eigene gesendete Mails nicht als Eingang importieren
  const selfAddr = (process.env.IMAP_USER || '').toLowerCase();
  if (fromAddr && fromAddr === selfAddr) return;

  // ── 4-stufige Lead-Zuordnung ─────────────────────────────
  let leadId = null;

  // Stufe 1: X-CRM-Lead-ID Header (direkter Treffer)
  const crmHeader = parsed.headers.get('x-crm-lead-id');
  if (crmHeader) {
    const cid = parseInt(String(crmHeader).trim());
    if (!isNaN(cid)) {
      const [[row]] = await db.query(
        'SELECT id FROM leads WHERE id=? AND archived_at IS NULL LIMIT 1', [cid]
      ).catch(() => [[null]]);
      if (row) leadId = row.id;
    }
  }

  // Stufe 2: In-Reply-To / References gegen gesendete Message-IDs
  if (!leadId) {
    const refIds = extractMessageIds(parsed.inReplyTo, parsed.references);
    if (refIds.length) {
      const placeholders = refIds.map(() => '?').join(',');
      const [[row]] = await db.query(
        `SELECT lead_id FROM lead_emails WHERE message_id IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
        refIds
      ).catch(() => [[null]]);
      if (row) leadId = row.lead_id;
    }
  }

  // Stufe 3: [NF-{id}] im Betreff
  if (!leadId) {
    const match = subject.match(/\[NF-(\d+)\]/i);
    if (match) {
      const sid = parseInt(match[1]);
      const [[row]] = await db.query(
        'SELECT id FROM leads WHERE id=? AND archived_at IS NULL LIMIT 1', [sid]
      ).catch(() => [[null]]);
      if (row) leadId = row.id;
    }
  }

  // Stufe 4: E-Mail-Adresse des Absenders (Fallback)
  if (!leadId && fromAddr) {
    const [[row]] = await db.query(
      'SELECT id FROM leads WHERE LOWER(email)=? AND archived_at IS NULL LIMIT 1', [fromAddr]
    ).catch(() => [[null]]);
    if (row) leadId = row.id;
  }

  let bodyText = (parsed.text || '').trim();
  if (!bodyText && parsed.html) bodyText = htmlToText(parsed.html);

  const receivedAt = parsed.date || msg.envelope?.date || new Date();
  const toAddr     = parsed.to?.value?.[0]?.address || msg.envelope?.to?.[0]?.address || process.env.IMAP_USER;

  if (!leadId) {
    // Kein Lead gefunden → in unmatched_emails speichern (Admin-Liste)
    await db.query(
      `INSERT IGNORE INTO unmatched_emails (from_address, to_address, subject, body_text, message_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fromAddr, toAddr, subject, bodyText.slice(0, 10000), messageId, receivedAt]
    ).catch(() => {});
    return;
  }

  await db.query(
    `INSERT IGNORE INTO lead_emails (lead_id, direction, from_address, to_address, subject, body_text, message_id, received_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?)`,
    [leadId, fromAddr, toAddr, subject, bodyText.slice(0, 10000), messageId, receivedAt]
  ).catch(() => {});
}

async function pollIncomingEmails() {
  if (!isConfigured()) return;

  // Letzten Abfrage-Zeitpunkt aus DB lesen
  const [[lastPollRow]] = await db.query(
    "SELECT value FROM app_settings WHERE key_name='imap_last_poll'"
  ).catch(() => [[null]]);

  // Erster Lauf: nur letzte 30 Tage; sonst: seit letztem Poll minus 10 min Puffer
  // Ungültigen/korrumpierten Datumswert abfangen → Fallback auf 30 Tage
  const since = (() => {
    if (lastPollRow?.value) {
      const d = new Date(lastPollRow.value);
      if (!isNaN(d.getTime())) return new Date(d.getTime() - 10 * 60 * 1000);
    }
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  })();

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
    tls: { rejectUnauthorized: process.env.IMAP_REJECT_UNAUTHORIZED !== 'false' }
  });

  try {
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Nur neue Nachrichten seit dem letzten Poll abrufen (nicht alle)
        const uids = await client.search({ since }, { uid: true });

        if (uids && uids.length > 0) {
          // msg.source = komplette Roh-Mail; wird unten mit mailparser geparst
          for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
            try {
              await processMessage(msg);
            } catch (e) {
              // Einzelne fehlerhafte Mail überspringen, Rest weiterverarbeiten
              console.error('[IMAP Poller] Nachricht übersprungen:', e.message);
            }
          }
        }
      } finally {
        lock.release();
      }

      // Letzten Poll-Zeitpunkt aktualisieren (nur bei erfolgreichem Lauf)
      const now = new Date().toISOString();
      await setSetting('imap_last_poll', now);
      await setSetting('imap_last_error', '');

    } finally {
      // Verbindung immer schließen, auch bei Fehlern im Fetch-Loop
      try { await client.logout(); } catch (_) {}
    }
  } catch (e) {
    // Fehler für Admin-Statusanzeige speichern
    await setSetting('imap_last_error', `${new Date().toISOString()} | ${e.message}`);
    if (e.code !== 'ECONNREFUSED') {
      console.error('[IMAP Poller]', e.message);
    }
  }
}

module.exports = { pollIncomingEmails, isConfigured };
