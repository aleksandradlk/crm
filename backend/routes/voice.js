// ── Browser-Telefonie über Twilio Voice ──────────────────────
// Ablauf eines Anrufs:
//  1. Browser: POST /api/leads/:id/calls/start → call_logs-Eintrag (status 'started')
//  2. Browser: POST /api/voice/token → Access-Token, Twilio.Device.connect({ callLogId })
//  3. Twilio:  POST /api/voice/twiml → wir antworten mit <Dial callerId=…>Lead-Nummer</Dial>
//  4. Twilio:  POST /api/voice/dial-status → Dauer + Ergebnis landen im call_logs-Eintrag
const router = require('express').Router();
const express = require('express');
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { toE164 } = require('../helpers/phone');

let twilio = null;
try { twilio = require('twilio'); } catch (_) { /* Paket nicht installiert → Telefonie aus */ }

const env = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken:  process.env.TWILIO_AUTH_TOKEN,
  apiKey:     process.env.TWILIO_API_KEY_SID,
  apiSecret:  process.env.TWILIO_API_KEY_SECRET,
  appSid:     process.env.TWILIO_TWIML_APP_SID,
  // Optionale Firmennummer: wird genutzt, wenn ein Mitarbeiter keine eigene Nummer hinterlegt hat
  companyCallerId: toE164(process.env.TWILIO_CALLER_ID),
});

function isConfigured() {
  const e = env();
  return !!(twilio && e.accountSid && e.authToken && e.apiKey && e.apiSecret && e.appSid);
}

function client() {
  const e = env();
  return twilio(e.accountSid, e.authToken);
}

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Prüft, ob eine Nummer bei Twilio als Absender erlaubt ist
// (verifizierte Caller-ID oder eigene Twilio-Nummer).
async function isAllowedCallerId(number) {
  const c = client();
  const [verified, owned] = await Promise.all([
    c.outgoingCallerIds.list({ phoneNumber: number, limit: 1 }),
    c.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 }),
  ]);
  return verified.length > 0 || owned.length > 0;
}

// Webhooks von Twilio: Signatur prüfen, damit niemand fremdes Anrufe auslösen kann
function twilioWebhook(req, res, next) {
  if (!isConfigured()) return res.status(503).type('text/plain').send('Telefonie nicht konfiguriert');
  const signature = req.get('X-Twilio-Signature') || '';
  const url = baseUrl(req) + req.originalUrl;
  if (!twilio.validateRequest(env().authToken, signature, url, req.body || {})) {
    console.warn('[Voice] Ungültige Twilio-Signatur für', url);
    return res.status(403).type('text/plain').send('Ungültige Signatur');
  }
  next();
}

function sayAndHangup(res, text) {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ language: 'de-DE' }, text);
  vr.hangup();
  res.type('text/xml').send(vr.toString());
}

// ── GET /api/voice/config — Ist Telefonie aktiv, welche Nummer nutze ich? ──
router.get('/config', auth, async (req, res) => {
  try {
    const [[u]] = await db.query('SELECT caller_id, caller_id_verified FROM users WHERE id=?', [req.user.id]);
    const e = env();
    res.json({
      enabled: isConfigured(),
      caller_id: u?.caller_id || null,
      caller_id_verified: !!u?.caller_id_verified,
      company_caller_id: e.companyCallerId || null,
      // Nummer, die beim Angerufenen tatsächlich angezeigt wird
      effective_caller_id: (u?.caller_id_verified && u.caller_id) || e.companyCallerId || null,
    });
  } catch (e) {
    console.error('Voice config error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/voice/token — Access-Token für das Twilio Voice SDK im Browser ──
router.post('/token', auth, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  const e = env();
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(e.accountSid, e.apiKey, e.apiSecret, {
    identity: `user-${req.user.id}`,
    ttl: 3600,
  });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: e.appSid, incomingAllow: false }));
  res.json({ token: token.toJwt(), identity: `user-${req.user.id}` });
});

// ── PUT /api/voice/caller-id — eigene Absendernummer hinterlegen ──
// Twilio lässt nur Nummern zu, deren Besitz einmalig bestätigt wurde (gesetzliche
// Vorgabe gegen Rufnummern-Fälschung). Ist die Nummer noch nicht bestätigt, ruft
// Twilio sie an und der Mitarbeiter tippt den angezeigten 6-stelligen Code ein.
router.put('/caller-id', auth, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  const number = toE164(req.body.number);
  if (!number) return res.status(400).json({ error: 'Bitte eine gültige Telefonnummer eingeben, z.B. +49 171 1234567' });
  try {
    if (await isAllowedCallerId(number)) {
      await db.query('UPDATE users SET caller_id=?, caller_id_verified=1 WHERE id=?', [number, req.user.id]);
      await log(req.user.id, 'caller_id_set', 'user', req.user.id, { number }, req.ip);
      return res.json({ number, verified: true });
    }
    const vr = await client().validationRequests.create({
      phoneNumber: number,
      friendlyName: `${req.user.full_name} (CRM)`.slice(0, 64),
    });
    await db.query('UPDATE users SET caller_id=?, caller_id_verified=0 WHERE id=?', [number, req.user.id]);
    await log(req.user.id, 'caller_id_verification_started', 'user', req.user.id, { number }, req.ip);
    res.json({ number, verified: false, validation_code: vr.validationCode });
  } catch (e) {
    console.error('Caller-ID error:', e.message);
    res.status(400).json({ error: `Nummer konnte nicht eingerichtet werden: ${e.message}` });
  }
});

// ── GET /api/voice/caller-id/status — wurde der Code inzwischen bestätigt? ──
router.get('/caller-id/status', auth, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  try {
    const [[u]] = await db.query('SELECT caller_id, caller_id_verified FROM users WHERE id=?', [req.user.id]);
    if (!u?.caller_id) return res.json({ number: null, verified: false });
    if (u.caller_id_verified) return res.json({ number: u.caller_id, verified: true });
    const ok = await isAllowedCallerId(u.caller_id);
    if (ok) await db.query('UPDATE users SET caller_id_verified=1 WHERE id=?', [req.user.id]);
    res.json({ number: u.caller_id, verified: ok });
  } catch (e) {
    console.error('Caller-ID status error:', e.message);
    res.status(500).json({ error: 'Status konnte nicht abgefragt werden.' });
  }
});

// ── DELETE /api/voice/caller-id — eigene Nummer entfernen ──
router.delete('/caller-id', auth, async (req, res) => {
  await db.query('UPDATE users SET caller_id=NULL, caller_id_verified=0 WHERE id=?', [req.user.id]);
  res.json({ ok: true });
});

// ── POST /api/voice/twiml — Twilio fragt, wohin der Browser-Anruf gehen soll ──
router.post('/twiml', express.urlencoded({ extended: false }), twilioWebhook, async (req, res) => {
  try {
    const identity = String(req.body.From || req.body.Caller || '').replace(/^client:/, '');
    const userId   = parseInt((identity.match(/^user-(\d+)$/) || [])[1]);
    const callLogId = parseInt(req.body.callLogId);
    if (!userId || !callLogId) return sayAndHangup(res, 'Der Anruf konnte nicht zugeordnet werden.');

    const [[user]] = await db.query(
      'SELECT id, is_active, caller_id, caller_id_verified FROM users WHERE id=?', [userId]
    );
    if (!user || !user.is_active) return sayAndHangup(res, 'Benutzer nicht gefunden.');

    // Gewählt wird ausschließlich die Nummer aus dem CRM-Anruf-Eintrag des Users —
    // nie eine frei vom Browser übergebene Nummer.
    const [[call]] = await db.query(
      `SELECT id, phone_number FROM call_logs
       WHERE id=? AND user_id=? AND status='started' AND twilio_call_sid IS NULL
         AND started_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
      [callLogId, userId]
    );
    if (!call) return sayAndHangup(res, 'Dieser Anruf ist nicht mehr gültig. Bitte erneut starten.');

    const to = toE164(call.phone_number);
    if (!to) return sayAndHangup(res, 'Die Telefonnummer des Leads ist ungültig.');

    const callerId = (user.caller_id_verified && user.caller_id) || env().companyCallerId;
    if (!callerId) return sayAndHangup(res, 'Es ist keine Absendernummer hinterlegt. Bitte in den Einstellungen eine Nummer eintragen.');

    await db.query('UPDATE call_logs SET twilio_call_sid=? WHERE id=?', [req.body.CallSid || null, call.id]);

    const vr = new twilio.twiml.VoiceResponse();
    const dial = vr.dial({
      callerId,
      answerOnBridge: true,  // Browser hört das echte Freizeichen; "verbunden" erst bei Abheben
      timeout: 40,
      action: `${baseUrl(req)}/api/voice/dial-status?callLogId=${call.id}`,
      method: 'POST',
    });
    dial.number(to);
    res.type('text/xml').send(vr.toString());
  } catch (e) {
    console.error('Voice TwiML error:', e);
    sayAndHangup(res, 'Es ist ein technischer Fehler aufgetreten.');
  }
});

// ── POST /api/voice/dial-status — Ergebnis des Anrufs von Twilio ──
const DIAL_STATUS_MAP = {
  completed: 'reached', answered: 'reached',
  busy: 'busy', 'no-answer': 'no-answer', canceled: 'no-answer', failed: 'failed',
};
router.post('/dial-status', express.urlencoded({ extended: false }), twilioWebhook, async (req, res) => {
  try {
    const callLogId = parseInt(req.query.callLogId);
    const status    = DIAL_STATUS_MAP[req.body.DialCallStatus] || null;
    const duration  = parseInt(req.body.DialCallDuration);
    if (callLogId) {
      // Status nur setzen, wenn der Mitarbeiter ihn noch nicht selbst dokumentiert hat
      await db.query(
        `UPDATE call_logs SET
           status = IF(status='started' AND ? IS NOT NULL, ?, status),
           duration_seconds = COALESCE(?, duration_seconds),
           ended_at = COALESCE(ended_at, NOW())
         WHERE id=?`,
        [status, status, Number.isFinite(duration) ? duration : null, callLogId]
      );
    }
  } catch (e) {
    console.error('Voice dial-status error:', e);
  }
  res.type('text/xml').send(new twilio.twiml.VoiceResponse().toString());
});

module.exports = router;
module.exports.isConfigured = isConfigured;
