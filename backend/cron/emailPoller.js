const { ImapFlow } = require('imapflow');
const db = require('../db');

async function pollIncomingEmails() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return; // nicht konfiguriert

  const client = new ImapFlow({
    host,
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch('1:*', { envelope: true, bodyParts: ['text'] })) {
        const messageId = msg.envelope?.messageId;
        if (!messageId) continue;

        // Bereits verarbeitet?
        const [[existing]] = await db.query(
          'SELECT id FROM lead_emails WHERE message_id=?', [messageId]
        ).catch(() => [[null]]);
        if (existing) continue;

        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase();
        if (!fromAddr) continue;

        // Lead anhand E-Mail-Adresse suchen
        const [[lead]] = await db.query(
          'SELECT id FROM leads WHERE LOWER(email)=? AND archived_at IS NULL LIMIT 1', [fromAddr]
        ).catch(() => [[null]]);
        if (!lead) continue;

        const subject = msg.envelope?.subject || '(kein Betreff)';
        const receivedAt = msg.envelope?.date || new Date();

        // Body-Text extrahieren
        let bodyText = '';
        if (msg.bodyParts) {
          for (const [, part] of msg.bodyParts) {
            bodyText += Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
          }
        }
        // HTML-Tags entfernen
        bodyText = bodyText.replace(/<[^>]+>/g, '').replace(/\r\n/g, '\n').trim();

        await db.query(
          `INSERT INTO lead_emails (lead_id, direction, from_address, to_address, subject, body_text, message_id, received_at)
           VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?)`,
          [lead.id, fromAddr, user, subject, bodyText.slice(0, 10000), messageId, receivedAt]
        ).catch(() => {});
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    if (e.code !== 'ECONNREFUSED') {
      console.error('[IMAP Poller]', e.message);
    }
  }
}

module.exports = { pollIncomingEmails };
