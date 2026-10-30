// ── Rückläufer (Bounces) erkennen ─────────────────────────────
// Kommt eine Mail nicht an (z. B. „550 Mailbox is disabled“), schickt der Mailserver eine
// Fehlermeldung von MAILER-DAEMON/postmaster zurück. Der IMAP-Abruf erkennt sie, ordnet sie
// dem Lead zu (über die Message-ID der Original-Mail oder die Empfängeradresse) und meldet es:
// angeheftete rote Notiz im Lead, Hinweis + Handy-Push an Admin und zuständigen Vertriebler.
const db = require('../db');

const ABSENDER = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const BETREFF = /undeliver|unzustellbar|nicht zustellbar|delivery status notification \(failure\)|mail delivery failed|returned mail|failure notice|delivery has failed|zustellung fehlgeschlagen|unable to deliver|nicht zugestellt/i;

function istRuecklaeufer({ from = '', fromName = '', subject = '' }) {
  return ABSENDER.test(`${from} ${fromName}`) || BETREFF.test(subject);
}

// Empfänger, Grund und Message-IDs der Original-Mail aus dem Text der Fehlermeldung
function auswerten(text, eigene = []) {
  const t = String(text || '');
  const adr = (re) => { const m = t.match(re); return m ? m[1].toLowerCase() : null; };
  let empfaenger = adr(/Final-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)/i)
    || adr(/Original-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)/i)
    || adr(/<([^\s<>]+@[^\s<>]+)>:/);
  if (!empfaenger) {
    const alle = (t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(x => x.toLowerCase());
    empfaenger = alle.find(a => !eigene.includes(a) && !/mailer-daemon|postmaster/.test(a)) || null;
  }
  const grund = (t.match(/Diagnostic-Code:\s*smtp;\s*([^\n]+)/i) || t.match(/\b(5\d\d[ -]\d\.\d\.\d+[^\n]{0,160})/) || t.match(/\b(5\d\d [^\n]{5,160})/) || [])[1];
  const ids = [...t.matchAll(/Message-ID:\s*(<[^>\s]+>)/gi)].map(m => m[1]);
  return { empfaenger, grund: grund ? grund.trim().slice(0, 200) : null, ids: [...new Set(ids)] };
}

async function leadFinden({ empfaenger, ids }) {
  if (ids.length) {
    const [[r]] = await db.query(
      `SELECT le.lead_id FROM lead_emails le JOIN leads l ON l.id=le.lead_id
       WHERE le.message_id IN (${ids.map(() => '?').join(',')}) AND le.direction='outbound' AND l.archived_at IS NULL
       ORDER BY le.id DESC LIMIT 1`, ids);
    if (r) return r.lead_id;
  }
  if (empfaenger) {
    const [[l]] = await db.query("SELECT id FROM leads WHERE LOWER(TRIM(email))=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1", [empfaenger]);
    if (l) return l.id;
    const [[e]] = await db.query(
      `SELECT le.lead_id FROM lead_emails le JOIN leads l ON l.id=le.lead_id
       WHERE le.direction='outbound' AND LOWER(le.to_address) LIKE ? AND l.archived_at IS NULL ORDER BY le.id DESC LIMIT 1`, [`%${empfaenger}%`]);
    if (e) return e.lead_id;
  }
  return null;
}

// Gibt true zurück, wenn der Rückläufer neu war und gemeldet wurde
async function verarbeiten({ messageId, subject, text, receivedAt, eigene = [] }) {
  const info = auswerten(text, eigene);
  const leadId = await leadFinden(info);
  if (!leadId) return false;
  const [r] = await db.query(
    `INSERT IGNORE INTO lead_emails (lead_id, direction, from_address, from_name, to_address, subject, body_text, message_id, received_at, is_read)
     VALUES (?, 'inbound', 'mailer-daemon', 'Mail kam nicht an', ?, ?, ?, ?, ?, 0)`,
    [leadId, info.empfaenger || '', `⚠️ Unzustellbar: ${String(subject || '').slice(0, 450)}`, String(text || '').slice(0, 8000), messageId, receivedAt || new Date()]);
  if (!r.affectedRows) return false;   // schon verarbeitet
  const [[lead]] = await db.query('SELECT id, company, assigned_to FROM leads WHERE id=?', [leadId]);
  const satz = `E-Mail an ${info.empfaenger || 'den Kunden'} kam nicht an${info.grund ? ` (${info.grund})` : ''}. Bitte die Adresse prüfen und neu senden.`;
  const [[admin]] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1");
  await db.query('INSERT INTO comments (lead_id, user_id, text, pinned_at, pinned_by) VALUES (?,?,?,NOW(),NULL)',
    [leadId, lead.assigned_to || (admin && admin.id) || 1, `⚠️ ${satz}`]).catch(e => console.error('Rückläufer Notiz:', e.message));
  const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
  const an = [...new Set([...admins.map(a => a.id), lead.assigned_to].filter(Boolean))];
  const push = require('./push');
  for (const uid of an) {
    await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent) VALUES (?,?,NOW(),?, 'info', 1)",
      [leadId, uid, `⚠️ Mail an ${lead.company} kam nicht an – ${info.empfaenger || 'Adresse'} prüfen`.slice(0, 500)]).catch(() => {});
    await push.sendePush(uid, { title: `Mail kam nicht an: ${lead.company}`, body: satz, leadId, tag: `bounce-${leadId}` }).catch(() => {});
  }
  console.log(`[IMAP Poller] Rückläufer für Lead ${leadId} (${info.empfaenger || '?'})`);
  return true;
}

module.exports = { istRuecklaeufer, auswerten, verarbeiten };
