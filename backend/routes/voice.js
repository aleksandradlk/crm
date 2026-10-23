// ── Browser-Telefonie über Twilio Voice ──────────────────────
// Ablauf eines Anrufs:
//  1. Browser: POST /api/leads/:id/calls/start → call_logs-Eintrag (status 'started')
//  2. Browser: POST /api/voice/token → Access-Token, Twilio.Device.connect({ callLogId })
//  3. Twilio:  POST /api/voice/twiml → wir antworten mit <Dial callerId=…>Lead-Nummer</Dial>
//  4. Twilio:  POST /api/voice/dial-status → Dauer + Ergebnis landen im call_logs-Eintrag
const router = require('express').Router();
const express = require('express');
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { toE164 } = require('../helpers/phone');
const { findLeadByPhone, refreshNorm } = require('../helpers/dedupe');

let twilio = null;
try { twilio = require('twilio'); } catch (_) { /* Paket nicht installiert → Telefonie aus */ }

// Zugangsdaten: aus .env (TWILIO_…) oder – ohne .env – aus der Einrichtung im CRM
// (Integrationen → Telefonie, Tabelle integrations). .env hat Vorrang.
let gespeichert = {};
async function ladeKonfiguration() {
  try {
    const [[row]] = await db.query("SELECT config FROM integrations WHERE name='twilio'");
    gespeichert = row ? JSON.parse(row.config) : {};
  } catch (_) { gespeichert = {}; }
}
const env = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID || gespeichert.accountSid,
  authToken:  process.env.TWILIO_AUTH_TOKEN || gespeichert.authToken,
  apiKey:     process.env.TWILIO_API_KEY_SID || gespeichert.apiKey,
  apiSecret:  process.env.TWILIO_API_KEY_SECRET || gespeichert.apiSecret,
  appSid:     process.env.TWILIO_TWIML_APP_SID || gespeichert.appSid,
  // Optionale Firmennummer: wird genutzt, wenn ein Mitarbeiter keine eigene Nummer hinterlegt hat
  companyCallerId: toE164(process.env.TWILIO_CALLER_ID || gespeichert.callerId),
  ausEnv: !!process.env.TWILIO_ACCOUNT_SID,
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

// Absendernummer eines Mitarbeiters: zugeteilte NovaFlow-Nummer, sonst eigene
// bestätigte Nummer, sonst Firmennummer
function absender(u) {
  return (u && u.phone_line) || (u && u.caller_id_verified && u.caller_id) || env().companyCallerId || null;
}

// ── GET /api/voice/config — Ist Telefonie aktiv, welche Nummer nutze ich? ──
router.get('/config', auth, async (req, res) => {
  try {
    const [[u]] = await db.query('SELECT caller_id, caller_id_verified, phone_line FROM users WHERE id=?', [req.user.id]);
    const e = env();
    res.json({
      enabled: isConfigured(),
      phone_line: u?.phone_line || null,
      caller_id: u?.caller_id || null,
      caller_id_verified: !!u?.caller_id_verified,
      company_caller_id: e.companyCallerId || null,
      // Nummer, die beim Angerufenen tatsächlich angezeigt wird
      effective_caller_id: absender(u),
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
  // incomingAllow: eingehende Anrufe auf die Firmennummer klingeln im Browser
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: e.appSid, incomingAllow: true }));
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
      'SELECT id, is_active, caller_id, caller_id_verified, phone_line FROM users WHERE id=?', [userId]
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

    const callerId = absender(user);
    if (!callerId) return sayAndHangup(res, 'Es ist keine Absendernummer hinterlegt. Bitte den Admin um eine Nummer bitten.');

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

// ── Eingehende Anrufe ────────────────────────────────────────
// Die Twilio-Firmennummer (Voice-Webhook: <BASE_URL>/api/voice/incoming) klingelt im CRM:
//   1. Anrufer wird über die Telefonnummer einem Lead zugeordnet
//      (unbekannte Nummer → neuer Lead „Anrufer +49 …“)
//   2. Es klingelt zuerst beim betreuenden Vertriebler (20 s), dann beim ganzen Team (25 s)
//   3. Nimmt niemand ab: Ansage + automatische Rückruf-Aufgabe („Verpasster Anruf“)
// Ruft jemand die persönliche Nummer eines Mitarbeiters an, klingelt es nur bei ihm (30 s);
// verpasste Anrufe landen als Rückruf-Aufgabe bei ihm.
const RING_OWNER_SEC = 20;
const RING_TEAM_SEC  = 25;
const RING_LINE_SEC  = 30;

async function firstAdminId() {
  const [[a]] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1");
  return a?.id || null;
}

function dialClients(vr, req, users, { callLogId, lead, stage, timeout }) {
  const dial = vr.dial({
    timeout,
    answerOnBridge: true,
    action: `${baseUrl(req)}/api/voice/incoming-next?callLogId=${callLogId}&stage=${stage}`,
    method: 'POST',
  });
  for (const u of users.slice(0, 10)) {   // Twilio: max. 10 Ziele pro <Dial>
    const client = dial.client();
    client.identity(`user-${u.id}`);
    client.parameter({ name: 'callLogId', value: String(callLogId) });
    client.parameter({ name: 'leadId', value: String(lead.id) });
    client.parameter({ name: 'company', value: String(lead.company || '').slice(0, 100) });
  }
}

async function teamUsers(excludeId) {
  const [rows] = await db.query(
    'SELECT id FROM users WHERE is_active=1 AND id <> ? ORDER BY role=\'admin\', id', [excludeId || 0]);
  return rows;
}

router.post('/incoming', express.urlencoded({ extended: false }), twilioWebhook, async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  try {
    const from = toE164(req.body.From) || String(req.body.From || '').slice(0, 30);
    const to = toE164(req.body.To || req.body.Called);
    const [[lineOwner]] = to
      ? await db.query('SELECT id FROM users WHERE phone_line=? AND is_active=1 LIMIT 1', [to]) : [[null]];
    let lead = await findLeadByPhone(from);
    if (!lead) {
      // Unbekannte Nummer: als neuen Lead anlegen, damit Rückruf und Verlauf nicht verloren gehen.
      // Auf einer persönlichen Nummer gehört er gleich dem Mitarbeiter, der angerufen wurde.
      const createdBy = lineOwner ? lineOwner.id : await firstAdminId();
      const [r] = await db.query(
        `INSERT INTO leads (company, phone, status, created_by, assigned_to, source, confidence)
         VALUES (?, ?, 'neu', ?, ?, 'eingehender-anruf', 50)`, [`Anrufer ${from}`, from, createdBy, lineOwner ? lineOwner.id : null]);
      await refreshNorm(r.insertId);
      lead = { id: r.insertId, company: `Anrufer ${from}`, assigned_to: lineOwner ? lineOwner.id : null };
    }
    const ownerId = lineOwner ? lineOwner.id : (lead.assigned_to || null);
    const [c] = await db.query(
      `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status, twilio_call_sid)
       VALUES (?, ?, ?, 'inbound', NOW(), 'started', ?)`,
      [lead.id, ownerId || await firstAdminId(), from, req.body.CallSid || null]);
    const callLogId = c.insertId;

    if (lineOwner) {
      dialClients(vr, req, [lineOwner], { callLogId, lead, stage: 3, timeout: RING_LINE_SEC });
      return res.type('text/xml').send(vr.toString());
    }
    const [[owner]] = ownerId
      ? await db.query('SELECT id FROM users WHERE id=? AND is_active=1', [ownerId]) : [[null]];
    if (owner) dialClients(vr, req, [owner], { callLogId, lead, stage: 1, timeout: RING_OWNER_SEC });
    else dialClients(vr, req, await teamUsers(0), { callLogId, lead, stage: 2, timeout: RING_TEAM_SEC });
    res.type('text/xml').send(vr.toString());
  } catch (e) {
    console.error('Voice incoming error:', e);
    sayAndHangup(res, 'Leider ist gerade niemand erreichbar. Wir rufen Sie schnellstmöglich zurück.');
  }
});

router.post('/incoming-next', express.urlencoded({ extended: false }), twilioWebhook, async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const callLogId = parseInt(req.query.callLogId);
  const stage = parseInt(req.query.stage) || 2;
  try {
    const [[call]] = await db.query(
      `SELECT c.*, l.company, l.assigned_to FROM call_logs c JOIN leads l ON l.id = c.lead_id WHERE c.id=?`, [callLogId]);
    if (!call) { vr.hangup(); return res.type('text/xml').send(vr.toString()); }
    const status = req.body.DialCallStatus;
    if (status === 'completed' || status === 'answered') {
      const duration = parseInt(req.body.DialCallDuration);
      await db.query(
        `UPDATE call_logs SET status=IF(status='started','reached',status),
                duration_seconds=COALESCE(?, duration_seconds), ended_at=COALESCE(ended_at, NOW()) WHERE id=?`,
        [Number.isFinite(duration) ? duration : null, callLogId]);
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }
    if (stage === 1) {
      // Betreuer hat nicht abgenommen → ganzes Team
      const users = await teamUsers(call.assigned_to);
      if (users.length) {
        dialClients(vr, req, users, { callLogId, lead: { id: call.lead_id, company: call.company }, stage: 2, timeout: RING_TEAM_SEC });
        return res.type('text/xml').send(vr.toString());
      }
    }
    // Niemand erreichbar → Rückruf-Aufgabe für den Betreuer (persönliche Nummer: ihr Inhaber, sonst Admin)
    await db.query("UPDATE call_logs SET status='no-answer', ended_at=NOW() WHERE id=? AND status='started'", [callLogId]);
    const userId = (stage === 3 ? call.user_id : call.assigned_to) || await firstAdminId();
    if (userId) {
      await db.query(
        `INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent) VALUES (?, ?, NOW(), ?, 'missed_call', 1)`,
        [call.lead_id, userId, `Verpasster Anruf von ${call.phone_number}`]);
    }
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [call.lead_id, userId || call.user_id, `📞 Verpasster Anruf von ${call.phone_number}`]);
    vr.say({ language: 'de-DE' }, 'Vielen Dank für Ihren Anruf. Leider ist gerade niemand erreichbar. Wir rufen Sie schnellstmöglich zurück.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  } catch (e) {
    console.error('Voice incoming-next error:', e);
    sayAndHangup(res, 'Wir rufen Sie schnellstmöglich zurück.');
  }
});

// ── POST /api/voice/incoming/accept — Mitarbeiter hat im Browser angenommen ──
router.post('/incoming/accept', auth, async (req, res) => {
  const callLogId = parseInt(req.body.callLogId);
  try {
    const [[call]] = await db.query(
      "SELECT c.id, c.lead_id, l.assigned_to FROM call_logs c JOIN leads l ON l.id=c.lead_id WHERE c.id=? AND c.direction='inbound'",
      [callLogId]);
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });
    await db.query("UPDATE call_logs SET user_id=?, status=IF(status='started','reached',status) WHERE id=?", [req.user.id, callLogId]);
    // Freier / neuer Lead: wer abnimmt, betreut ihn
    if (!call.assigned_to) await db.query('UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL', [req.user.id, call.lead_id]);
    await log(req.user.id, 'call_incoming_accepted', 'lead', call.lead_id, { call_id: callLogId }, req.ip);
    res.json({ ok: true, lead_id: call.lead_id });
  } catch (e) {
    console.error('Voice accept error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── Telefonnummern verwalten (Admin) ─────────────────────────
// Der Admin teilt jedem Mitarbeiter eine Nummer aus dem Twilio-Konto zu (oder holt
// direkt eine neue). Der Mitarbeiter muss nichts bestätigen: Die Nummer gehört
// NovaFlow, Kunden sehen sie bei Anrufen, und Anrufe darauf klingeln bei ihm im CRM.
function twilioFehler(e) {
  const m = String(e && e.message || e);
  if (/bundle|regulat|address/i.test(m))
    return 'Für deutsche Nummern verlangt die Bundesnetzagentur einmalig einen Nachweis (Firmenadresse und Ausweis). '
      + 'Das geht in Twilio unter Phone Numbers → Regulatory Compliance. Sobald er bestätigt ist, kannst du hier Nummern holen.';
  return m;
}

// GET /api/voice/numbers — alle Nummern des Kontos mit Zuteilung
router.get('/numbers', auth, adminOnly, async (req, res) => {
  if (!isConfigured()) return res.json({ enabled: false, numbers: [] });
  try {
    const [liste, [users]] = await Promise.all([
      client().incomingPhoneNumbers.list({ limit: 200 }),
      db.query('SELECT id, full_name, phone_line FROM users WHERE phone_line IS NOT NULL'),
    ]);
    const firma = env().companyCallerId;
    res.json({
      enabled: true,
      numbers: liste.map(n => {
        const u = users.find(x => x.phone_line === n.phoneNumber);
        return { sid: n.sid, number: n.phoneNumber, name: n.friendlyName,
          user: u ? { id: u.id, name: u.full_name } : null, company: n.phoneNumber === firma };
      }),
    });
  } catch (e) {
    console.error('Voice numbers error:', e.message);
    res.status(500).json({ error: twilioFehler(e) });
  }
});

// GET /api/voice/numbers/search?vorwahl=030 — freie deutsche Nummern zum Holen
router.get('/numbers/search', auth, adminOnly, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  const vorwahl = String(req.query.vorwahl || '').replace(/\D/g, '').replace(/^0/, '');
  try {
    const opts = { voiceEnabled: true, limit: 12 };
    if (vorwahl) opts.contains = '+49' + vorwahl + '*';
    let liste = await client().availablePhoneNumbers('DE').local.list(opts);
    if (!liste.length && vorwahl) liste = await client().availablePhoneNumbers('DE').local.list({ voiceEnabled: true, limit: 12 });
    res.json({ numbers: liste.map(n => ({ number: n.phoneNumber, ort: n.locality || n.region || '' })) });
  } catch (e) {
    console.error('Voice numbers search error:', e.message);
    res.status(400).json({ error: twilioFehler(e) });
  }
});

async function zuteilen(req, sid, number, userId) {
  // Nummer dem Mitarbeiter geben (und einem eventuellen Vorgänger wegnehmen)
  await db.query('UPDATE users SET phone_line=NULL, phone_line_sid=NULL WHERE phone_line=? OR phone_line_sid=?', [number, sid]);
  let name = 'NovaFlow CRM';
  if (userId) {
    const [[u]] = await db.query('SELECT id, full_name FROM users WHERE id=? AND is_active=1', [userId]);
    if (!u) throw new Error('Benutzer nicht gefunden');
    await db.query('UPDATE users SET phone_line=?, phone_line_sid=? WHERE id=?', [number, sid, u.id]);
    name = `NovaFlow – ${u.full_name}`.slice(0, 64);
  }
  // Eingehende Anrufe auf dieser Nummer ins CRM leiten
  await client().incomingPhoneNumbers(sid).update({
    voiceUrl: `${baseUrl(req)}/api/voice/incoming`, voiceMethod: 'POST', friendlyName: name,
  });
}

// POST /api/voice/numbers/buy { number, userId } — neue Nummer holen und gleich zuteilen
router.post('/numbers/buy', auth, adminOnly, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  const number = toE164(req.body.number);
  if (!number) return res.status(400).json({ error: 'Ungültige Nummer' });
  try {
    const c = client();
    const opts = { phoneNumber: number, voiceUrl: `${baseUrl(req)}/api/voice/incoming`, voiceMethod: 'POST' };
    // Deutsche Nummern brauchen den bestätigten Nachweis (Bundle) und eine Adresse aus dem Konto
    const [bundles, adressen] = await Promise.all([
      c.numbers.v2.regulatoryCompliance.bundles.list({ status: 'twilio-approved', isoCountry: 'DE', numberType: 'local', limit: 1 }).catch(() => []),
      c.addresses.list({ isoCountry: 'DE', limit: 1 }).catch(() => []),
    ]);
    if (bundles[0]) opts.bundleSid = bundles[0].sid;
    if (adressen[0]) opts.addressSid = adressen[0].sid;
    const n = await c.incomingPhoneNumbers.create(opts);
    if (req.body.userId) await zuteilen(req, n.sid, n.phoneNumber, parseInt(req.body.userId));
    await log(req.user.id, 'phone_number_buy', 'user', req.body.userId || null, { number: n.phoneNumber }, req.ip);
    res.json({ ok: true, sid: n.sid, number: n.phoneNumber });
  } catch (e) {
    console.error('Voice numbers buy error:', e.message);
    res.status(400).json({ error: twilioFehler(e) });
  }
});

// PUT /api/voice/numbers/:sid { userId | null } — Nummer zuteilen oder freigeben
router.put('/numbers/:sid', auth, adminOnly, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  try {
    const n = await client().incomingPhoneNumbers(req.params.sid).fetch();
    await zuteilen(req, n.sid, n.phoneNumber, req.body.userId ? parseInt(req.body.userId) : null);
    await log(req.user.id, 'phone_number_assign', 'user', req.body.userId || null, { number: n.phoneNumber }, req.ip);
    res.json({ ok: true, number: n.phoneNumber });
  } catch (e) {
    console.error('Voice numbers assign error:', e.message);
    res.status(e.message === 'Benutzer nicht gefunden' ? 404 : 400).json({ error: twilioFehler(e) });
  }
});

// ── Einrichtung im CRM (Admin): Twilio verbinden ─────────────
// Der Admin gibt nur Account SID und Auth Token ein; API-Key und TwiML-App legt
// das CRM selbst im Twilio-Konto an.
router.get('/setup', auth, adminOnly, async (req, res) => {
  const e = env();
  const out = { verbunden: isConfigured(), ausEnv: e.ausEnv, accountSid: e.accountSid ? e.accountSid.slice(0, 6) + '…' + e.accountSid.slice(-4) : null,
    firmennummer: e.companyCallerId || null, webhook: `${baseUrl(req)}/api/voice/incoming`, paketFehlt: !twilio };
  if (out.verbunden) {
    try {
      const acc = await client().api.v2010.accounts(e.accountSid).fetch();
      out.konto = { name: acc.friendlyName, status: acc.status, typ: acc.type };
      out.nummern = (await client().incomingPhoneNumbers.list({ limit: 200 })).length;
    } catch (err) { out.fehler = err.message; }
  }
  res.json(out);
});

router.post('/setup', auth, adminOnly, async (req, res) => {
  if (!twilio) return res.status(503).json({ error: 'Das Twilio-Paket ist auf dem Server nicht installiert.' });
  if (env().ausEnv) return res.status(409).json({ error: 'Die Zugangsdaten stehen in der .env-Datei des Servers und werden dort verwaltet.' });
  const accountSid = String(req.body.accountSid || '').trim();
  const authToken = String(req.body.authToken || '').trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) return res.status(400).json({ error: 'Die Account SID beginnt mit „AC“ und hat 34 Zeichen.' });
  if (authToken.length < 20) return res.status(400).json({ error: 'Bitte den Auth Token aus der Twilio-Konsole einfügen.' });
  try {
    const c = twilio(accountSid, authToken);
    const acc = await c.api.v2010.accounts(accountSid).fetch();   // prüft die Zugangsdaten
    const key = await c.newKeys.create({ friendlyName: 'NovaFlow CRM' });
    const voiceUrl = `${baseUrl(req)}/api/voice/twiml`;
    const apps = await c.applications.list({ friendlyName: 'NovaFlow CRM', limit: 1 });
    const app = apps[0]
      ? await c.applications(apps[0].sid).update({ voiceUrl, voiceMethod: 'POST' })
      : await c.applications.create({ friendlyName: 'NovaFlow CRM', voiceUrl, voiceMethod: 'POST' });
    const callerId = toE164(req.body.callerId) || gespeichert.callerId || null;
    const config = { accountSid, authToken, apiKey: key.sid, apiSecret: key.secret, appSid: app.sid, callerId };
    await db.query('INSERT INTO integrations (name, config, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE config=VALUES(config), updated_by=VALUES(updated_by)',
      ['twilio', JSON.stringify(config), req.user.id]);
    gespeichert = config;
    await log(req.user.id, 'twilio_connect', 'system', null, { konto: acc.friendlyName }, req.ip);
    res.json({ ok: true, konto: acc.friendlyName });
  } catch (err) {
    console.error('Twilio setup error:', err.message);
    res.status(400).json({ error: /authenticate|20003/i.test(err.message) ? 'Account SID oder Auth Token stimmen nicht.' : err.message });
  }
});

// Firmennummer (für Mitarbeiter ohne eigene Nummer und als Absender der Firma)
router.put('/setup/firmennummer', auth, adminOnly, async (req, res) => {
  if (env().ausEnv) return res.status(409).json({ error: 'Die Firmennummer steht in der .env-Datei (TWILIO_CALLER_ID).' });
  gespeichert = { ...gespeichert, callerId: toE164(req.body.number) || null };
  await db.query('UPDATE integrations SET config=? WHERE name=?', [JSON.stringify(gespeichert), 'twilio']);
  res.json({ ok: true, firmennummer: gespeichert.callerId });
});

router.delete('/setup', auth, adminOnly, async (req, res) => {
  if (env().ausEnv) return res.status(409).json({ error: 'Die Zugangsdaten stehen in der .env-Datei des Servers.' });
  await db.query("DELETE FROM integrations WHERE name='twilio'");
  gespeichert = {};
  await log(req.user.id, 'twilio_disconnect', 'system', null, null, req.ip);
  res.json({ ok: true });
});

// Nummer von Hand eintragen: muss zum Twilio-Konto gehören (oder dort als Absender bestätigt sein)
router.put('/numbers-manual', auth, adminOnly, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Telefonie ist nicht eingerichtet' });
  const number = toE164(req.body.number);
  const userId = parseInt(req.body.userId);
  if (!number) return res.status(400).json({ error: 'Bitte eine gültige Nummer eingeben, z. B. +49 30 1234567' });
  try {
    const [eigen] = await client().incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
    if (eigen) {
      await zuteilen(req, eigen.sid, eigen.phoneNumber, userId);
    } else {
      const [bestaetigt] = await client().outgoingCallerIds.list({ phoneNumber: number, limit: 1 });
      if (!bestaetigt) return res.status(400).json({ error: 'Diese Nummer gehört nicht zu deinem Twilio-Konto. Kauf sie dort oder bestätige sie als Absender.' });
      // Bestätigte Fremdnummer: wird als Absender angezeigt, eingehende Anrufe laufen aber nicht über Twilio
      await db.query('UPDATE users SET phone_line=NULL, phone_line_sid=NULL WHERE phone_line=?', [number]);
      await db.query('UPDATE users SET phone_line=?, phone_line_sid=NULL WHERE id=?', [number, userId]);
    }
    await log(req.user.id, 'phone_number_manual', 'user', userId, { number }, req.ip);
    res.json({ ok: true, number, eingehend: !!eigen });
  } catch (err) {
    res.status(400).json({ error: twilioFehler(err) });
  }
});

module.exports = router;
module.exports.isConfigured = isConfigured;
module.exports.ladeKonfiguration = ladeKonfiguration;
