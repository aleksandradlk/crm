// ============================================================
// Abrechnung im CRM (Angebote, Rechnungen, Mahnungen, Abos)
// Das Modul stammt aus dem Angebotstool (aleksandradlk/angebot-tool) und
// läuft hier nur mit dem NovaFlow-Bestand, ausschließlich für Admins.
//
// Daten: SQLite-Datei + archivierte PDFs außerhalb des App-Ordners
// (Hostinger baut jede Version in einen frischen Ordner):
//   ABRECHNUNG_DATA_DIR, sonst ~/crm-abrechnung
// Beim ersten Start wird der NovaFlow-Bestand aus dem Angebotstool kopiert
// (~/angebot-tool-daten bzw. ANGEBOT_TOOL_DATA_DIR) – das Tool selbst bleibt
// dabei unverändert.
// ============================================================
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { log } = require('../helpers/logger');

const COOKIE = 'crm_abr';
const status = { aktiv: false, grund: null, datenordner: null, uebernahme: null };

function datenordner() {
  return path.resolve(process.env.ABRECHNUNG_DATA_DIR || path.join(os.homedir(), 'crm-abrechnung'));
}
function toolDatenordner() {
  return path.resolve(process.env.ANGEBOT_TOOL_DATA_DIR || path.join(os.homedir(), 'angebot-tool-daten'));
}

// ── Einmalige Übernahme des NovaFlow-Bestands aus dem Angebotstool ──
// Kopiert Datenbank-Inhalte (Kunden, Artikel, Angebote, Rechnungen, Abos,
// Stammdaten, Nummernkreise) und die archivierten PDFs/Anhänge.
// Läuft nur, solange die CRM-Abrechnung noch leer ist.
function uebernehmeAusTool(ziel, sqlite, { ersetzen = false } = {}) {
  const quelleBasis = path.join(toolDatenordner(), 'abrechnung');
  const quelleDb = path.join(quelleBasis, 'abrechnung.sqlite');
  if (!fs.existsSync(quelleDb)) return null;
  const quelle = new sqlite.DatabaseSync(quelleDb, { readOnly: true });
  try {
    const dokumente = quelle.prepare('SELECT sammlung, id, json, geaendert FROM dokumente').all();
    const einstellungen = quelle.prepare('SELECT schluessel, json, geaendert FROM einstellungen').all();
    const zielDb = new sqlite.DatabaseSync(path.join(ziel, 'abrechnung', 'abrechnung.sqlite'));
    try {
      zielDb.exec('BEGIN IMMEDIATE');
      // Erneute Übernahme: bisherigen (unveränderten) Stand vollständig ersetzen
      if (ersetzen) { zielDb.exec('DELETE FROM dokumente'); zielDb.exec('DELETE FROM einstellungen'); }
      const d = zielDb.prepare('INSERT OR REPLACE INTO dokumente (sammlung, id, json, geaendert) VALUES (?, ?, ?, ?)');
      dokumente.forEach(r => d.run(r.sammlung, r.id, r.json, r.geaendert));
      const e = zielDb.prepare('INSERT OR REPLACE INTO einstellungen (schluessel, json, geaendert) VALUES (?, ?, ?)');
      einstellungen.forEach(r => e.run(r.schluessel, r.json, r.geaendert));
      zielDb.exec('COMMIT');
    } catch (err) {
      zielDb.exec('ROLLBACK');
      throw err;
    } finally {
      zielDb.close();
    }
    // Archivierte PDFs (Pfade sind relativ zum Datenordner gespeichert) und Anhänge
    const kopiere = (von, nach) => { if (fs.existsSync(von)) fs.cpSync(von, nach, { recursive: true, force: false, errorOnExist: false }); };
    kopiere(path.join(toolDatenordner(), 'Buchhaltung'), path.join(ziel, 'Buchhaltung'));
    kopiere(path.join(quelleBasis, 'anhaenge'), path.join(ziel, 'abrechnung', 'anhaenge'));
    const anzahl = s => dokumente.filter(r => r.sammlung === s).length;
    return {
      von: quelleDb, am: new Date().toISOString(),
      kunden: anzahl('kunden'), angebote: anzahl('angebote'), rechnungen: anzahl('rechnungen'), abos: anzahl('abos'),
    };
  } finally {
    quelle.close();
  }
}

// ── Anmeldung: CRM-Token (Header) oder kurzlebiges Cookie für Downloads ──
// PDFs, ZIP- und CSV-Exporte werden als normale Links geöffnet und können
// keinen Authorization-Header mitschicken – dafür setzt die Seite beim Laden
// ein eigenes, nur für /api/abrechnung gültiges Cookie.
async function ladeAdmin(id) {
  const [[u]] = await db.query('SELECT id, role, is_active, full_name FROM users WHERE id=?', [id]);
  return u && u.is_active && u.role === 'admin' ? u : null;
}
function cookieWert(req) {
  for (const teil of String(req.headers.cookie || '').split(';')) {
    const i = teil.indexOf('=');
    if (i > -1 && teil.slice(0, i).trim() === COOKIE) return decodeURIComponent(teil.slice(i + 1).trim());
  }
  return null;
}
async function nurAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : cookieWert(req);
    if (!token) return res.status(401).json({ success: false, error: 'Bitte zuerst im CRM anmelden.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await ladeAdmin(payload.id);
    if (!user) return res.status(403).json({ success: false, error: 'Nur für Admins.' });
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
    await markWon(deal, deal.owner_id || deal.created_by, wert || undefined);
    await log(deal.owner_id || deal.created_by, 'deal_won', 'lead', deal.lead_id, { deal_id: deal.id, angebot: a.nummer }, null);
  } else if (a.status === 'abgelehnt' && deal.status === 'open') {
    await markLost(deal, deal.owner_id || deal.created_by, `Angebot ${a.nummer} abgelehnt`);
  } else if (a.status === 'versendet' && deal.status === 'open') {
    // In die Phase „Angebot gesendet“ schieben, falls es sie gibt und der Deal davor steht
    const [[st]] = await db.query("SELECT id, sort_order FROM deal_stages WHERE is_active=1 AND name LIKE 'Angebot%' ORDER BY sort_order LIMIT 1");
    const [[cur]] = await db.query('SELECT sort_order FROM deal_stages WHERE id=?', [deal.stage_id]);
    if (st && (!cur || cur.sort_order < st.sort_order)) {
      await db.query('UPDATE deals SET stage_id=?, stage_changed_at=NOW(), value=IF(value=0, ?, value) WHERE id=?', [st.id, wert, deal.id]);
    }
    await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [deal.lead_id, deal.owner_id || deal.created_by, `📄 Angebot ${a.nummer} versendet`]);
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
  app.post('/api/abrechnung-sitzung', express.json(), nurAdmin, (req, res) => {
    const token = jwt.sign({ id: req.user.id, zweck: 'abrechnung' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const sicher = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api/abrechnung; HttpOnly; SameSite=Strict; Max-Age=28800${sicher ? '; Secure' : ''}`);
    res.json({ success: true, aktiv: status.aktiv, grund: status.grund, uebernahme: status.uebernahme });
  });

  if (!sqlite) {
    app.use('/api/abrechnung', (req, res) => res.status(503).json({ success: false, error: status.grund }));
    return { status, crm: null };
  }

  const DATA_DIR = datenordner();
  fs.mkdirSync(path.join(DATA_DIR, 'abrechnung'), { recursive: true });
  status.datenordner = DATA_DIR;

  // Datenbank anlegen (leer) und ggf. Bestand aus dem Angebotstool übernehmen
  const datenbank = require('./db');
  const probe = datenbank.oeffne(path.join(DATA_DIR, 'abrechnung'));
  const leer = probe.leer();
  probe.schliesse();
  if (leer) {
    try {
      const u = uebernehmeAusTool(DATA_DIR, sqlite);
      if (u) {
        fs.writeFileSync(path.join(DATA_DIR, 'abrechnung', '_uebernahme.json'), JSON.stringify(u, null, 2));
        console.log(`Abrechnung: aus dem Angebotstool übernommen – ${u.kunden} Kunden, ${u.angebote} Angebote, ${u.rechnungen} Rechnungen, ${u.abos} Abos`);
      }
    } catch (e) {
      console.error('Abrechnung: Übernahme aus dem Angebotstool fehlgeschlagen:', e.message);
    }
  }
  try { status.uebernahme = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'abrechnung', '_uebernahme.json'), 'utf8')); } catch (_) {}

  const { bauMandant } = require('./index');
  const mandant = bauMandant(express.Router(), {
    id: 'novaflow', istAdmin: true, email: true, DATA_DIR, backupHandwerker: null, ki,
    basis: path.join(DATA_DIR, 'abrechnung'), buchhaltung: path.join(DATA_DIR, 'Buchhaltung'),
    stammdatenStandard: { marke: 'novaflow' },
    onAngebotStatus: angebotStatusAnCrm,
  });
  status.aktiv = true;

  // API nur für angemeldete Admins; die Seite selbst ist statisch und holt
  // ihre Daten erst nach der Anmeldung. Größere Bodies (Logo, PDF-Anhänge,
  // Wiederherstellung) erst nach der Admin-Prüfung annehmen.
  app.use('/api/abrechnung', nurAdmin, express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api/abrechnung/') || p === '/abrechnung' || p.startsWith('/abrechnung/')) return mandant.router(req, res, next);
    next();
  });

  // ── Verknüpfung mit Leads & Deals (für das Lead-Panel und den Deal-Dialog) ──
  const crmApi = express.Router();
  crmApi.use(nurAdmin);
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
      const angebot = mandant.crm.angebotEntwurf({ lead, deal });
      await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
        [lead.id, req.user.id, `📄 Angebot ${angebot.nummer} angelegt (Entwurf)`]);
      await log(req.user.id, 'angebot_create', 'lead', lead.id, { nummer: angebot.nummer, deal_id: deal ? deal.id : null }, req.ip);
      res.json({ success: true, angebot: { id: angebot.id, nummer: angebot.nummer } });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });
  // ── Übernahme aus dem Angebotstool: Stand anzeigen / erneut übernehmen ──
  // Erneut übernehmen geht nur, solange im CRM seit der Übernahme nichts an der
  // Abrechnung geändert wurde – so kann nichts überschrieben werden.
  function erneutMoeglich() {
    if (!status.uebernahme) return false;
    const pruef = new sqlite.DatabaseSync(path.join(DATA_DIR, 'abrechnung', 'abrechnung.sqlite'), { readOnly: true });
    try {
      const [a] = pruef.prepare('SELECT MAX(geaendert) AS m FROM dokumente').all();
      const [b] = pruef.prepare('SELECT MAX(geaendert) AS m FROM einstellungen').all();
      const zuletzt = [a && a.m, b && b.m].filter(Boolean).sort().pop() || '';
      return zuletzt <= status.uebernahme.am;
    } finally { pruef.close(); }
  }
  crmApi.get('/uebernahme', (req, res) => {
    res.json({ success: true, uebernahme: status.uebernahme,
      quelleVorhanden: fs.existsSync(path.join(toolDatenordner(), 'abrechnung', 'abrechnung.sqlite')), erneutMoeglich: erneutMoeglich() });
  });
  crmApi.post('/uebernahme', async (req, res) => {
    try {
      if (!erneutMoeglich()) return res.status(409).json({ success: false, error: 'Im CRM wurde die Abrechnung seit der Übernahme bereits geändert – eine erneute Übernahme würde das überschreiben.' });
      const u = uebernehmeAusTool(DATA_DIR, sqlite, { ersetzen: true });
      if (!u) return res.status(404).json({ success: false, error: 'Im Angebotstool wurden keine Daten gefunden.' });
      fs.writeFileSync(path.join(DATA_DIR, 'abrechnung', '_uebernahme.json'), JSON.stringify(u, null, 2));
      status.uebernahme = u;
      await log(req.user.id, 'abrechnung_uebernahme', 'system', null, u, req.ip);
      res.json({ success: true, uebernahme: u });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
  app.use('/api/abrechnung-crm', crmApi);

  return { status, crm: mandant.crm };
}

module.exports = { registriere, status };
