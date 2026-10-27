// ── Telefonie über sipgate ──────────────────────────────────────────────────
// Alternative zu Twilio mit deutschen Nummern ohne Extra-Prüfung.
// Ablauf eines Anrufs („Click-to-Dial“):
//  1. CRM: POST /api/sipgate/anrufen → call_logs-Eintrag + sipgate API /sessions/calls
//  2. sipgate klingelt zuerst beim Vertriebler (sipgate App / Web-Telefon / Tischtelefon),
//     nimmt er ab, ruft sipgate den Kunden mit der hinterlegten Nummer an
//  3. sipgate meldet Beginn, Annahme und Ende an /api/sipgate/webhook → Dauer und
//     Ergebnis landen im call_logs-Eintrag. Eingehende Anrufe werden genauso erfasst
//     (unbekannte Nummer → neuer Lead „Anrufer +49 …“, verpasst → Rückruf-Aufgabe).
// Zugangsdaten: Personal Access Token (Token-ID + Token) in der Tabelle integrations.
const router  = require('express').Router();
const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { toE164 } = require('../helpers/phone');
const { findLeadByPhone, refreshNorm } = require('../helpers/dedupe');
const sicht = require('../helpers/sichtbarkeit');

const API = process.env.SIPGATE_API_URL || 'https://api.sipgate.com/v2';   // abweichend nur für Tests
const WEBHOOK_PFAD = '/api/sipgate/webhook';

let cfg = {};
async function ladeKonfiguration() {
  try {
    const [[row]] = await db.query("SELECT config FROM integrations WHERE name='sipgate'");
    cfg = row ? JSON.parse(row.config) : {};
  } catch (_) { cfg = {}; }
}
const istAktiv = () => !!(cfg.tokenId && cfg.token);
// sipgate-Nummern: normal wie E.164, Testnummern mit Durchwahl sind aber länger
// (z. B. 0211 87973989756) – die nehmen wir trotzdem an
function sgNummer(v) {
  if (!v) return null;
  const e = toE164(v);
  if (e) return e;
  let d = String(v).replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  else if (d.startsWith('0')) d = '+49' + d.slice(1);
  else if (!d.startsWith('+')) d = '+' + d;
  return /^\+[1-9]\d{6,17}$/.test(d) ? d : null;
}

// Testrufnummern von sipgate haben eine angehängte Durchwahl (z. B. 0211 87973989756)
// und laufen nach einiger Zeit ab – normale deutsche Nummern sind kürzer
function istTestnummer(v) {
  const d = String(v || '').replace(/\D/g, '').replace(/^49/, '0').replace(/^(?!0)/, '0');
  return d.length > 13;
}

function fehlertext(status, text) {
  if (status === 401) return 'sipgate lehnt die Anmeldung ab – Token-ID und Token prüfen.';
  if (status === 403) return 'Dem sipgate-Token fehlen Rechte. Beim Erstellen alle Bereiche (Scopes) anhaken, mindestens Anrufe, Benutzer, Geräte, Nummern, Anrufliste und Webhooks.';
  if (status === 402) return 'sipgate: Für diese Funktion fehlt Guthaben oder der passende Tarif.';
  let msg = '';
  try { msg = JSON.parse(text).message || ''; } catch (_) { msg = String(text || '').slice(0, 200); }
  return `sipgate meldet einen Fehler (${status})${msg ? ': ' + msg : ''}`;
}

async function sg(method, path, body, zugang = cfg) {
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${zugang.tokenId}:${zugang.token}`).toString('base64'),
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(API + '/' + path.replace(/^\//, ''), {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { throw new Error('sipgate ist gerade nicht erreichbar: ' + (e.message || e)); }
  const text = await r.text();
  if (!r.ok) { const e = new Error(fehlertext(r.status, text)); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function speichern(neu, userId) {
  cfg = neu;
  await db.query(
    `INSERT INTO integrations (name, config, updated_by) VALUES ('sipgate', ?, ?)
     ON DUPLICATE KEY UPDATE config=VALUES(config), updated_by=VALUES(updated_by)`,
    [JSON.stringify(neu), userId]);
}

// sipgate meldet Anrufe nur an eine Adresse je Richtung. Unsere setzen wir nur,
// wenn dort noch nichts (oder schon unsere) eingetragen ist – sonst Hinweis.
async function webhooksEinrichten(url, ersetzen = false) {
  const s = await sg('GET', 'settings/sipgateio');
  const frei = v => ersetzen || !v || v === url;
  const ergebnis = { incoming: frei(s.incomingUrl), outgoing: frei(s.outgoingUrl), vorher: { incoming: s.incomingUrl || '', outgoing: s.outgoingUrl || '' } };
  const neu = { ...s, incomingUrl: ergebnis.incoming ? url : s.incomingUrl, outgoingUrl: ergebnis.outgoing ? url : s.outgoingUrl };
  if (neu.incomingUrl !== s.incomingUrl || neu.outgoingUrl !== s.outgoingUrl) await sg('PUT', 'settings/sipgateio', neu);
  return ergebnis;
}

async function sipgateBenutzer() {
  const r = await sg('GET', 'users');
  return (r && r.items) || [];
}
async function geraeteVon(userId) {
  try { return (await sg('GET', `${userId}/devices`)) || []; } catch (_) { return []; }
}
async function nummern() {
  try { const r = await sg('GET', 'numbers'); return (r && r.items) || []; } catch (_) { return []; }
}

// ── Admin: Status, Verbinden, Trennen ──────────────────────────
router.get('/setup', auth, adminOnly, async (req, res) => {
  const webhookUrl = baseUrl(req) + WEBHOOK_PFAD;
  if (!istAktiv()) return res.json({ verbunden: false, webhookUrl });
  try {
    const [info, users, nrn, hooks] = await Promise.all([
      sg('GET', 'authorization/userinfo').catch(() => null),
      sipgateBenutzer(),
      nummern(),
      sg('GET', 'settings/sipgateio').catch(() => null),
    ]);
    const mitGeraeten = await Promise.all(users.map(async u => ({
      id: u.id, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email || u.id, email: u.email || '',
      defaultDevice: u.defaultDevice || null,
      geraete: (await geraeteVon(u.id)).map(d => ({ id: d.id, alias: d.alias, typ: d.type, online: !!d.online })),
    })));
    const [crm] = await db.query(
      `SELECT id, full_name, role, sipgate_user, sipgate_device, sipgate_nummer FROM users
       WHERE is_active=1 ORDER BY role='admin' DESC, full_name`);
    res.json({
      verbunden: true, webhookUrl, firmennummer: cfg.firmennummer || null,
      konto: info ? { domain: info.domain, id: info.masterSipId } : null,
      benutzer: mitGeraeten,
      nummern: nrn.filter(n => n.type !== 'QUICKDIAL').map(n => ({ nummer: sgNummer(n.number) || n.number, anzeige: n.localized || n.number, typ: n.type, ziel: n.endpointAlias || '', test: istTestnummer(n.number) })),
      webhook: hooks ? { eingehend: hooks.incomingUrl === webhookUrl, ausgehend: hooks.outgoingUrl === webhookUrl, incomingUrl: hooks.incomingUrl || '', outgoingUrl: hooks.outgoingUrl || '' } : null,
      zuordnung: crm,
    });
  } catch (e) { res.json({ verbunden: true, webhookUrl, fehler: e.message, zuordnung: [] }); }
});

router.post('/setup', auth, adminOnly, async (req, res) => {
  const tokenId = String(req.body.tokenId || '').trim();
  const token = String(req.body.token || '').trim();
  if (!/^token-[A-Za-z0-9]{6}$/.test(tokenId)) return res.status(400).json({ error: 'Die Token-ID sieht aus wie „token-ABC123“.' });
  if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(400).json({ error: 'Der Token ist eine lange Kombination aus Zahlen, Buchstaben und Bindestrichen – bitte komplett einfügen.' });
  const zugang = { tokenId, token };
  try {
    await sg('GET', 'authorization/userinfo', undefined, zugang);
    const users = await sg('GET', 'users', undefined, zugang).then(r => (r && r.items) || []);
    const nrn = await sg('GET', 'numbers', undefined, zugang).then(r => (r && r.items) || []).catch(() => []);
    // Feste Nummer bevorzugen – Testnummern laufen ab
    const festnetz = nrn.find(n => n.type === 'LANDLINE' && !istTestnummer(n.number)) || nrn.find(n => n.type === 'LANDLINE');
    await speichern({ ...cfg, tokenId, token, firmennummer: cfg.firmennummer || (festnetz ? sgNummer(festnetz.number) : null) }, req.user.id);

    // Benutzer automatisch zuordnen (gleiche E-Mail), der Admin bekommt sonst den Hauptzugang
    const [crm] = await db.query('SELECT id, email, role, sipgate_user FROM users WHERE is_active=1');
    for (const u of crm) {
      if (u.sipgate_user) continue;
      const treffer = users.find(s => s.email && u.email && s.email.toLowerCase() === u.email.toLowerCase())
        || (u.role === 'admin' && users.length === 1 ? users[0] : null);
      if (treffer) await db.query('UPDATE users SET sipgate_user=?, sipgate_device=? WHERE id=?', [treffer.id, treffer.defaultDevice || null, u.id]);
    }
    let webhook = null, hinweis = null;
    try {
      webhook = await webhooksEinrichten(baseUrl(req) + WEBHOOK_PFAD);
      if (!webhook.incoming || !webhook.outgoing) hinweis = 'In sipgate ist für Anrufmeldungen schon eine andere Adresse eingetragen. Damit das CRM Anrufe automatisch erfasst, unter sipgate → Webhooks die CRM-Adresse eintragen.';
    } catch (e) { hinweis = 'Anrufmeldungen konnten nicht eingerichtet werden: ' + e.message; }
    await log(req.user.id, 'sipgate_verbunden', null, null, { tokenId }, req.ip);
    res.json({ ok: true, hinweis });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/setup', auth, adminOnly, async (req, res) => {
  try {
    if (istAktiv()) {
      const url = baseUrl(req) + WEBHOOK_PFAD;
      try {
        const s = await sg('GET', 'settings/sipgateio');
        if (s.incomingUrl === url || s.outgoingUrl === url) {
          await sg('PUT', 'settings/sipgateio', { ...s, incomingUrl: s.incomingUrl === url ? '' : s.incomingUrl, outgoingUrl: s.outgoingUrl === url ? '' : s.outgoingUrl });
        }
      } catch (_) { /* Trennen soll trotzdem klappen */ }
    }
    cfg = {};
    await db.query("DELETE FROM integrations WHERE name='sipgate'");
    await log(req.user.id, 'sipgate_getrennt', null, null, {}, req.ip);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/firmennummer', auth, adminOnly, async (req, res) => {
  const nr = req.body.nummer ? sgNummer(req.body.nummer) : null;
  if (req.body.nummer && !nr) return res.status(400).json({ error: 'Ungültige Nummer' });
  await speichern({ ...cfg, firmennummer: nr }, req.user.id);
  res.json({ ok: true, firmennummer: nr });
});

router.post('/webhooks', auth, adminOnly, async (req, res) => {
  try { res.json({ ok: true, ...(await webhooksEinrichten(baseUrl(req) + WEBHOOK_PFAD, !!req.body.ersetzen)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Welcher CRM-Benutzer telefoniert über welchen sipgate-Zugang, welches Gerät, welche Nummer
router.put('/zuordnung/:userId', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.userId);
  const kurz = (v, re) => (v && re.test(String(v)) ? String(v) : null);
  const sUser = kurz(req.body.sipgate_user, /^w\d+$/);
  const geraet = kurz(req.body.sipgate_device, /^[a-z]\d+$/);
  const nummer = req.body.sipgate_nummer ? sgNummer(req.body.sipgate_nummer) : null;
  if (req.body.sipgate_nummer && !nummer) return res.status(400).json({ error: 'Ungültige Nummer' });
  const [r] = await db.query('UPDATE users SET sipgate_user=?, sipgate_device=?, sipgate_nummer=? WHERE id=?', [sUser, geraet, nummer, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  await log(req.user.id, 'sipgate_zuordnung', 'user', id, { sUser, geraet, nummer }, req.ip);
  res.json({ ok: true });
});

// Kurzinfo für den Benutzer-Dialog (ohne Abfrage bei sipgate)
router.get('/benutzer/:userId', auth, adminOnly, async (req, res) => {
  if (!istAktiv()) return res.json({ aktiv: false });
  const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer FROM users WHERE id=?', [parseInt(req.params.userId)]);
  const nummer = (u && u.sipgate_nummer) || cfg.firmennummer || null;
  res.json({ aktiv: true, zugang: (u && u.sipgate_user) || null, geraet: (u && u.sipgate_device) || null,
    nummer, eigeneNummer: !!(u && u.sipgate_nummer), testnummer: istTestnummer(nummer) });
});

// ── Für alle: kann ich über sipgate anrufen? ────────────────────
router.get('/config', auth, async (req, res) => {
  if (!istAktiv()) return res.json({ aktiv: false });
  const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer FROM users WHERE id=?', [req.user.id]);
  res.json({
    aktiv: true,
    bereit: !!(u && (u.sipgate_device || u.sipgate_user)),
    nummer: (u && u.sipgate_nummer) || cfg.firmennummer || null,
  });
});

// ── Anruf starten (Click-to-Dial) ───────────────────────────────
router.post('/anrufen', auth, async (req, res) => {
  if (!istAktiv()) return res.status(503).json({ error: 'sipgate ist nicht verbunden' });
  const leadId = parseInt(req.body.leadId);
  try {
    const [[lead]] = await db.query('SELECT id, company, phone, assigned_to, status FROM leads WHERE id=? AND archived_at IS NULL', [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (lead.status === 'keine_anrufe') return res.status(409).json({ error: 'Bei diesem Lead gilt „Keine Anrufe mehr“ – Anrufen ist gesperrt.' });
    if (!sicht.darfSehen(req.user, lead)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });
    const ziel = toE164(lead.phone);
    if (!ziel) return res.status(400).json({ error: 'Die Telefonnummer des Leads ist ungültig' });
    const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer FROM users WHERE id=?', [req.user.id]);
    let geraet = u && u.sipgate_device;
    if (!geraet && u && u.sipgate_user) {
      const su = (await sipgateBenutzer()).find(x => x.id === u.sipgate_user);
      geraet = su && su.defaultDevice;
    }
    if (!geraet) return res.status(400).json({ error: 'Dir ist noch kein sipgate-Telefon zugeordnet. Ein Admin kann das unter Integrationen → sipgate erledigen.' });

    const [c] = await db.query(
      `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status)
       VALUES (?, ?, ?, 'outbound', NOW(), 'started')`, [lead.id, req.user.id, lead.phone]);
    const absender = (u && u.sipgate_nummer) || cfg.firmennummer || undefined;
    try {
      await sg('POST', 'sessions/calls', { caller: geraet, deviceId: geraet, callee: ziel, ...(absender ? { callerId: absender } : {}) });
    } catch (e) {
      await db.query("UPDATE call_logs SET status='failed', ended_at=NOW() WHERE id=?", [c.insertId]);
      throw e;
    }
    await log(req.user.id, 'call_started', 'lead', lead.id, { phone: lead.phone, via: 'sipgate' }, req.ip);
    res.status(201).json({ ok: true, id: c.insertId, absender: absender || null });
  } catch (e) {
    console.error('sipgate anrufen:', e.message);
    res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message });
  }
});

// ── Anrufmeldungen von sipgate (Push-API) ───────────────────────
// Öffentlicher Schlüssel von sipgate zum Prüfen der Signatur (aus der offiziellen sipgateio-Bibliothek)
const SIPGATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAvFdlnqRfO5TmqzjtsFVC
qPz+oW+poi3lXQFvMJJMEAtlU4MbX+yuIkgnC+Qt3AQWIK+oWSEQiybg+p39wEMl
16PZxEzf9gONQvTg1XhyHnwqYUFQj/AoxPKGYC3jmdjZ224SrESiTN3CdxoOc3vk
cXiQstYE7SxnksPtzfk0aIOkicim5/tAP9izNQ18/zmX3ChjK2k72gf5dDlq+qZ8
pRiHAPZ64TySH6cLQDhaoh6Nbq8FEG3usXXPClbUMh2DZaTMPafpd+LNuTngJ/y+
KoZasVuFfXAeBqGA6l5d4Uedfr99Z6qjwDrJ8sU4z2Do9bJrbuqP+mOXEebhSI1K
vi8trEfrIt8hnDBGsBaB9NEO3kYxvDT2/PhC9fNYFocjEpZNd7/mUqTJDYlpa4UC
NDQaU+ATdXG8/P5sGAegks6MQTu+qe9XTO0CV48eswDkz6g3UbLOwmrJK59SjD3J
yAZ52sluwyDKRWw/PPTt8BTQLjvkdbiLUlc4ehJ4b1X7D7diYWHDPeFL47cAvaXh
dXVrZDeBJYibvD1jRx4ES0KlfhwzNXBYUoM/Movg9zMM2PzyHHKS//xIjwUC/FJ6
/6eykno0Hy2B1ev6s3hdY6VkN2zd7Wf+EK4DxRliwsg1U99szFE3ewLfexF+Uag5
M+TfPtOUumI/NHMTvsRW9+ECAwEAAQ==
-----END PUBLIC KEY-----`;
function signaturOk(req) {
  if (process.env.SIPGATE_WEBHOOK_OHNE_SIGNATUR === '1') return true;   // nur für lokale Tests
  const sig = req.headers['x-sipgate-signature'];
  if (!sig || !Buffer.isBuffer(req.body)) return false;
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(req.body);
    return v.verify(SIPGATE_PUBLIC_KEY, Buffer.from(String(sig), 'base64'));
  } catch (_) { return false; }
}

const xml = (attrs = '') => `<?xml version="1.0" encoding="UTF-8"?><Response${attrs}/>`;
const plus = v => (v && v !== 'anonymous' ? sgNummer('+' + String(v).replace(/^\+/, '')) : null);
const HANGUP_STATUS = { busy: 'busy', noAnswer: 'no-answer', cancel: 'no-answer', congestion: 'failed', notFound: 'failed' };

async function crmBenutzerZu(sipgateIds) {
  const ids = (sipgateIds || []).filter(x => /^w\d+$/.test(x));
  if (!ids.length) return null;
  const [rows] = await db.query('SELECT id FROM users WHERE is_active=1 AND sipgate_user IN (?)', [ids]);
  return rows.length ? rows[0].id : null;
}
async function firstAdminId() {
  const [[a]] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1");
  return a ? a.id : null;
}

router.post('/webhook', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  res.type('application/xml');
  if (!signaturOk(req)) { res.status(403); return res.send('<?xml version="1.0" encoding="UTF-8"?><Error message="invalid signature"/>'); }
  const p = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  const event = p.get('event');
  const callId = p.get('callId');
  try {
    if (event === 'newCall' && callId) {
      const url = baseUrl(req) + WEBHOOK_PFAD;
      const userIds = [...p.getAll('userId[]'), ...p.getAll('userId')];
      const raus = p.get('direction') === 'out';
      const kunde = raus ? plus(p.get('to')) : plus(p.get('from'));
      const unsere = raus ? plus(p.get('from')) : plus(p.get('to'));
      const crmUser = await crmBenutzerZu(userIds);
      if (raus) {
        // Vom CRM gestarteter Anruf: passenden „started“-Eintrag der letzten Minuten übernehmen
        let zugeordnet = false;
        if (crmUser && kunde) {
          const [kand] = await db.query(
            `SELECT id, phone_number FROM call_logs WHERE user_id=? AND direction='outbound' AND sipgate_call_id IS NULL
               AND started_at > NOW() - INTERVAL 5 MINUTE ORDER BY id DESC LIMIT 10`, [crmUser]);
          const k = kand.find(x => toE164(x.phone_number) === kunde);
          if (k) { await db.query('UPDATE call_logs SET sipgate_call_id=? WHERE id=?', [callId, k.id]); zugeordnet = true; }
        }
        // Direkt in der sipgate App gewählt: trotzdem beim Lead erfassen
        if (!zugeordnet && crmUser && kunde) {
          const lead = await findLeadByPhone(kunde);
          if (lead) {
            await db.query(
              `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status, sipgate_call_id)
               VALUES (?, ?, ?, 'outbound', NOW(), 'started', ?)`, [lead.id, crmUser, kunde, callId]);
          }
        }
      } else if (kunde) {
        const [[inhaber]] = unsere ? await db.query('SELECT id FROM users WHERE sipgate_nummer=? AND is_active=1 LIMIT 1', [unsere]) : [[null]];
        let lead = await findLeadByPhone(kunde);
        if (!lead) {
          const von = inhaber ? inhaber.id : await firstAdminId();
          const [r] = await db.query(
            `INSERT INTO leads (company, phone, status, created_by, assigned_to, source, confidence)
             VALUES (?, ?, 'neu', ?, ?, 'eingehender-anruf', 50)`, [`Anrufer ${kunde}`, kunde, von, inhaber ? inhaber.id : null]);
          await refreshNorm(r.insertId);
          lead = { id: r.insertId, assigned_to: inhaber ? inhaber.id : null };
        }
        const userId = (inhaber && inhaber.id) || lead.assigned_to || crmUser || await firstAdminId();
        if (userId) {
          await db.query(
            `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status, sipgate_call_id)
             VALUES (?, ?, ?, 'inbound', NOW(), 'started', ?)`, [lead.id, userId, kunde, callId]);
        }
      }
      return res.send(xml(` onAnswer="${url}" onHangup="${url}"`));
    }

    if (event === 'answer' && callId) {
      const crmUser = await crmBenutzerZu([p.get('userId')]);
      const [[c]] = await db.query('SELECT id, lead_id, direction FROM call_logs WHERE sipgate_call_id=? ORDER BY id DESC LIMIT 1', [callId]);
      if (c) {
        await db.query(
          `UPDATE call_logs SET answered_at=COALESCE(answered_at, NOW()), status=IF(status='started','reached',status)
           ${c.direction === 'inbound' && crmUser ? ', user_id=?' : ''} WHERE id=?`,
          c.direction === 'inbound' && crmUser ? [crmUser, c.id] : [c.id]);
        // Freier Lead: wer den eingehenden Anruf annimmt, betreut ihn
        if (c.direction === 'inbound' && crmUser) await db.query('UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL', [crmUser, c.lead_id]);
      }
      return res.send(xml());
    }

    if (event === 'hangup' && callId) {
      const [[c]] = await db.query(
        `SELECT c.*, l.company FROM call_logs c JOIN leads l ON l.id=c.lead_id WHERE c.sipgate_call_id=? ORDER BY c.id DESC LIMIT 1`, [callId]);
      if (c) {
        const cause = p.get('cause');
        const angenommen = !!c.answered_at || (cause === 'normalClearing' && c.status === 'reached');
        const neu = angenommen ? 'reached' : (HANGUP_STATUS[cause] || 'no-answer');
        await db.query(
          `UPDATE call_logs SET status=IF(status='started', ?, status), ended_at=COALESCE(ended_at, NOW()),
             duration_seconds=COALESCE(duration_seconds, IF(answered_at IS NULL, 0, TIMESTAMPDIFF(SECOND, answered_at, NOW())))
           WHERE id=?`, [neu, c.id]);
        if (c.direction === 'inbound' && !angenommen && cause !== 'forwarded') {
          await db.query(
            `INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent) VALUES (?, ?, NOW(), ?, 'missed_call', 1)`,
            [c.lead_id, c.user_id, `Verpasster Anruf von ${c.phone_number}`]);
          await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
            [c.lead_id, c.user_id, `📞 Verpasster Anruf von ${c.phone_number}`]);
        }
      }
      return res.send(xml());
    }
    res.send(xml());
  } catch (e) {
    console.error('sipgate webhook:', e.message);
    res.send(xml());   // sipgate soll den Anruf nie wegen eines CRM-Fehlers abbrechen
  }
});

// Zustand für den Startklar-Check
async function status() {
  if (!istAktiv()) return { verbunden: false };
  const st = { verbunden: true, firmennummer: cfg.firmennummer || null };
  try {
    const [nrn, hooks] = await Promise.all([nummern(), sg('GET', 'settings/sipgateio').catch(() => null)]);
    st.nummern = nrn.filter(n => n.type === 'LANDLINE' || n.type === 'MOBILE').length;
    st.webhook = !!(hooks && hooks.incomingUrl && hooks.incomingUrl.endsWith(WEBHOOK_PFAD) && hooks.outgoingUrl && hooks.outgoingUrl.endsWith(WEBHOOK_PFAD));
  } catch (e) { st.fehler = e.message; }
  return st;
}

module.exports = router;
module.exports.ladeKonfiguration = ladeKonfiguration;
module.exports.istAktiv = istAktiv;
module.exports.status = status;
// Nummer, unter der ein Benutzer nach außen anruft (eigene sipgate-Nummer, sonst Firmennummer)
module.exports.nummerFuer = async userId => {
  if (!istAktiv()) return null;
  const [[u]] = await db.query('SELECT sipgate_nummer FROM users WHERE id=?', [userId]);
  return (u && u.sipgate_nummer) || cfg.firmennummer || null;
};
