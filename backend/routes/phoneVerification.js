const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { log }  = require('../helpers/logger');
const { sendSms } = require('../helpers/smsProvider');

// Hilfsfunktion: Admin oder Closer mit can_edit_contacts
function canVerify(user) {
  return user.role === 'admin' || !!user.can_edit_contacts;
}

// Grobe Plausibilitätsprüfung: mindestens 7 Ziffern
function isPlausiblePhone(phone) {
  return typeof phone === 'string' && /\d{7,}/.test(phone.replace(/[\s\-\+\(\)]/g, ''));
}

// ── POST /api/leads/:id/phone-verification/start ──────────────
// Generiert Code, hasht ihn, sendet SMS. Rate-Limit: max 3 SMS / 30 min.
router.post('/:id/phone-verification/start', auth, async (req, res) => {
  if (!canVerify(req.user))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const leadId = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query(
      'SELECT id, phone, phone_verified, phone_verify_sent_at, phone_verify_attempts FROM leads WHERE id=?',
      [leadId]
    );
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!lead.phone || !isPlausiblePhone(lead.phone))
      return res.status(400).json({ error: 'Keine gültige Telefonnummer gespeichert' });
    if (lead.phone_verified)
      return res.status(400).json({ error: 'Telefonnummer ist bereits verifiziert' });

    // Rate-Limit: max 3 Versuche in 30 Minuten
    if (lead.phone_verify_sent_at) {
      const sentAt  = new Date(lead.phone_verify_sent_at);
      const diffMin = (Date.now() - sentAt.getTime()) / 60000;
      if (diffMin < 30 && lead.phone_verify_attempts >= 3)
        return res.status(429).json({ error: 'Zu viele Versuche. Bitte 30 Minuten warten.' });
      // Cooldown: mindestens 2 Minuten zwischen SMS
      if (diffMin < 2)
        return res.status(429).json({ error: 'Bitte 2 Minuten warten, bevor eine neue SMS gesendet wird.' });
    }

    // 6-stelligen Code generieren
    const code     = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 Minuten

    await db.query(
      `UPDATE leads SET
        phone_verify_code_hash   = ?,
        phone_verify_expires_at  = ?,
        phone_verify_sent_at     = NOW(),
        phone_verify_attempts    = 0
       WHERE id = ?`,
      [codeHash, expiresAt, leadId]
    );

    // SMS senden — Code NICHT ins Log schreiben
    await sendSms(
      lead.phone,
      `Ihr NovaFlow Verifizierungscode lautet: ${code}. Gültig 10 Minuten.`
    );

    await log(req.user.id, 'phone_verify_start', 'lead', leadId, { phone: lead.phone }, req.ip);
    res.json({ ok: true });
  } catch (e) {
    console.error('phone-verify start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/leads/:id/phone-verification/confirm ────────────
// Vergleicht Code-Hash. Max 5 Fehlversuche pro Code.
router.post('/:id/phone-verification/confirm', auth, async (req, res) => {
  if (!canVerify(req.user))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const leadId = parseInt(req.params.id);
  const { code } = req.body;

  if (!code || !/^\d{6}$/.test(String(code).trim()))
    return res.status(400).json({ error: 'Bitte einen 6-stelligen Code eingeben.' });

  try {
    const [[lead]] = await db.query(
      `SELECT id, phone_verified, phone_verify_code_hash,
              phone_verify_expires_at, phone_verify_attempts
       FROM leads WHERE id=?`,
      [leadId]
    );
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (lead.phone_verified)
      return res.status(400).json({ error: 'Bereits verifiziert' });
    if (!lead.phone_verify_code_hash)
      return res.status(400).json({ error: 'Kein aktiver Verifizierungscode. Bitte neue SMS anfordern.' });
    if (new Date(lead.phone_verify_expires_at) < new Date())
      return res.status(400).json({ error: 'Code abgelaufen. Bitte neue SMS anfordern.' });
    if (lead.phone_verify_attempts >= 5) {
      await db.query(
        'UPDATE leads SET phone_verify_code_hash=NULL WHERE id=?',
        [leadId]
      );
      return res.status(400).json({ error: 'Zu viele Fehlversuche. Bitte neue SMS anfordern.' });
    }

    const match = await bcrypt.compare(String(code).trim(), lead.phone_verify_code_hash);
    if (!match) {
      await db.query(
        'UPDATE leads SET phone_verify_attempts = phone_verify_attempts + 1 WHERE id=?',
        [leadId]
      );
      const left = 4 - lead.phone_verify_attempts;
      return res.status(400).json({ error: `Falscher Code.${left > 0 ? ` Noch ${left} Versuch(e).` : ''}` });
    }

    // Korrekt — verifizieren + Code löschen
    await db.query(
      `UPDATE leads SET
        phone_verified           = 1,
        phone_verified_at        = NOW(),
        phone_verify_code_hash   = NULL,
        phone_verify_expires_at  = NULL,
        phone_verify_attempts    = 0
       WHERE id=?`,
      [leadId]
    );
    await log(req.user.id, 'phone_verified', 'lead', leadId, null, req.ip);
    res.json({ ok: true });
  } catch (e) {
    console.error('phone-verify confirm error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
