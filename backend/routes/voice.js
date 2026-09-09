const router  = require('express').Router();
const express = require('express');
const twilio  = require('twilio');
const { auth } = require('../middleware/auth');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_DEFAULT_CALLER_ID,
} = process.env;

const E164 = /^\+[1-9]\d{6,14}$/;

function voiceConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_TWIML_APP_SID);
}

function restClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// ── GET /api/voice/status — sagt dem Frontend ob Browser-Anrufe verfügbar sind ──
router.get('/status', auth, (req, res) => {
  res.json({ enabled: voiceConfigured() });
});

// ── GET /api/voice/token — Access Token fürs Twilio Voice SDK im Browser ──
router.get('/token', auth, (req, res) => {
  if (!voiceConfigured())
    return res.status(503).json({ error: 'Telefonie ist noch nicht eingerichtet. Bitte Admin kontaktieren.' });
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant  = AccessToken.VoiceGrant;
    const identity    = `user_${req.user.id}`;
    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
      identity, ttl: 3600,
    });
    token.addGrant(new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: false,
    }));
    res.json({ token: token.toJwt(), identity });
  } catch(e) {
    console.error('voice token error:', e);
    res.status(500).json({ error: 'Token konnte nicht erstellt werden.' });
  }
});

// ── GET /api/voice/caller-ids — eigene + verifizierte Nummern im Twilio-Account ──
router.get('/caller-ids', auth, async (req, res) => {
  const client = restClient();
  if (!client) return res.json([]);
  try {
    const [owned, verified] = await Promise.all([
      client.incomingPhoneNumbers.list({ limit: 100 }),
      client.outgoingCallerIds.list({ limit: 100 }),
    ]);
    const numbers = [
      ...owned.map(n => ({ phone_number: n.phoneNumber, label: n.friendlyName || n.phoneNumber, type: 'eigene Nummer' })),
      ...verified.map(n => ({ phone_number: n.phoneNumber, label: n.friendlyName || n.phoneNumber, type: 'verifiziert' })),
    ];
    res.json(numbers);
  } catch(e) {
    console.error('caller-ids error:', e);
    res.json([]);
  }
});

// ── POST /api/voice/caller-ids/verify — Verifizierung einer neuen Absender-Nummer starten ──
// Twilio ruft die Nummer sofort an und liest per Ansage einen Code vor, der über die
// Telefontastatur bestätigt werden muss — erst danach darf sie als Caller-ID genutzt werden.
router.post('/caller-ids/verify', auth, async (req, res) => {
  const client = restClient();
  if (!client) return res.status(503).json({ error: 'Telefonie ist noch nicht eingerichtet.' });
  const phone = (req.body.phone_number || '').trim();
  if (!E164.test(phone))
    return res.status(400).json({ error: 'Bitte Nummer im internationalen Format eingeben, z. B. +491701234567' });
  try {
    const result = await client.validationRequests.create({
      phoneNumber: phone,
      friendlyName: `${req.user.full_name} (${req.user.username})`,
    });
    res.json({ validation_code: result.validationCode, phone_number: result.phoneNumber });
  } catch(e) {
    console.error('caller-id verify error:', e);
    res.status(400).json({ error: e.message || 'Verifizierung konnte nicht gestartet werden.' });
  }
});

// ── POST /api/voice/twiml — Twilio Voice Webhook ──
// Wird von Twilio selbst aufgerufen (nicht vom Browser), daher kein JWT-Auth,
// stattdessen Signaturprüfung über den Twilio-Auth-Token.
const twimlMiddlewares = [express.urlencoded({ extended: false })];
if (TWILIO_AUTH_TOKEN) twimlMiddlewares.push(twilio.webhook(TWILIO_AUTH_TOKEN));

router.post('/twiml', ...twimlMiddlewares, (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const to       = (req.body.To || '').trim();
  const callerId = (req.body.CallerId || '').trim();

  if (!E164.test(to)) {
    response.say({ language: 'de-DE' }, 'Ungültige Zielrufnummer.');
    return res.type('text/xml').send(response.toString());
  }

  const safeCallerId = E164.test(callerId) ? callerId : (TWILIO_DEFAULT_CALLER_ID || undefined);
  const dial = response.dial({ callerId: safeCallerId, timeout: 25 });
  dial.number(to);
  res.type('text/xml').send(response.toString());
});

module.exports = router;
