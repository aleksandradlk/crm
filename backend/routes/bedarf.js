// ── Bedarfsanalyse: 5 Pflichtfragen → „angebotsreif“ → „Angebot anfordern“ ──
// Eine aktive Analyse je Lead (Felder als JSON), Snapshot bei „Angebot anfordern“
// und beim Kurz-Check. Regeln und Preise: public_html/shared/bedarf-regeln.js,
// Zahlen aus app_settings.vertrieb_regeln (Admin → Einstellungen → Vertriebsregeln).
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const sicht = require('../helpers/sichtbarkeit');
const R = require('../public_html/shared/bedarf-regeln');
const { sendHtmlMail } = require('../helpers/mailer');
const { ortZuUtc } = require('../helpers/zeit');

// Erlaubte Felder (alles andere wird verworfen)
const FELDER = ['ansprechpartner_rolle', 'branche', 'branche_text', 'email_angebot', 'webseite', 'instagram', 'teamgroesse', 'buero_vorhanden',
  'kanaele', 'kanal_wichtigster', 'instagram_business', 'whatsapp_firmennummer', 'anfragen_pro_woche', 'anfragen_unpassend', 'auftragswert_schnitt',
  'ablauf_heute', 'antwortzeit', 'nachfragen', 'besichtigungen', 'groesstes_problem', 'zuerst_weg', 'wunschstart', 'software', 'kalender',
  'webseite_status', 'google_profil', 'entscheider', 'entscheider_text', 'paket_empfohlen', 'zusatzleistungen', 'preis_genannt', 'reaktion_preis',
  'rabatt_prozent', 'rabatt_begruendung', 'gratismonat', 'zahlungswunsch', 'sonderwuensche', 'nachfass_termin', 'notiz',
  'einleitung_notiz', 'aktion_prozent', 'aktion_bis'];
const LISTEN = ['kanaele', 'nachfragen', 'zuerst_weg', 'zusatzleistungen'];
// Große Textfelder (Limit aus den Vertriebsregeln, Standard 10.000), alle anderen Textfelder 300 Zeichen.
// Zu lange Eingaben werden abgelehnt, nie still abgeschnitten.
const LANG = ['ablauf_heute', 'groesstes_problem', 'sonderwuensche', 'notiz', 'rabatt_begruendung', 'einleitung_notiz'];
const KURZ_LIMIT = 300;

function fehler400(text) { const e = new Error(text); e.status = 400; return e; }

function bereinigen(data, limit = R.STANDARD.textlimit) {
  const out = {};
  for (const k of FELDER) {
    let v = data?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (LISTEN.includes(k)) { v = (Array.isArray(v) ? v : [v]).map(x => String(x).slice(0, 40)).slice(0, 20); if (!v.length) continue; }
    else if (['anfragen_pro_woche', 'auftragswert_schnitt', 'rabatt_prozent', 'aktion_prozent'].includes(k)) {
      const n = parseFloat(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) continue;
      v = k === 'rabatt_prozent' || k === 'aktion_prozent' ? Math.min(100, n) : n;
    } else {
      v = String(v);
      const max = LANG.includes(k) ? limit : KURZ_LIMIT;
      if (v.length > max) throw fehler400(`„${R.FELDNAME?.[k] || k}“ ist zu lang (${v.length.toLocaleString('de-DE')} von höchstens ${max.toLocaleString('de-DE')} Zeichen). Bitte kürzen, es wurde nichts gespeichert.`);
    }
    out[k] = v;
  }
  if (out.kanal_wichtigster && !(out.kanaele || []).includes(out.kanal_wichtigster)) delete out.kanal_wichtigster;
  if (out.gratismonat && out.gratismonat !== 'ja') out.gratismonat = 'nein';   // höchstens 1 Gratismonat
  return out;
}

async function regeln() {
  try {
    const [[r]] = await db.query("SELECT value FROM app_settings WHERE key_name='vertrieb_regeln'");
    return R.cfgMit(r?.value ? JSON.parse(r.value) : {});
  } catch (_) { return R.cfgMit({}); }
}

// Lead laden und Zugriff prüfen: Admin alles, Closer nur eigene (freie: übernimmt er beim Speichern)
async function leadFuer(req, leadId, schreiben = false) {
  const [[lead]] = await db.query(
    `SELECT id, company, ceo, email, phone, website, location, industry, assigned_to, status FROM leads
     WHERE id=? AND archived_at IS NULL`, [leadId]);
  if (!lead) return { fehler: [404, 'Lead nicht gefunden'] };
  if (req.user.role !== 'admin') {
    if (!sicht.darfSehen(req.user, lead) || (lead.assigned_to !== null && lead.assigned_to !== req.user.id && !sicht.siehtAlles(req.user)))
      return { fehler: [403, 'Dieser Lead wird von einem Kollegen betreut.'] };
    if (schreiben && lead.assigned_to === null) {
      const [r] = await db.query('UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL', [req.user.id, lead.id]);
      if (r.affectedRows) { lead.assigned_to = req.user.id; await log(req.user.id, 'lead_assign', 'lead', lead.id, { assigned_to: req.user.id, via: 'bedarfsanalyse' }, req.ip); }
    }
  }
  return { lead };
}

async function analyseLaden(leadId) {
  const [[a]] = await db.query('SELECT * FROM bedarfsanalysen WHERE lead_id=?', [leadId]);
  if (a) { try { a.data = JSON.parse(a.data || '{}'); } catch (_) { a.data = {}; } }
  return a || null;
}

// Vorbelegung aus dem Lead (E-Mail, Webseite, Branche)
function vorbelegt(lead, data) {
  const d = { ...data };
  if (!d.email_angebot && lead.email) d.email_angebot = lead.email;
  if (!d.webseite && lead.website) d.webseite = lead.website;
  if (!d.branche && lead.industry) {
    const i = lead.industry.toLowerCase();
    const map = [['fahrzeug', /fahrzeug|aufbereit|auto|kfz/], ['bad', /bad|shk|sanit|fliese|heizung/], ['maler', /maler|lackier/], ['boden', /boden|parkett/]];
    const hit = map.find(([, re]) => re.test(i));
    d.branche = hit ? hit[0] : 'andere';
    if (!hit && !d.branche_text) d.branche_text = lead.industry;
  }
  return d;
}

function auswertung(data, lead, cfg) {
  const d = { ...data, _industry: lead.industry || '' };
  return { pruefung: R.pruefen(d, cfg), vorschlag: R.vorschlag(d, cfg), deal_wert: R.dealWert(d, cfg) };
}

// Speichern mit Versionsprüfung: Wer mit einem veralteten Stand speichert (version passt nicht),
// bekommt { konflikt, alt } zurück statt fremden Text zu überschreiben. Ohne version (alte Seiten,
// Kurz-Check, Wiederherstellen) wird wie bisher gespeichert.
async function speichern(leadId, data, userId, { version = null, anlass = 'autosave' } = {}) {
  const alt = await analyseLaden(leadId);
  const [[lead]] = await db.query('SELECT industry FROM leads WHERE id=?', [leadId]);
  const cfg = await regeln();
  const { pruefung, vorschlag } = auswertung(data, lead || {}, cfg);
  const json = JSON.stringify(data);
  const pruefen = version !== null && version !== undefined && Number.isFinite(Number(version));
  if (alt) {
    const [r] = await db.query(`UPDATE bedarfsanalysen SET data=?, angebotsreif=?, fragen_ok=?, paket_vorschlag=?, updated_by=?, version=version+1
      WHERE id=?${pruefen ? ' AND version=?' : ''}`,
      [json, pruefung.angebotsreif ? 1 : 0, pruefung.fragen_ok, vorschlag.paket, userId, alt.id, ...(pruefen ? [Number(version)] : [])]);
    if (!r.affectedRows) return { konflikt: true, alt };
  } else {
    try {
      await db.query('INSERT INTO bedarfsanalysen (lead_id, data, angebotsreif, fragen_ok, paket_vorschlag, created_by, updated_by, version) VALUES (?,?,?,?,?,?,?,1)',
        [leadId, json, pruefung.angebotsreif ? 1 : 0, pruefung.fragen_ok, vorschlag.paket, userId, userId]);
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      return { konflikt: true, alt: await analyseLaden(leadId) };   // gleichzeitig angelegt
    }
  }
  const neu = await analyseLaden(leadId);
  await versionMerken(neu, alt, userId, anlass).catch(e => console.error('Bedarf-Version:', e.message));
  return { a: neu, alt };
}

// Versionsverlauf in bedarfsanalyse_snapshots. Jeder Stand bleibt wiederherstellbar:
// - der Stand vor einer Änderung wird gesichert, falls er noch in keiner Version steht,
// - Autosave fasst die Änderungen einer Person innerhalb von 10 Minuten zu einer Version zusammen,
// - wird ein Text deutlich kürzer (≥ 20 Zeichen weg), beginnt immer eine neue Version.
function gekuerzt(alt, neu) {
  return LANG.some(k => String(alt?.[k] || '').length - String(neu?.[k] || '').length >= 20);
}
async function versionMerken(neu, alt, userId, anlass) {
  const [[letzte]] = await db.query(
    `SELECT id, anlass, data, created_by, created_at > NOW() - INTERVAL 10 MINUTE AS frisch
     FROM bedarfsanalyse_snapshots WHERE analyse_id=? ORDER BY id DESC LIMIT 1`, [neu.id]);
  let zusammenfassen = !!letzte;
  if (alt && (!letzte || letzte.data !== JSON.stringify(alt.data))) {
    await db.query('INSERT INTO bedarfsanalyse_snapshots (analyse_id, lead_id, deal_id, anlass, data, created_by) VALUES (?,?,?,?,?,?)',
      [alt.id, alt.lead_id, alt.deal_id || null, 'stand_vorher', JSON.stringify(alt.data), alt.updated_by || null]);
    zusammenfassen = false;
  }
  const json = JSON.stringify(neu.data);
  if (zusammenfassen && letzte.anlass === 'autosave' && anlass === 'autosave' && letzte.created_by === userId
      && Number(letzte.frisch) === 1 && !gekuerzt(alt?.data, neu.data))
    await db.query('UPDATE bedarfsanalyse_snapshots SET data=? WHERE id=?', [json, letzte.id]);
  else
    await db.query('INSERT INTO bedarfsanalyse_snapshots (analyse_id, lead_id, deal_id, anlass, data, created_by) VALUES (?,?,?,?,?,?)',
      [neu.id, neu.lead_id, neu.deal_id || null, anlass, json, userId]);
}

async function nameVon(userId) {
  if (!userId) return '';
  const [[u]] = await db.query('SELECT full_name, username FROM users WHERE id=?', [userId]);
  return u ? (u.full_name || u.username) : '';
}

async function snapshot(a, anlass, userId) {
  await db.query('INSERT INTO bedarfsanalyse_snapshots (analyse_id, lead_id, deal_id, anlass, data, created_by) VALUES (?,?,?,?,?,?)',
    [a.id, a.lead_id, a.deal_id || null, anlass, JSON.stringify(a.data), userId]);
}

const sqlZeit = v => {
  if (!v) return null;
  const s = String(v).replace('T', ' ').slice(0, 16);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s + ':00' : null;
};

// Nachfass-Termin aus der Analyse = eine offene Wiedervorlage des Closers
async function nachfassReminder(leadId, userId, termin, company) {
  const at = ortZuUtc(sqlZeit(termin));          // Eingabe deutsche Zeit → UTC
  if (!at || !userId) return;
  const [[r]] = await db.query("SELECT id FROM reminders WHERE lead_id=? AND user_id=? AND kind='nachfass' AND done_at IS NULL", [leadId, userId]);
  if (r) await db.query('UPDATE reminders SET remind_at=?, sent=0 WHERE id=?', [at, r.id]);
  else await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind) VALUES (?,?,?,?, 'nachfass')",
    [leadId, userId, at, `Nachfassen: ${company || 'Angebot'} (Bedarfsanalyse)`]);
}

// ── GET /api/bedarf/config — Regeln, Preise, Auswahlwerte ──
router.get('/config', auth, async (req, res) => res.json(await regeln()));

// ── GET /api/bedarf/admin-hinweis — Anfragen, die zu lange warten (Dashboard) ──
router.get('/admin-hinweis', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
  try {
    const cfg = await regeln();
    const [rows] = await db.query(
      `SELECT d.id, l.company FROM deals d JOIN leads l ON l.id=d.lead_id JOIN deal_stages s ON s.id=d.stage_id
       WHERE d.status='open' AND s.name REGEXP 'anforder|anfrage'
         AND COALESCE(d.angefordert_at, d.stage_changed_at) < NOW() - INTERVAL ? HOUR`, [Number(cfg.anfrage_warte_std) || 24]);
    res.json({ warte_std: cfg.anfrage_warte_std, wartend: rows });
  } catch (e) { res.json({ wartend: [] }); }
});

// ── GET /api/bedarf/lead/:id ──
router.get('/lead/:id', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id));
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const a = await analyseLaden(lead.id);
    const data = vorbelegt(lead, a?.data || {});
    const cfg = await regeln();
    const [[deal]] = await db.query(
      `SELECT d.id, d.title, d.value, d.stage_id, s.name AS stage_name, d.angefordert_at, d.angebot_gesendet_at FROM deals d
       LEFT JOIN deal_stages s ON s.id = d.stage_id WHERE d.lead_id=? AND d.status='open' ORDER BY d.id DESC LIMIT 1`, [lead.id]);
    res.json({ lead, data, id: a?.id || null, angefordert_am: a?.angefordert_am || null, updated_at: a?.updated_at || null,
      version: a?.version || 0, updated_von: await nameVon(a?.updated_by), textlimit: cfg.textlimit,
      deal: deal || null, ...auswertung(data, lead, cfg) });
  } catch (e) { console.error('Bedarf GET:', e); res.status(500).json({ error: 'Bedarfsanalyse konnte nicht geladen werden.' }); }
});

// ── PUT /api/bedarf/lead/:id — speichern (Autosave) ──
router.put('/lead/:id', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id), true);
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const cfg = await regeln();
    const data = bereinigen(req.body?.data || {}, cfg.textlimit);
    const anlass = req.body?.anlass === 'speichern' ? 'speichern' : 'autosave';
    const erg = await speichern(lead.id, data, req.user.id, { version: req.body?.version, anlass });
    if (erg.konflikt) {
      const a = erg.alt;
      return res.status(409).json({ error: 'Die Bedarfsanalyse wurde inzwischen geändert.', konflikt: true,
        data: vorbelegt(lead, a?.data || {}), version: a?.version || 0, updated_at: a?.updated_at || null, updated_von: await nameVon(a?.updated_by) });
    }
    const { a, alt } = erg;
    if (data.nachfass_termin && data.nachfass_termin !== alt?.data?.nachfass_termin)
      await nachfassReminder(lead.id, lead.assigned_to || req.user.id, data.nachfass_termin, lead.company);
    res.json({ ok: true, id: a.id, updated_at: a.updated_at, version: a.version, updated_von: req.user.full_name || req.user.username,
      ...auswertung(data, lead, cfg) });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error('Bedarf PUT:', e); res.status(500).json({ error: 'Speichern fehlgeschlagen.' });
  }
});

// ── Versionsverlauf ──
// GET /api/bedarf/lead/:id/versionen — Liste (neueste zuerst)
router.get('/lead/:id/versionen', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id));
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const [rows] = await db.query(
      `SELECT s.id, s.anlass, s.created_at, s.data, COALESCE(u.full_name, u.username) AS von
       FROM bedarfsanalyse_snapshots s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.lead_id=? ORDER BY s.id DESC LIMIT 300`, [lead.id]);
    const daten = rows.map(r => { try { return JSON.parse(r.data || '{}'); } catch (_) { return {}; } });
    res.json({ versionen: rows.map((r, i) => {
      const d = daten[i];
      const zeichen = LANG.reduce((n, k) => n + String(d[k] || '').length, 0);
      // Was sich gegenüber dem vorherigen (älteren) Stand geändert hat, als Stichpunkte
      const aenderungen = i + 1 < daten.length ? R.aenderungen(daten[i + 1], d) : null;
      return { id: r.id, anlass: r.anlass, created_at: r.created_at, von: r.von || '', zeichen, aenderungen,
        vorschau: String(d.groesstes_problem || d.ablauf_heute || d.sonderwuensche || '').slice(0, 120) };
    }) });
  } catch (e) { console.error('Bedarf Versionen:', e); res.status(500).json({ error: 'Verlauf konnte nicht geladen werden.' }); }
});

// GET /api/bedarf/lead/:id/versionen/:vid — ein Stand
router.get('/lead/:id/versionen/:vid', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id));
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const [[v]] = await db.query(
      `SELECT s.id, s.anlass, s.created_at, s.data, COALESCE(u.full_name, u.username) AS von FROM bedarfsanalyse_snapshots s
       LEFT JOIN users u ON u.id = s.created_by WHERE s.id=? AND s.lead_id=?`, [parseInt(req.params.vid), lead.id]);
    if (!v) return res.status(404).json({ error: 'Version nicht gefunden' });
    let data = {}; try { data = JSON.parse(v.data || '{}'); } catch (_) {}
    res.json({ id: v.id, anlass: v.anlass, created_at: v.created_at, von: v.von || '', data });
  } catch (e) { console.error('Bedarf Version:', e); res.status(500).json({ error: 'Version konnte nicht geladen werden.' }); }
});

// POST /api/bedarf/lead/:id/versionen/:vid/wiederherstellen — der aktuelle Stand bleibt als Version erhalten
router.post('/lead/:id/versionen/:vid/wiederherstellen', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id), true);
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const [[v]] = await db.query('SELECT data FROM bedarfsanalyse_snapshots WHERE id=? AND lead_id=?', [parseInt(req.params.vid), lead.id]);
    if (!v) return res.status(404).json({ error: 'Version nicht gefunden' });
    let data = {}; try { data = JSON.parse(v.data || '{}'); } catch (_) {}
    const cfg = await regeln();
    const { a } = await speichern(lead.id, bereinigen(data, Math.max(cfg.textlimit, 100000)), req.user.id, { anlass: 'wiederherstellung' });
    await log(req.user.id, 'bedarf_wiederherstellen', 'lead', lead.id, { version: parseInt(req.params.vid) }, req.ip);
    res.json({ ok: true, version: a.version });
  } catch (e) { console.error('Bedarf wiederherstellen:', e); res.status(500).json({ error: 'Wiederherstellen fehlgeschlagen.' }); }
});

// POST /api/bedarf/lead/:id/versionen — eigenen Stand nur als Version ablegen (z. B. bei einem Konflikt)
router.post('/lead/:id/versionen', auth, async (req, res) => {
  try {
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id));
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const a = await analyseLaden(lead.id);
    if (!a) return res.json({ ok: false });
    const data = bereinigen(req.body?.data || {}, Math.max((await regeln()).textlimit, 100000));
    await db.query('INSERT INTO bedarfsanalyse_snapshots (analyse_id, lead_id, deal_id, anlass, data, created_by) VALUES (?,?,?,?,?,?)',
      [a.id, lead.id, a.deal_id || null, 'konflikt', JSON.stringify(data), req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Bedarf Version ablegen:', e); res.status(500).json({ error: 'Version konnte nicht abgelegt werden.' }); }
});

// ── POST /api/bedarf/lead/:id/kurzcheck — „Keine Zeit“: 3 Fragen + Rückruftermin ──
router.post('/lead/:id/kurzcheck', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const at = sqlZeit(b.rueckruf_at);
    if (!at) return res.status(400).json({ error: 'Bitte einen Rückruftermin angeben.' });
    if (new Date(at.replace(' ', 'T')).getTime() < Date.now() - 60000) return res.status(400).json({ error: 'Der Rückruftermin liegt in der Vergangenheit.' });
    const { lead, fehler } = await leadFuer(req, parseInt(req.params.id), true);
    if (fehler) return res.status(fehler[0]).json({ error: fehler[1] });
    const alt = await analyseLaden(lead.id);
    const data = bereinigen({ ...vorbelegt(lead, alt?.data || {}), kanaele: b.kanaele, anfragen_pro_woche: b.anfragen_pro_woche, groesstes_problem: b.groesstes_problem }, (await regeln()).textlimit);
    await speichern(lead.id, data, req.user.id, { anlass: 'kurzcheck' });
    const { vorschlag } = auswertung(data, lead, await regeln());
    // Im Anrufmodus legt das Speichern des Ergebnisses den Rückruf an (reminder=false)
    if (b.reminder !== false) {
      await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note) VALUES (?,?,?,?)",
        [lead.id, lead.assigned_to || req.user.id, ortZuUtc(at), `Rückruf nach Kurz-Check · Vorschlag ${vorschlag.name}`]);
      await db.query("UPDATE leads SET status='rueckruf' WHERE id=?", [lead.id]);
    }
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [lead.id, req.user.id, `⚡ Kurz-Check: ${(data.kanaele || []).map(k => R.label('kanaele', k)).join(', ') || '–'} · ${data.anfragen_pro_woche ?? '?'} Anfragen/Woche · Vorschlag ${vorschlag.name}`]);
    await log(req.user.id, 'bedarf_kurzcheck', 'lead', lead.id, { paket: vorschlag.paket }, req.ip);
    res.json({ ok: true, vorschlag });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error('Kurzcheck:', e); res.status(500).json({ error: 'Kurz-Check konnte nicht gespeichert werden.' });
  }
});

// ── Angebot anfordern (Knopf und Drag & Drop in die Phase) ──
async function anfordern(req, leadId, dealId = null) {
  const { lead, fehler } = await leadFuer(req, leadId, true);
  if (fehler) return { status: fehler[0], error: fehler[1] };
  const a = await analyseLaden(lead.id);
  const cfg = await regeln();
  const data = vorbelegt(lead, a?.data || {});
  const { pruefung, vorschlag } = auswertung(data, lead, cfg);
  if (!a || !pruefung.angebotsreif)
    return { status: 409, error: 'Die Bedarfsanalyse ist noch nicht angebotsreif.', fehlt: pruefung.fehlt, lead_id: lead.id };
  const deals = require('./deals');
  const [[stage]] = await db.query("SELECT id, name FROM deal_stages WHERE is_active=1 AND name REGEXP 'anforder|anfrage' ORDER BY sort_order LIMIT 1");
  const paket = cfg.pakete[data.paket_empfohlen];
  const wert = R.dealWert(data, cfg);
  const flag = (Number(data.rabatt_prozent) || 0) > cfg.rabatt_grenze ? `Rabatt ${data.rabatt_prozent} % – braucht Zustimmung per E-Mail` : null;
  const owner = lead.assigned_to || req.user.id;

  let [[deal]] = await db.query("SELECT * FROM deals WHERE lead_id=? AND status='open' ORDER BY (id=?) DESC, (id=?) DESC, id DESC LIMIT 1", [lead.id, dealId || 0, a.deal_id || 0]);
  if (!deal) {
    const id = await deals.createDeal({ leadId: lead.id, userId: req.user.id, title: `${lead.company} – ${paket.name}`, value: wert, stageId: stage?.id, ownerId: owner });
    [[deal]] = await db.query('SELECT * FROM deals WHERE id=?', [id]);
  } else {
    await db.query('UPDATE deals SET value=?, stage_id=COALESCE(?, stage_id), stage_changed_at=IF(stage_id<=>?, stage_changed_at, NOW()) WHERE id=?',
      [wert || deal.value, stage?.id || null, stage?.id || null, deal.id]);
  }
  await db.query('UPDATE deals SET paket=?, admin_flag=?, angefordert_at=NOW(), hinweis_24h_at=NULL, herkunft=COALESCE(herkunft, ?) WHERE id=?',
    [data.paket_empfohlen, flag, 'crm', deal.id]);
  await db.query('UPDATE bedarfsanalysen SET deal_id=?, angefordert_am=NOW(), angefordert_von=? WHERE id=?', [deal.id, req.user.id, a.id]);
  a.deal_id = deal.id;
  await snapshot({ ...a, data }, 'angebot_anfordern', req.user.id);

  // Hinweis im CRM (Heute + Reminder beim Admin) und Mail an info@
  const kurz = `${paket.name}${(data.zusatzleistungen || []).length ? ' + ' + data.zusatzleistungen.map(k => cfg.zusatz[k]?.name).filter(Boolean).join(', ') : ''}`
    + `${data.rabatt_prozent ? ` · ${data.rabatt_prozent} % Rabatt` : ''} · „${String(data.groesstes_problem).slice(0, 140)}“`;
  await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)', [lead.id, req.user.id, `📝 Angebot angefordert: ${kurz}`]);
  const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
  await db.query("UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND kind='angebot' AND done_at IS NULL", [lead.id]);
  for (const ad of admins)
    await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent) VALUES (?,?,NOW(),?, 'angebot', 1)",
      [lead.id, ad.id, `Angebot anfordern: ${lead.company} · ${paket.name} (${req.user.full_name || ''})`.slice(0, 500)]);
  const [[closer]] = await db.query('SELECT full_name FROM users WHERE id=?', [owner]);
  await mailAnfrage({ lead, data, cfg, vorschlag, deal, closer: closer?.full_name || req.user.full_name, flag }).catch(e => console.error('Anfrage-Mail:', e.message));

  await nachfassReminder(lead.id, owner, data.nachfass_termin, lead.company);
  await log(req.user.id, 'angebot_anfordern', 'lead', lead.id, { deal_id: deal.id, paket: data.paket_empfohlen, wert }, req.ip);
  return { ok: true, deal_id: deal.id, message: 'Angebot angefordert. Aleksandra schickt es heute, spätestens in 24 Stunden.' };
}

router.post('/lead/:id/anfordern', auth, async (req, res) => {
  try {
    const r = await anfordern(req, parseInt(req.params.id));
    if (!r.ok) return res.status(r.status).json(r);
    res.json(r);
  } catch (e) { console.error('Anfordern:', e); res.status(500).json({ error: 'Angebot konnte nicht angefordert werden.' }); }
});

// ── Mail an den Admin: kompakte Zusammenfassung, leere Felder weg ──
async function mailAnfrage({ lead, data: d, cfg, deal, closer, flag }) {
  const e = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const L = (f, v) => R.label(f, v);
  const liste = (f, arr) => (arr || []).map(v => L(f, v)).join(', ');
  const link = u => { const href = /^https?:\/\//i.test(u) ? u : 'https://' + u; return `<a href="${e(href)}">${e(u)}</a>`; };
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  const paket = cfg.pakete[d.paket_empfohlen];
  const zus = (d.zusatzleistungen || []).map(k => cfg.zusatz[k]?.name).filter(Boolean);
  const kanaele = (d.kanaele || []).map(k => k === d.kanal_wichtigster ? `<b>${e(L('kanaele', k))}</b>` : e(L('kanaele', k))).join(', ');
  const zeilen = [
    [lead.company + (lead.location ? ', ' + lead.location : ''), [d.webseite && link(d.webseite), d.instagram && link(d.instagram)].filter(Boolean).join(' · '), true],
    [[d.branche === 'andere' ? d.branche_text : L('branche', d.branche), d.teamgroesse && `Team ${L('teamgroesse', d.teamgroesse)}`, d.ansprechpartner_rolle && `${lead.ceo || 'Ansprechpartner'} (${d.ansprechpartner_rolle})`].filter(Boolean).join(' · ')],
    [null, `Kanäle: ${kanaele}${d.anfragen_pro_woche != null ? ` · ${e(d.anfragen_pro_woche)} Anfragen/Woche` : ''}${d.anfragen_unpassend ? ` (davon unpassend: ${e(d.anfragen_unpassend)})` : ''}`],
    [d.ablauf_heute && `Ablauf heute: ${d.ablauf_heute}`],
    [null, d.groesstes_problem ? `Größtes Problem: <i>„${e(d.groesstes_problem)}“</i>` : ''],
    [null, `<b>${e(paket?.name || '')}</b>${zus.length ? ' + ' + e(zus.join(', ')) : ''} · Wert ${e(R.eur(R.dealWert(d, cfg)))}`
      + ` · Preis genannt: ${d.preis_genannt === 'ja' ? 'ja' : 'nein'}${d.reaktion_preis ? ` (${e(L('reaktion_preis', d.reaktion_preis))})` : ''}`
      + `${d.rabatt_prozent ? ` · Rabatt ${e(d.rabatt_prozent)} %` : ''}${d.gratismonat === 'ja' ? ' · 1 Gratismonat' : ''}${d.zahlungswunsch ? ` · ${e(L('zahlungswunsch', d.zahlungswunsch))}` : ''}`],
    [null, flag ? `<span style="color:#b45309">⚠ ${e(flag)}${d.rabatt_begruendung ? ` – ${e(d.rabatt_begruendung)}` : ''}</span>` : ''],
    [[d.wunschstart && `Wunschstart: ${d.wunschstart}`, d.entscheider && `Entscheider: ${d.entscheider === 'anderer' ? (d.entscheider_text || 'anderer') : L('entscheider', d.entscheider)}`].filter(Boolean).join(' · ')],
    [[d.software && `Software: ${d.software}`, d.kalender && `Kalender: ${L('kalender', d.kalender)}`, d.google_profil && `Google-Profil: ${L('google_profil', d.google_profil)}`, d.webseite_status && `Webseite: ${L('webseite_status', d.webseite_status)}`].filter(Boolean).join(' · ')],
    [d.sonderwuensche && `Sonderwünsche: ${d.sonderwuensche}`],
    [d.nachfass_termin && `Nachfass-Termin von ${closer}: ${new Date(d.nachfass_termin.replace(' ', 'T') + (d.nachfass_termin.length <= 16 ? ':00' : '') + 'Z').toLocaleString('de-DE', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} Uhr`],
  ];
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a2330;line-height:1.55">
    <h2 style="margin:0 0 4px;color:#2c3a55">Angebot anfordern</h2>
    <div style="color:#59616e;margin-bottom:14px">von ${e(closer)}</div>
    ${zeilen.map(([txt, raw, gross]) => {
      const inhalt = [txt && e(txt), raw].filter(Boolean).join(gross ? '<br>' : ' ');
      return inhalt ? `<div style="margin:0 0 8px;${gross ? 'font-size:16px;font-weight:bold' : ''}">${inhalt}</div>` : '';
    }).join('')}
    ${d.email_angebot ? `<div style="margin:0 0 8px">Angebot an: ${e(d.email_angebot)}</div>` : ''}
    <div style="margin-top:18px">
      <a href="${e(base)}/admin?deal=${deal.id}" style="display:inline-block;background:#2c3a55;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;margin-right:8px">Deal öffnen</a>
      <a href="${e(base)}/admin?angebot_deal=${deal.id}&lead=${lead.id}" style="display:inline-block;background:#b8692d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Angebot erstellen (vorbefüllt)</a>
    </div></div>`;
  await sendHtmlMail({ to: cfg.admin_mail, subject: `Angebot anfordern: ${lead.company} · ${paket?.name || ''} · von ${closer}`, html });
}

// ── Angebot gesendet (nur Admin): Closer benachrichtigen (keine automatischen Nachfass-Reminder mehr) ──
async function angebotGesendet(dealId, admin) {
  const [[d]] = await db.query('SELECT d.*, l.company, l.assigned_to FROM deals d JOIN leads l ON l.id=d.lead_id WHERE d.id=?', [dealId]);
  if (!d) return;
  const closerId = d.owner_id || d.assigned_to;
  await db.query('UPDATE deals SET angebot_gesendet_at=NOW() WHERE id=?', [d.id]);
  await db.query("UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND kind IN ('angebot','angebot_wartet') AND done_at IS NULL", [d.lead_id]);
  await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)', [d.lead_id, admin.id, `📨 Angebot an ${d.company} verschickt`]);
  if (!closerId) return;
  await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind, sent) VALUES (?,?,NOW(),?, 'info', 1)",
    [d.lead_id, closerId, `Angebot an ${d.company} ist raus. Du entscheidest selbst, wann du nachfasst.`]);
  // Keine automatischen Nachfass-Erinnerungen (Tag 2/5/10) mehr: der Vertriebler entscheidet selbst.
  // Am Deal steht „Angebot gesendet am …“ und ob der Kunde geantwortet hat.
  try {
    const [[u]] = await db.query('SELECT email, full_name, notify_email FROM users WHERE id=?', [closerId]);
    if (u?.email && u.notify_email) {
      const base = (process.env.BASE_URL || '').replace(/\/$/, '');
      await sendHtmlMail({ to: u.email, subject: `📨 Angebot an ${d.company} ist raus`,
        html: `<div style="font-family:Arial,sans-serif;color:#1a2330">Hallo ${String(u.full_name).replace(/</g, '')},<br><br>das Angebot an <b>${String(d.company).replace(/</g, '')}</b> ist raus. Wann du nachfasst, entscheidest du selbst; am Deal siehst du, ob der Kunde geantwortet hat.<br><br><a href="${base}/closer">Zum CRM</a></div>` });
    }
  } catch (e) { console.error('Mail Angebot gesendet:', e.message); }
}

// ── Fristen (alle 10 Minuten): 24-Std.-Hinweis, überholte Auto-Reminder ──
async function fristen() {
  try {
    const cfg = await regeln();
    const [wartend] = await db.query(
      `SELECT d.id, d.lead_id, l.company FROM deals d JOIN leads l ON l.id=d.lead_id JOIN deal_stages s ON s.id=d.stage_id
       WHERE d.status='open' AND s.name REGEXP 'anforder|anfrage' AND d.hinweis_24h_at IS NULL
         AND COALESCE(d.angefordert_at, d.stage_changed_at) < NOW() - INTERVAL ? HOUR`, [Number(cfg.anfrage_warte_std) || 24]);
    if (wartend.length) {
      const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
      for (const d of wartend) {
        await db.query('UPDATE deals SET hinweis_24h_at=NOW() WHERE id=?', [d.id]);
        for (const a of admins)
          await db.query("INSERT INTO reminders (lead_id, user_id, remind_at, note, kind) VALUES (?,?,NOW(),?, 'angebot_wartet')",
            [d.lead_id, a.id, `Angebot für ${d.company} wartet seit über ${cfg.anfrage_warte_std} Std.`]);
      }
    }
    // Eigener späterer Nachfass-Termin des Closers ersetzt die automatischen Reminder davor
    await db.query(
      `UPDATE reminders a JOIN reminders o ON o.lead_id=a.lead_id AND o.user_id=a.user_id AND o.done_at IS NULL
         AND (o.kind IS NULL OR o.kind='nachfass') AND o.remind_at >= a.remind_at
       SET a.done_at=NOW() WHERE a.kind='nachfass_auto' AND a.done_at IS NULL AND a.sent=0`);
  } catch (e) { if (!/bedarfsanalysen|hinweis_24h_at/.test(e.message)) console.error('Fristen:', e.message); }
}

// Bekannte Antworten (z. B. aus der Übergabe) eintragen – nur leere Felder
async function vorbefuellen(leadId, antworten, userId) {
  const [[lead]] = await db.query('SELECT id, company, email, website, industry FROM leads WHERE id=?', [leadId]);
  if (!lead) return null;
  const alt = await analyseLaden(leadId);
  const data = vorbelegt(lead, alt?.data || {});
  const limit = (await regeln()).textlimit;
  const neu = bereinigen(antworten || {}, limit);
  for (const [k, v] of Object.entries(neu)) if (R.leer(data[k])) data[k] = v;
  await speichern(leadId, bereinigen(data, limit), userId, { anlass: 'uebergabe' });
  return R.pruefen({ ...data, _industry: lead.industry || '' }, await regeln());
}
// Offene Pflichtfragen eines Leads (für „Noch klären“)
async function offeneFragen(leadId) {
  const [[lead]] = await db.query('SELECT id, company, email, website, industry FROM leads WHERE id=?', [leadId]);
  if (!lead) return [];
  const a = await analyseLaden(leadId);
  const p = R.pruefen({ ...vorbelegt(lead, a?.data || {}), _industry: lead.industry || '' }, await regeln());
  return p.fragen.filter(f => !f.ok).map(f => ({ nr: f.nr, titel: f.titel }));
}

module.exports = router;
module.exports.vorbefuellen = vorbefuellen;
module.exports.offeneFragen = offeneFragen;
module.exports.anfordern = anfordern;
module.exports.angebotGesendet = angebotGesendet;
module.exports.fristen = fristen;
module.exports.analyseLaden = analyseLaden;
module.exports.regeln = regeln;
module.exports.R = R;
