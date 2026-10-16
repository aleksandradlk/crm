// Angebote & Umsatz aus dem Angebotstool – pro Lead und als Übersicht
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const tool   = require('../helpers/angebotTool');

function canView(user, lead) {
  if (user.role === 'admin') return true;
  if (user.can_view_all_leads) return true;
  return lead.assigned_to === user.id || lead.assigned_to === null;
}

function notConfigured(res) {
  return res.json({ enabled: false });
}

async function loadLead(req, res) {
  const id = parseInt(req.params.id);
  const [[lead]] = await db.query(
    'SELECT id, company, ceo, email, phone, location, assigned_to FROM leads WHERE id=? AND archived_at IS NULL', [id]
  );
  if (!lead) { res.status(404).json({ error: 'Lead nicht gefunden' }); return null; }
  if (!canView(req.user, lead)) { res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' }); return null; }
  return lead;
}

// Links ins Tool nur für Admins – Closer haben dort kein Konto
function linksFor(user, links) {
  return user.role === 'admin' ? (links || null) : null;
}

// ── GET /api/angebote/status ─────────────────────────────────
router.get('/status', auth, (req, res) => {
  res.json({ enabled: tool.isConfigured(), url: req.user.role === 'admin' ? tool.toolUrl() || null : null });
});

// ── GET /api/angebote/lead/:id — Kunde, Angebote, Rechnungen, Werte ──
router.get('/lead/:id', auth, async (req, res) => {
  if (!tool.isConfigured()) return notConfigured(res);
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    const d = await tool.kundeZuLead(lead);
    res.json({ enabled: true, kunde: d.kunde || null, links: linksFor(req.user, d.links) });
  } catch (e) {
    console.error('Angebotstool lead error:', e.message);
    res.status(502).json({ enabled: true, error: `Angebotstool nicht erreichbar: ${e.message}` });
  }
});

// ── POST /api/angebote/lead/:id/kunde — Lead als Kunden ins Angebotstool übernehmen ──
router.post('/lead/:id/kunde', auth, adminOnly, async (req, res) => {
  if (!tool.isConfigured()) return res.status(503).json({ error: 'Angebotstool ist nicht verbunden' });
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    const d = await tool.leadUebernehmen(lead);
    await log(req.user.id, d.neu ? 'angebotstool_kunde_angelegt' : 'angebotstool_kunde_verknuepft', 'lead', lead.id,
      { kunde: d.kunde && d.kunde.nummer }, req.ip);
    res.json({ enabled: true, neu: d.neu, kunde: d.kunde, links: linksFor(req.user, d.links) });
  } catch (e) {
    console.error('Angebotstool übernahme error:', e.message);
    res.status(502).json({ error: `Übernahme fehlgeschlagen: ${e.message}` });
  }
});

// Leads zu den Kunden des Tools laden (nur die, die der User sehen darf)
async function leadsFuerKunden(user, kunden) {
  const ids    = [...new Set(kunden.map(k => parseInt(k.crmLeadId)).filter(Boolean))];
  const emails = [...new Set(kunden.map(k => String(k.email || '').trim().toLowerCase()).filter(Boolean))];
  if (!ids.length && !emails.length) return [];
  const or = [];
  const params = [];
  if (ids.length)    { or.push('l.id IN (?)'); params.push(ids); }
  if (emails.length) { or.push('LOWER(l.email) IN (?)'); params.push(emails); }
  let q = `SELECT l.id, l.company, l.email, l.status, l.assigned_to, u.full_name AS assigned_name
           FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
           WHERE l.archived_at IS NULL AND (${or.join(' OR ')})`;
  if (user.role !== 'admin' && !user.can_view_all_leads) {
    q += ' AND (l.assigned_to = ? OR l.assigned_to IS NULL)';
    params.push(user.id);
  }
  const [rows] = await db.query(q, params);
  return rows;
}

function summe(liste) {
  const s = { angeboteOffen: 0, angeboteOffenMonatlich: 0, umsatzBezahlt: 0, offenerBetrag: 0, ueberfaellig: 0, monatlich: 0, umsatzGesamt: 0 };
  liste.forEach(w => Object.keys(s).forEach(k => { s[k] += Number(w[k]) || 0; }));
  Object.keys(s).forEach(k => { s[k] = Math.round(s[k] * 100) / 100; });
  return s;
}

// ── GET /api/angebote/werte — Wert je Lead (für Listen und Pipeline) ──
router.get('/werte', auth, async (req, res) => {
  if (!tool.isConfigured()) return notConfigured(res);
  try {
    const kunden = await tool.alleKunden();
    const leads  = await leadsFuerKunden(req.user, kunden);
    const map    = tool.werteJeLead(kunden, leads);
    const werte  = {};
    map.forEach((w, leadId) => { werte[leadId] = w; });
    res.json({ enabled: true, werte, summe: summe([...map.values()]) });
  } catch (e) {
    console.error('Angebotstool werte error:', e.message);
    res.status(502).json({ enabled: true, error: `Angebotstool nicht erreichbar: ${e.message}` });
  }
});

// ── GET /api/angebote/uebersicht — alle Kunden mit Wert und zugehörigem Lead (Admin) ──
router.get('/uebersicht', auth, adminOnly, async (req, res) => {
  if (!tool.isConfigured()) return notConfigured(res);
  try {
    const kunden = await tool.alleKunden({ frisch: req.query.frisch === '1' });
    const leads  = await leadsFuerKunden(req.user, kunden);
    const map    = tool.werteJeLead(kunden, leads);
    const leadByKundeNr = new Map();
    map.forEach((w, leadId) => leadByKundeNr.set(w.kunde_nr, leads.find(l => l.id === leadId)));
    const rows = kunden.map(k => {
      const l = leadByKundeNr.get(k.nummer) || null;
      return {
        kunde_nr: k.nummer, firma: k.firma, ansprechpartner: k.ansprechpartner, email: k.email,
        werte: k.werte,
        lead: l ? { id: l.id, company: l.company, status: l.status, assigned_name: l.assigned_name } : null,
      };
    }).sort((a, b) => (b.werte.umsatzGesamt + b.werte.angeboteOffen) - (a.werte.umsatzGesamt + a.werte.angeboteOffen));
    res.json({ enabled: true, kunden: rows, summe: summe(kunden.map(k => k.werte)), url: tool.toolUrl() });
  } catch (e) {
    console.error('Angebotstool übersicht error:', e.message);
    res.status(502).json({ enabled: true, error: `Angebotstool nicht erreichbar: ${e.message}` });
  }
});

module.exports = router;
