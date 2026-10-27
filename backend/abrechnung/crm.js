// ============================================================
// Abrechnung im CRM (Angebote, Rechnungen, Mahnungen, Abos)
// Das Modul stammt aus dem Angebotstool (aleksandradlk/angebot-tool) und
// läuft hier nur mit dem NovaFlow-Bestand – für Admins und Closer mit der
// Berechtigung „Angebote & Rechnungen“.
//
// Daten: SQLite-Datei + archivierte PDFs außerhalb des App-Ordners
// (Hostinger baut jede Version in einen frischen Ordner):
//   ABRECHNUNG_DATA_DIR, sonst ~/crm-abrechnung
// Bei jedem Start (und auf Knopfdruck) gleicht das CRM den NovaFlow-Bestand
// mit dem Angebotstool ab (~/angebot-tool-daten bzw. ANGEBOT_TOOL_DATA_DIR),
// siehe abgleich.js – das Tool selbst bleibt dabei unverändert.
// ============================================================
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { log } = require('../helpers/logger');

const COOKIE = 'crm_abr';
const status = { aktiv: false, grund: null, datenordner: null, abgleich: null, eingespielt: null };

function datenordner() {
  return path.resolve(process.env.ABRECHNUNG_DATA_DIR || path.join(os.homedir(), 'crm-abrechnung'));
}
const { gleicheAb, toolDatenordner } = require('./abgleich');

// ── Anmeldung: CRM-Token (Header) oder kurzlebiges Cookie für Downloads ──
// PDFs, ZIP- und CSV-Exporte werden als normale Links geöffnet und können
// keinen Authorization-Header mitschicken – dafür setzt die Seite beim Laden
// ein eigenes, nur für /api/abrechnung gültiges Cookie.
// Zugriff: Admins immer, Closer nur mit der Berechtigung „Angebote & Rechnungen“
async function ladeBerechtigten(id) {
  const [[u]] = await db.query('SELECT id, role, is_active, full_name, can_abrechnung FROM users WHERE id=?', [id]);
  return u && u.is_active && (u.role === 'admin' || u.can_abrechnung) ? u : null;
}
// Firmendaten, Sicherungen und Wiederherstellen bleiben Admins vorbehalten
const NUR_ADMIN = [/^\/stammdaten$/, /^\/wiederherstellen$/, /^\/sicherung\//, /^\/email\/test$/];
function adminBereich(req, res, next) {
  if (req.user.role !== 'admin' && (/^\/export\//.test(req.path) || (req.method !== 'GET' && NUR_ADMIN.some(r => r.test(req.path)))))
    return res.status(403).json({ success: false, error: 'Das darf nur ein Admin ändern.' });
  next();
}
function cookieWert(req) {
  for (const teil of String(req.headers.cookie || '').split(';')) {
    const i = teil.indexOf('=');
    if (i > -1 && teil.slice(0, i).trim() === COOKIE) return decodeURIComponent(teil.slice(i + 1).trim());
  }
  return null;
}
async function nurBerechtigte(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : cookieWert(req);
    if (!token) return res.status(401).json({ success: false, error: 'Bitte zuerst im CRM anmelden.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await ladeBerechtigten(payload.id);
    if (!user) return res.status(403).json({ success: false, error: 'Für Angebote & Rechnungen fehlt dir die Berechtigung. Ein Admin kann sie unter Benutzer freischalten.' });
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ success: false, error: 'Sitzung abgelaufen – bitte neu anmelden.' });
  }
}

// ── Angebotsstatus → Deal im CRM ─────────────────────────────
async function angebotStatusAnCrm(a) {
  const dealId = a.crm && a.crm.dealId;
  if (!dealId) return;
  const { markWon, markLost } = require('../routes/deals');
  const [[deal]] = await db.query('SELECT * FROM deals WHERE id=?', [dealId]);
  if (!deal) return;
  // Wert: einmalige Summe (netto); reine Monats-Angebote mit Jahreswert
  const wert = a.summen.netto > 0 ? a.summen.netto : Math.round((a.monatlichSumme || 0) * 12 * 100) / 100;
  if (a.status === 'angenommen' && deal.status !== 'won') {
    // Als Admin gewonnen setzen (Angebot wurde in der Abrechnung angenommen) – der Closer bekommt dann einen Hinweis
    const [[admin]] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1");
    await markWon(deal, admin ? admin.id : deal.owner_id || deal.created_by, wert || undefined);
    await log(deal.owner_id || deal.created_by, 'deal_won', 'lead', deal.lead_id, { deal_id: deal.id, angebot: a.nummer }, null);
  } else if (a.status === 'abgelehnt' && deal.status === 'open') {
    await markLost(deal, deal.owner_id || deal.created_by, `Angebot ${a.nummer} abgelehnt`);
  } else if (a.status === 'versendet' && deal.status === 'open') {
    // In die Phase „Angebot gesendet“ schieben, falls es sie gibt und der Deal davor steht
    const [[st]] = await db.query("SELECT id, sort_order FROM deal_stages WHERE is_active=1 AND name LIKE 'Angebot%' AND name NOT REGEXP 'anforder|anfrage' ORDER BY sort_order LIMIT 1");
    const [[cur]] = await db.query('SELECT sort_order FROM deal_stages WHERE id=?', [deal.stage_id]);
    if (st && (!cur || cur.sort_order < st.sort_order)) {
      await db.query('UPDATE deals SET stage_id=?, stage_changed_at=NOW(), value=IF(value=0, ?, value) WHERE id=?', [st.id, wert, deal.id]);
    }
    // Beim ersten Versand wie „Angebot verschickt“: Closer benachrichtigen, Nachfassen planen
    if (!deal.angebot_gesendet_at) {
      const [[admin]] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1");
      await require('../routes/bedarf').angebotGesendet(deal.id, { id: admin ? admin.id : deal.created_by });
    } else {
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [deal.lead_id, deal.owner_id || deal.created_by, `📄 Angebot ${a.nummer} versendet`]);
    }
  }
}

// ── Einhängen in die CRM-App ──────────────────────────────────
function registriere(app, { ki } = {}) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) {
    status.grund = `Die Abrechnung braucht Node.js 22.13 oder neuer (aktuell ${process.version}). In Hostinger bei der CRM-App die Node.js-Version auf 22 stellen.`;
    console.warn('Abrechnung deaktiviert:', status.grund);
  }

  // Sitzungs-Cookie für Downloads setzen (gilt 8 Stunden, nur für /api/abrechnung)
  app.post('/api/abrechnung-sitzung', express.json(), nurBerechtigte, (req, res) => {
    const token = jwt.sign({ id: req.user.id, zweck: 'abrechnung' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const sicher = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api/abrechnung; HttpOnly; SameSite=Strict; Max-Age=28800${sicher ? '; Secure' : ''}`);
    res.json({ success: true, aktiv: status.aktiv, grund: status.grund, rolle: req.user.role });
  });

  if (!sqlite) {
    app.use('/api/abrechnung', (req, res) => res.status(503).json({ success: false, error: status.grund }));
    return { status, crm: null };
  }

  const DATA_DIR = datenordner();
  fs.mkdirSync(path.join(DATA_DIR, 'abrechnung'), { recursive: true });
  status.datenordner = DATA_DIR;

  // Bestand aus dem Angebotstool holen, bevor die Abrechnung startet (sonst legt sie
  // bei leerer Datenbank erst ihre Standard-Artikel und leere Stammdaten an)
  let konten = null;   // Kundenkonten-Ansicht, wird unten angelegt
  function abgleichen(anlass) {
    try {
      const e = gleicheAb(DATA_DIR, sqlite);
      if (konten) konten.neuLaden();
      if (e) {
        status.abgleich = e;
        console.log(`Abrechnung: Abgleich mit dem Angebotstool (${anlass}) – ${e.neu} neu, ${e.aktualisiert} aktualisiert, ${e.dateien} Dateien, Archiv ${e.archiv}`);
      }
      return e;
    } catch (err) {
      console.error('Abrechnung: Abgleich mit dem Angebotstool fehlgeschlagen:', err.message);
      throw err;
    }
  }
  try { abgleichen('Start'); } catch (_) {}
  if (!status.abgleich) {
    try { status.abgleich = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'abrechnung', '_abgleich-ergebnis.json'), 'utf8')); } catch (_) {}
  }
  try { status.eingespielt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'abrechnung', '_eingespielt.json'), 'utf8')); } catch (_) {}
  // Solange das Tool noch parallel benutzt wird: alle 3 Stunden nachziehen
  setInterval(() => { try { abgleichen('regelmäßig'); } catch (_) {} }, 3 * 60 * 60 * 1000).unref();

  const { bauMandant } = require('./index');
  const mandant = bauMandant(express.Router(), {
    id: 'novaflow', istAdmin: true, email: true, DATA_DIR, backupHandwerker: null, ki,
    basis: path.join(DATA_DIR, 'abrechnung'), buchhaltung: path.join(DATA_DIR, 'Buchhaltung'),
    stammdatenStandard: { marke: 'novaflow' },
    onAngebotStatus: angebotStatusAnCrm,
  });
  status.aktiv = true;
  try { const k = mandant.crm.katalogAktualisieren(); if (k) console.log(`Abrechnung: Artikelkatalog aktualisiert – ${k.neu} neu, ${k.alt} alte auf inaktiv`); }
  catch (e) { console.error('Abrechnung: Katalog aktualisieren:', e.message); }
  // Kundenkonten (Betriebe) aus dem Angebotstool, nur zur Ansicht
  konten = require('./kundenkonten').erstelle(DATA_DIR);

  // API nur für angemeldete Admins; die Seite selbst ist statisch und holt
  // ihre Daten erst nach der Anmeldung. Größere Bodies (Logo, PDF-Anhänge,
  // Wiederherstellung) erst nach der Admin-Prüfung annehmen.
  app.use('/api/abrechnung', nurBerechtigte, adminBereich, express.json({ limit: '50mb' }));
  const SEITE = path.join(__dirname, '..', 'public_html', 'abrechnung.html');
  app.get(['/abrechnung/konten/:slug', '/abrechnung/konten/:slug/:bereich'], (req, res) => res.sendFile(SEITE));
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api/abrechnung/konten/')) return konten.api(req, res, next);
    // Sicherung des Angebotstools (Kundenkonten) landet im Archiv der Kundenkonten,
    // die Abrechnungs-Sicherung (NovaFlow) spielt die Abrechnung selbst ein
    if (p === '/api/abrechnung/wiederherstellen' && req.method === 'POST') {
      const d = (req.body && (req.body.daten || req.body)) || {};
      // Zeitpunkt merken (Startklar-Check: Daten aus dem Tool vorhanden?)
      res.on('finish', () => {
        if (res.statusCode !== 200) return;
        status.eingespielt = { ...(status.eingespielt || {}), [d.tool === 'angebot-tool' ? 'kundenkonten' : 'novaflow']: new Date().toISOString() };
        try { fs.writeFileSync(path.join(DATA_DIR, 'abrechnung', '_eingespielt.json'), JSON.stringify(status.eingespielt)); } catch (_) {}
      });
      if (d.tool === 'angebot-tool') {
        try {
          const z = konten.einspielen(d);
          log(req.user.id, 'abrechnung_einspielen', null, null, { art: 'kundenkonten', ...z }, req.ip).catch(() => {});
          return res.json({ success: true, art: 'kundenkonten', eingespielt: z.kundenkonten + z.angebote + z.rechnungen, uebersprungen: z.vorhanden, ...z });
        } catch (e) { return res.status(500).json({ success: false, error: 'Einspielen fehlgeschlagen: ' + e.message }); }
      }
    }
    if (p.startsWith('/api/abrechnung/') || p === '/abrechnung' || p.startsWith('/abrechnung/')) return mandant.router(req, res, next);
    next();
  });

  // ── Verknüpfung mit Leads & Deals (für das Lead-Panel und den Deal-Dialog) ──
  const crmApi = express.Router();
  crmApi.use(nurBerechtigte);
  async function ladeLead(id) {
    const [[l]] = await db.query('SELECT id, company, ceo, email, phone, location FROM leads WHERE id=?', [id]);
    return l;
  }
  crmApi.get('/lead/:id', async (req, res) => {
    try {
      const lead = await ladeLead(parseInt(req.params.id));
      if (!lead) return res.status(404).json({ success: false, error: 'Lead nicht gefunden' });
      res.json({ success: true, ...mandant.crm.dokumenteFuerLead(lead) });
    }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  crmApi.post('/angebot', express.json(), async (req, res) => {
    try {
      const lead = await ladeLead(parseInt(req.body.leadId));
      if (!lead) return res.status(404).json({ success: false, error: 'Lead nicht gefunden' });
      let deal = null;
      if (req.body.dealId) {
        [[deal]] = await db.query('SELECT id, title, lead_id FROM deals WHERE id=? AND lead_id=?', [parseInt(req.body.dealId), lead.id]);
      }
      // Aus der Bedarfsanalyse vorbefüllen: Paket, Betreuung, Zusätze, Rabatt, Zahlungsart
      let vorlage = {};
      try {
        const bedarf = require('../routes/bedarf');
        const a = await bedarf.analyseLaden(lead.id);
        if (a?.data?.paket_empfohlen) {
          const cfg = await bedarf.regeln();
          const zw = a.data.zahlungswunsch;
          // Positionen mit Katalogartikel verknüpfen (Nummer, Beschreibung, Einheit)
          const NR = { quickwin: ['AP-001', 'BE-001'], s: ['AP-002', 'BE-002'], m: ['AP-003', 'BE-003'], l: ['AP-004', 'BE-004'], software: ['ZU-003', 'BE-006'],
            google: ['ZU-001', null], webseite: ['ZU-002', 'BE-005'], automation: ['ZU-004', null] };
          const mitKatalog = p => {
            const paar = NR[p.key]; const nr = paar && paar[p.abrechnung === 'monatlich' ? 1 : 0];
            const art = nr && mandant.crm.artikel(nr);
            return art ? { ...p, artikelNr: art.nr, titel: art.titel, beschreibung: [p.beschreibung, art.beschreibung].filter(Boolean).join(' · '), einheit: art.einheit, einheitMehrzahl: art.einheitMehrzahl } : p;
          };
          vorlage = {
            positionen: bedarf.R.positionen(a.data, cfg).map(mitKatalog),
            gratismonat: a.data.gratismonat === 'ja',
            zahlung: zw === '5050' ? { art: 'anzahlung', anzahlungProzent: 50 } : /^raten(\d)/.test(zw || '') ? { art: 'raten', anzahl: parseInt(zw.slice(5)), ratenAnzahlung: 50 } : undefined,
          };
        }
      } catch (e) { console.error('Angebot aus Bedarfsanalyse:', e.message); }
      const angebot = mandant.crm.angebotEntwurf({ lead, deal, ...vorlage });
      // Offene Angebots-Anfrage des Closers ist damit in Arbeit
      await db.query("UPDATE reminders SET done_at=NOW() WHERE lead_id=? AND kind='angebot' AND done_at IS NULL", [lead.id]);
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [lead.id, req.user.id, `📄 Angebot ${angebot.nummer} angelegt (Entwurf)`]);
      await log(req.user.id, 'angebot_create', 'lead', lead.id, { nummer: angebot.nummer, deal_id: deal ? deal.id : null }, req.ip);
      res.json({ success: true, angebot: { id: angebot.id, nummer: angebot.nummer } });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });
  // ── Abgleich mit dem Angebotstool: Stand anzeigen / jetzt abgleichen ──
  crmApi.get('/abgleich', (req, res) => {
    res.json({ success: true, abgleich: status.abgleich,
      quelleVorhanden: fs.existsSync(path.join(toolDatenordner(), 'abrechnung', 'abrechnung.sqlite')) });
  });
  crmApi.post('/abgleich', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Nur für Admins.' });
    try {
      const e = abgleichen('von Hand');
      if (!e) return res.status(404).json({ success: false, error: 'Im Angebotstool wurden keine Daten gefunden.' });
      await log(req.user.id, 'abrechnung_abgleich', 'system', null, { neu: e.neu, aktualisiert: e.aktualisiert, konflikte: e.konflikte }, req.ip);
      res.json({ success: true, abgleich: e });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
  // ── Angebote & Rechnungen eines Leads für den betreuenden Closer (nur lesen) ──
  // Auch ohne Berechtigung „Angebote & Rechnungen“: Wer den Lead betreut, sieht,
  // was der Admin dem Kunden angeboten bzw. berechnet hat, und kann die PDFs öffnen.
  const { auth } = require('../middleware/auth');
  async function leadFuerBetreuer(req) {
    const lead = await ladeLead(parseInt(req.params.id));
    if (!lead) return null;
    if (req.user.role === 'admin' || req.user.can_abrechnung || req.user.can_view_all_leads) return lead;
    const [[l]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [lead.id]);
    return l && l.assigned_to === req.user.id ? lead : false;
  }
  app.get('/api/lead-dokumente/:id', auth, async (req, res) => {
    try {
      const lead = await leadFuerBetreuer(req);
      if (lead === null) return res.status(404).json({ error: 'Lead nicht gefunden' });
      if (!lead) return res.status(403).json({ error: 'Kein Zugriff' });
      const d = mandant.crm.dokumenteFuerLead(lead);
      res.json({ angebote: d.angebote, rechnungen: d.rechnungen.filter(r => r.status === 'finalisiert') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/lead-dokumente/:id/:art(angebote|rechnungen)/:doc/pdf', auth, async (req, res, next) => {
    try {
      const lead = await leadFuerBetreuer(req);
      if (!lead) return res.status(lead === null ? 404 : 403).json({ error: 'Kein Zugriff' });
      const d = mandant.crm.dokumenteFuerLead(lead);
      if (!d[req.params.art].some(x => x.id === req.params.doc)) return res.status(404).json({ error: 'Dokument nicht gefunden' });
      req.url = `/api/abrechnung/${req.params.art}/${req.params.doc}/pdf`;
      mandant.router(req, res, next);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Kundenkonten aus dem Angebotstool (nur Admin)
  crmApi.get('/kundenkonten', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Nur für Admins.' });
    try {
      res.json({ success: true, konten: await konten.liste(), abgleich: status.abgleich, ordner: toolDatenordner(),
        gefunden: fs.existsSync(path.join(toolDatenordner(), 'betriebe')) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  app.use('/api/abrechnung-crm', crmApi);

  return { status, crm: mandant.crm };
}

module.exports = { registriere, status };
