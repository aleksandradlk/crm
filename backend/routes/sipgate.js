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
  return Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : []);
}
async function geraeteVon(userId) {
  // sipgate liefert { items: [...] } – ältere Antworten waren eine reine Liste
  try { const r = await sg('GET', `${userId}/devices`); return Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : []); } catch (_) { return []; }
}
async function nummern() {
  try { const r = await sg('GET', 'numbers'); return Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : []); } catch (_) { return []; }
}

// ── Nummern-Pool ──────────────────────────────────────────────
// Alle Nummern aus sipgate plus eigene Angaben (Bezeichnung, gültig bis, Notiz) aus
// der Tabelle telefonnummern. Wer welche Nummer nutzt, steht in users.sipgate_nummer.
const WARN_TAGE = 14;
const isoTag = (plus = 0) => { const d = new Date(); d.setDate(d.getDate() + plus); return d.toISOString().slice(0, 10); };
const national = v => String(v || '').replace(/^\+49/, '0');

// Einmalig: Die Testnummern des aktuellen sipgate-Testzugangs sind laut sipgate „Nutzbar bis 20.11.2026“.
// Fehlt bei einer Testnummer das Datum, wird es einmal eingetragen (danach gilt, was im Pool steht).
const TEST_BIS = '2026-11-20';
async function testDatumEinmalig(sgNrn) {
  if (!sgNrn || !sgNrn.length || isoTag() > TEST_BIS) return;
  const [[schon]] = await db.query("SELECT 1 AS x FROM app_settings WHERE key_name='sipgate_testnummern_bis'").catch(() => [[{ x: 1 }]]);
  if (schon) return;
  for (const n of sgNrn.filter(x => istTestnummer(x.number))) {
    const nr = sgNummer(n.number);
    if (nr) await db.query(
      `INSERT INTO telefonnummern (nummer, gueltig_bis) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE gueltig_bis=COALESCE(gueltig_bis, VALUES(gueltig_bis))`, [nr, TEST_BIS]);
  }
  await db.query("INSERT INTO app_settings (key_name, value) VALUES ('sipgate_testnummern_bis', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [TEST_BIS]);
}

async function pool(sgNrn) {
  await testDatumEinmalig(sgNrn).catch(e => console.error('sipgate Testnummern-Datum:', e.message));
  const [meta] = await db.query("SELECT nummer, bezeichnung, DATE_FORMAT(gueltig_bis, '%Y-%m-%d') AS gueltig_bis, notiz, manuell FROM telefonnummern").catch(() => [[]]);
  const [users] = await db.query('SELECT id, full_name, role, sipgate_user, sipgate_nummer FROM users WHERE is_active=1');
  const map = new Map();
  const dazu = (nr, x = {}) => { if (nr) map.set(nr, { nummer: nr, in_sipgate: sgNrn ? false : null, ...(map.get(nr) || {}), ...x }); };
  (sgNrn || []).filter(n => n.type !== 'QUICKDIAL')
    .forEach(n => dazu(sgNummer(n.number) || n.number, { anzeige: n.localized || null, typ: n.type, in_sipgate: true }));
  meta.forEach(m => dazu(m.nummer, { bezeichnung: m.bezeichnung, gueltig_bis: m.gueltig_bis, notiz: m.notiz, manuell: !!m.manuell }));
  users.forEach(u => dazu(u.sipgate_nummer));
  dazu(cfg.firmennummer);
  const heute = isoTag(), bald = isoTag(WARN_TAGE);
  return [...map.values()].map(n => {
    const an = users.filter(u => u.sipgate_nummer === n.nummer).map(u => ({ id: u.id, name: u.full_name }));
    const g = n.gueltig_bis || null;
    const test = istTestnummer(n.nummer);
    const status = g && g < heute ? 'abgelaufen' : g && g <= bald ? 'laeuft_ab' : n.in_sipgate === false ? 'fehlt' : (an.length || n.nummer === cfg.firmennummer) ? 'vergeben' : 'frei';
    return { nummer: n.nummer, anzeige: n.anzeige || national(n.nummer), typ: n.typ || null, in_sipgate: n.in_sipgate,
      bezeichnung: n.bezeichnung || '', gueltig_bis: g, notiz: n.notiz || '', manuell: !!n.manuell,
      test, ohne_datum: test && !g, firma: n.nummer === cfg.firmennummer, vergeben_an: an, status };
  }).sort((a, b) => (b.firma - a.firma) || a.nummer.localeCompare(b.nummer));
}

// Noch nutzbar? (kein Ablaufdatum oder Ablaufdatum heute oder später)
async function nummerGueltig(nr) {
  if (!nr) return false;
  const [[m]] = await db.query("SELECT DATE_FORMAT(gueltig_bis, '%Y-%m-%d') AS g FROM telefonnummern WHERE nummer=?", [nr]).catch(() => [[null]]);
  return !(m && m.g && m.g < isoTag());
}

async function settingWert(k) {
  const [[r]] = await db.query('SELECT value FROM app_settings WHERE key_name=?', [k]).catch(() => [[null]]);
  return r ? r.value : null;
}
async function webhookZuletzt() {
  const [[r]] = await db.query("SELECT value FROM app_settings WHERE key_name='sipgate_webhook_zuletzt'").catch(() => [[null]]);
  return r ? r.value : null;
}

// Gerät des Hauptzugangs (für Closer ohne eigenen Zugang): Admin-Zuordnung, sonst erster sipgate-Benutzer
async function hauptGeraet() {
  const [[a]] = await db.query("SELECT sipgate_user, sipgate_device FROM users WHERE role='admin' AND is_active=1 AND sipgate_user IS NOT NULL ORDER BY id LIMIT 1");
  if (a && a.sipgate_device) return a.sipgate_device;
  const liste = await sipgateBenutzer().catch(() => []);
  const su = (a && liste.find(x => x.id === a.sipgate_user)) || liste[0];
  return (su && su.defaultDevice) || null;
}

// Nummer, die Kunden bei einem Benutzer sehen (abgelaufene eigene → Firmennummer)
async function aktuelleNummer(userId) {
  const [[u]] = await db.query('SELECT sipgate_nummer FROM users WHERE id=?', [userId]);
  if (u && u.sipgate_nummer && await nummerGueltig(u.sipgate_nummer)) return u.sipgate_nummer;
  return (await nummerGueltig(cfg.firmennummer)) ? cfg.firmennummer : null;
}

// Freie Nummer aus dem Pool: feste Nummern vor Testnummern, länger gültige zuerst
function freieAus(liste, vergeben = new Set()) {
  return liste.filter(n => n.status === 'frei' && n.in_sipgate !== false && !vergeben.has(n.nummer))
    .sort((a, b) => (a.test - b.test) || String(b.gueltig_bis || '9999').localeCompare(String(a.gueltig_bis || '9999')))[0] || null;
}

// Closer mit sipgate-Zugang, aber ohne (oder mit abgelaufener) eigener Nummer bekommen eine freie
async function verteilen(userId = null) {
  const liste = await pool(istAktiv() ? await nummern() : null);
  const ab = new Set(liste.filter(n => n.status === 'abgelaufen').map(n => n.nummer));
  const [kandidaten] = await db.query(
    `SELECT id, full_name, sipgate_nummer FROM users WHERE is_active=1 AND role='closer' AND (sipgate_user IS NOT NULL OR sipgate_handy IS NOT NULL) ${userId ? 'AND id=?' : ''} ORDER BY id`,
    userId ? [userId] : []);
  const vergeben = new Set(), ergebnis = [];
  for (const u of kandidaten) {
    if (u.sipgate_nummer && !ab.has(u.sipgate_nummer)) continue;
    const frei = freieAus(liste, vergeben);
    if (!frei) { ergebnis.push({ id: u.id, name: u.full_name, nummer: null }); continue; }
    vergeben.add(frei.nummer);
    await db.query('UPDATE users SET sipgate_nummer=? WHERE id=?', [frei.nummer, u.id]);
    ergebnis.push({ id: u.id, name: u.full_name, nummer: frei.nummer, anzeige: frei.anzeige });
  }
  return ergebnis;
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
      `SELECT id, full_name, role, sipgate_user, sipgate_device, sipgate_nummer, sipgate_handy FROM users
       WHERE is_active=1 ORDER BY role='admin' DESC, full_name`);
    res.json({
      verbunden: true, webhookUrl, firmennummer: cfg.firmennummer || null,
      konto: info ? { domain: info.domain, id: info.masterSipId } : null,
      benutzer: mitGeraeten,
      nummern: nrn.filter(n => n.type !== 'QUICKDIAL').map(n => ({ nummer: sgNummer(n.number) || n.number, anzeige: n.localized || n.number, typ: n.type, ziel: n.endpointAlias || '', test: istTestnummer(n.number) })),
      webhook: hooks ? { eingehend: hooks.incomingUrl === webhookUrl, ausgehend: hooks.outgoingUrl === webhookUrl, incomingUrl: hooks.incomingUrl || '', outgoingUrl: hooks.outgoingUrl || '' } : null,
      zuordnung: crm,
      pool: await pool(nrn),
      webhook_zuletzt: await webhookZuletzt(),
      webhook_abgelehnt: await settingWert('sipgate_webhook_abgelehnt'),
      system: cfg.system || null,
    });
  } catch (e) {
    console.error('sipgate setup:', e.message);
    // Trotzdem die Zuordnung zeigen, damit nichts leer bleibt
    const [crm] = await db.query(
      `SELECT id, full_name, role, sipgate_user, sipgate_device, sipgate_nummer, sipgate_handy FROM users
       WHERE is_active=1 ORDER BY role='admin' DESC, full_name`).catch(() => [[]]);
    res.json({ verbunden: true, webhookUrl, firmennummer: cfg.firmennummer || null, fehler: e.message, zuordnung: crm,
      benutzer: [], nummern: [], pool: await pool(null).catch(() => []) });
  }
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
    // Feste Nummer bevorzugen (Festnetz vor Handy), Testnummern nur, wenn es nichts anderes gibt
    const nutzbar = nrn.filter(n => n.type !== 'QUICKDIAL');
    const festnetz = nutzbar.find(n => n.type !== 'MOBILE' && !istTestnummer(n.number)) || nutzbar.find(n => !istTestnummer(n.number)) || nutzbar[0];
    await speichern({ ...cfg, tokenId, token, firmennummer: cfg.firmennummer || (festnetz ? sgNummer(festnetz.number) : null) }, req.user.id);

    // Benutzer automatisch zuordnen (gleiche E-Mail), der Admin bekommt sonst den Hauptzugang
    const [crm] = await db.query('SELECT id, email, role, sipgate_user FROM users WHERE is_active=1');
    for (const u of crm) {
      if (u.sipgate_user) continue;
      const treffer = users.find(s => s.email && u.email && s.email.toLowerCase() === u.email.toLowerCase())
        || (u.role === 'admin' && users.length === 1 ? users[0] : null);
      if (treffer) await db.query('UPDATE users SET sipgate_user=?, sipgate_device=? WHERE id=?', [treffer.id, treffer.defaultDevice || null, u.id]);
    }
    await verteilen().catch(e => console.error('sipgate Nummern verteilen:', e.message));
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
  // Ohne eigenen Zugang: Handy, das zuerst klingelt (nur wenn kein sipgate-Zugang gewählt ist)
  const handy = !sUser && req.body.sipgate_handy ? toE164(req.body.sipgate_handy) : null;
  if (!sUser && req.body.sipgate_handy && !handy) return res.status(400).json({ error: 'Die Handynummer sieht ungültig aus, z. B. 0171 1234567.' });
  const [[vorher]] = await db.query('SELECT sipgate_user, sipgate_handy FROM users WHERE id=?', [id]);
  if (!vorher) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  await db.query('UPDATE users SET sipgate_user=?, sipgate_device=?, sipgate_nummer=?, sipgate_handy=? WHERE id=?',
    [sUser, sUser ? geraet : null, sUser || handy ? nummer : null, handy, id]);
  // Neu bei sipgate und noch keine Nummer gewählt: freie Nummer aus dem Pool
  let auto = null;
  const neu = (sUser && !vorher.sipgate_user) || (handy && !vorher.sipgate_handy);
  if (neu && !nummer) auto = (await verteilen(id).catch(() => []))[0] || null;
  await log(req.user.id, 'sipgate_zuordnung', 'user', id, { sUser, geraet, handy: !!handy, nummer: nummer || auto?.nummer || null }, req.ip);
  res.json({ ok: true, nummer: auto?.nummer || nummer || null, automatisch: !!auto?.nummer });
});

// ── Nummern-Pool: ansehen, bearbeiten, eigene Nummern, verteilen ──
router.get('/nummern', auth, adminOnly, async (req, res) => {
  try { res.json({ nummern: await pool(istAktiv() ? await nummern() : null), warn_tage: WARN_TAGE }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
async function nummerSpeichern(req, res, nr, neu) {
  if (!nr) return res.status(400).json({ error: 'Ungültige Nummer' });
  const b = req.body || {};
  const g = b.gueltig_bis ? String(b.gueltig_bis).slice(0, 10) : null;
  if (g && !/^\d{4}-\d{2}-\d{2}$/.test(g)) return res.status(400).json({ error: 'Datum bitte als TT.MM.JJJJ' });
  const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  await db.query(
    `INSERT INTO telefonnummern (nummer, bezeichnung, gueltig_bis, notiz, manuell) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE bezeichnung=VALUES(bezeichnung), gueltig_bis=VALUES(gueltig_bis), notiz=VALUES(notiz), updated_at=NOW()`,
    [nr, txt(b.bezeichnung, 100), g, txt(b.notiz, 255), neu ? 1 : 0]);
  await log(req.user.id, neu ? 'sipgate_nummer_neu' : 'sipgate_nummer_bearbeitet', null, null, { nummer: nr, gueltig_bis: g }, req.ip);
  res.json({ ok: true, nummer: nr });
}
router.post('/nummern', auth, adminOnly, (req, res) => nummerSpeichern(req, res, sgNummer(req.body.nummer), true));
router.put('/nummern/:nummer', auth, adminOnly, (req, res) => nummerSpeichern(req, res, sgNummer(req.params.nummer), false));
router.delete('/nummern/:nummer', auth, adminOnly, async (req, res) => {
  const nr = sgNummer(req.params.nummer);
  if (!nr) return res.status(400).json({ error: 'Ungültige Nummer' });
  // Wer sie nutzt, telefoniert danach mit der Firmennummer
  const [r] = await db.query('UPDATE users SET sipgate_nummer=NULL WHERE sipgate_nummer=?', [nr]);
  await db.query('DELETE FROM telefonnummern WHERE nummer=?', [nr]);
  await log(req.user.id, 'sipgate_nummer_entfernt', null, null, { nummer: nr, freigegeben: r.affectedRows }, req.ip);
  res.json({ ok: true, freigegeben: r.affectedRows });
});
router.post('/nummern/verteilen', auth, adminOnly, async (req, res) => {
  try {
    const erg = await verteilen();
    await log(req.user.id, 'sipgate_nummern_verteilt', null, null, { anzahl: erg.filter(e => e.nummer).length }, req.ip);
    res.json({ ok: true, verteilt: erg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kurzinfo für den Benutzer-Dialog (ohne Abfrage bei sipgate)
router.get('/benutzer/:userId', auth, adminOnly, async (req, res) => {
  if (!istAktiv()) return res.json({ aktiv: false });
  const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer, sipgate_handy FROM users WHERE id=?', [parseInt(req.params.userId)]);
  const nummer = await aktuelleNummer(parseInt(req.params.userId));
  const eigene = !!(u && u.sipgate_nummer && u.sipgate_nummer === nummer);
  res.json({ aktiv: true, zugang: (u && u.sipgate_user) || null, geraet: (u && u.sipgate_device) || null, handy: (u && u.sipgate_handy) || null,
    nummer, eigeneNummer: eigene, abgelaufen: !!(u && u.sipgate_nummer && !eigene), testnummer: istTestnummer(nummer) });
});

// ── Für alle: kann ich über sipgate anrufen? ────────────────────
router.get('/config', auth, async (req, res) => {
  if (!istAktiv()) return res.json({ aktiv: false });
  const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer, sipgate_handy FROM users WHERE id=?', [req.user.id]);
  res.json({
    aktiv: true,
    bereit: !!(u && (u.sipgate_device || u.sipgate_user || u.sipgate_handy)),
    handy: !!(u && !u.sipgate_user && u.sipgate_handy),
    nummer: await aktuelleNummer(req.user.id),
  });
});

// ── Altes (classic) oder neues sipgate (Neo, Konten seit 09/2025)? ──
// Neo startet Anrufe über POST /calls statt /sessions/calls. Erkennung über das Konto
// (featureScope NEO_PBX); ist das unklar, wird der andere Weg versucht, wenn einer 404/405 meldet.
async function systemErkennen() {
  if (cfg.system) return cfg.system;
  let system = null;
  try {
    const a = await sg('GET', 'account');
    const scope = String((a && (a.featureScope || a.feature_scope)) || '').toUpperCase();
    system = scope.includes('NEO') ? 'neo' : scope ? 'classic' : null;
  } catch (_) { /* unbekannt */ }
  if (system) { cfg.system = system; await speichern({ ...cfg }, null).catch(() => {}); }
  return system;
}
async function anrufStarten(body) {
  const system = await systemErkennen();
  const wege = system === 'neo' ? ['calls', 'sessions/calls'] : ['sessions/calls', 'calls'];
  let letzter;
  for (const weg of wege) {
    try {
      await sg('POST', weg, body);
      if (!cfg.system || cfg.system !== (weg === 'calls' ? 'neo' : 'classic')) {
        cfg.system = weg === 'calls' ? 'neo' : 'classic';
        speichern({ ...cfg }, null).catch(() => {});
      }
      return;
    } catch (e) {
      letzter = e;
      if (![404, 405, 410].includes(e.status)) throw e;   // nur bei „gibt es hier nicht“ den anderen Weg versuchen
    }
  }
  throw letzter;
}

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
    const [[u]] = await db.query('SELECT sipgate_user, sipgate_device, sipgate_nummer, sipgate_handy FROM users WHERE id=?', [req.user.id]);
    let geraet = u && u.sipgate_device, erst = null;
    if (!geraet && u && u.sipgate_user) {
      const su = (await sipgateBenutzer()).find(x => x.id === u.sipgate_user);
      geraet = su && su.defaultDevice;
    }
    // Ohne eigenen Zugang: über das Gerät des Hauptzugangs, zuerst klingelt das Handy des Closers
    if (!geraet && u && u.sipgate_handy) { erst = u.sipgate_handy; geraet = await hauptGeraet(); }
    if (!geraet) return res.status(400).json({ error: u && u.sipgate_handy
      ? 'Für Anrufe ohne eigenen sipgate-Zugang braucht der Admin ein sipgate-Telefon. Ein Admin kann das unter Integrationen → sipgate erledigen.'
      : 'Dir ist noch kein sipgate-Telefon zugeordnet. Ein Admin kann das unter Integrationen → sipgate erledigen.' });

    const [c] = await db.query(
      `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status)
       VALUES (?, ?, ?, 'outbound', NOW(), 'started')`, [lead.id, req.user.id, lead.phone]);
    // Abgelaufene Nummer (laut Pool) nicht mehr senden, dann Firmennummer
    const absender = (await aktuelleNummer(req.user.id)) || undefined;
    try {
      await anrufStarten({ caller: erst || geraet, deviceId: geraet, callee: ziel, ...(absender ? { callerId: absender } : {}) });
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

// Im Browser aufgerufen: zeigen, dass die Adresse stimmt (sipgate schickt per POST)
router.get('/webhook', (req, res) => {
  res.type('text/plain; charset=utf-8').send('Diese Adresse ist richtig. Hierhin schickt sipgate die Anrufmeldungen (per POST). Im Browser gibt es hier sonst nichts zu sehen.');
});
router.post('/webhook', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  res.type('application/xml');
  if (!signaturOk(req)) {
    // Merken, damit die Einstellungsseite zeigen kann: Meldungen kommen an, aber die Prüfung schlägt fehl
    db.query("INSERT INTO app_settings (key_name, value) VALUES ('sipgate_webhook_abgelehnt', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      [new Date().toISOString()]).catch(() => {});
    console.warn('sipgate Webhook: Signatur ungültig', (req.headers['user-agent'] || '').slice(0, 80));
    res.status(403); return res.send('<?xml version="1.0" encoding="UTF-8"?><Error message="invalid signature"/>');
  }
  const p = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  const event = p.get('event');
  // Merken, dass Meldungen ankommen (auch wenn die Adresse von Hand in sipgate eingetragen wurde)
  db.query("INSERT INTO app_settings (key_name, value) VALUES ('sipgate_webhook_zuletzt', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [new Date().toISOString()]).catch(() => {});
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
        // Closer ohne eigenen Zugang telefonieren über den Hauptzugang: dann über die Nummer zuordnen
        if (!zugeordnet && kunde) {
          const [kand] = await db.query(
            `SELECT c.id, c.phone_number FROM call_logs c JOIN users u ON u.id=c.user_id
             WHERE u.sipgate_user IS NULL AND u.sipgate_handy IS NOT NULL AND c.direction='outbound' AND c.sipgate_call_id IS NULL
               AND c.started_at > NOW() - INTERVAL 5 MINUTE ORDER BY c.id DESC LIMIT 10`);
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
// Für „Fällig“: Nummern, die bald ablaufen, abgelaufen sind oder als Testnummer kein Datum haben (nur genutzte)
module.exports.nummernWarnungen = async () => {
  if (!istAktiv()) return [];
  return (await pool(null)).filter(n => (n.vergeben_an.length || n.firma) && (['abgelaufen', 'laeuft_ab'].includes(n.status) || n.ohne_datum));
};
module.exports.nummerFuer = async userId => (istAktiv() ? aktuelleNummer(userId) : null);
