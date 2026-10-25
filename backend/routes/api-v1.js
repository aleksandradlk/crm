// ============================================================
// Öffentliche Schnittstelle des CRM: /api/v1 (für Airtable, Make, n8n, Zapier …)
// Anmeldung mit API-Schlüssel (Admin legt ihn unter Integrationen an):
//   Authorization: Bearer nf_…   oder   X-API-Key: nf_…
// Der Schlüssel handelt im Namen des Admins, der ihn angelegt hat.
// Verwaltung der Schlüssel: /api/api-keys (nur Admin, mit CRM-Anmeldung).
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { findDuplicates, refreshNorm } = require('../helpers/dedupe');

const hash = k => crypto.createHash('sha256').update(k).digest('hex');
const LEAD_STATUS = ['neu', 'kontaktiert', 'nicht_erreicht', 'kein_interesse', 'rueckruf', 'kunde'];
const LEAD_FELDER = ['company', 'ceo', 'email', 'phone', 'location', 'website', 'industry', 'employees', 'revenue', 'notes', 'linkedin_url'];

// ── Schlüsselverwaltung (CRM-Oberfläche, nur Admin) ──────────
const keys = express.Router();
keys.get('/', auth, adminOnly, async (req, res) => {
  const [rows] = await db.query(
    `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.full_name AS created_by_name
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NULL DESC, k.created_at DESC`);
  res.json(rows);
});
keys.post('/', auth, adminOnly, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100) || 'Schnittstelle';
  const key = 'nf_' + crypto.randomBytes(24).toString('base64url');
  const [r] = await db.query('INSERT INTO api_keys (name, prefix, key_hash, created_by) VALUES (?,?,?,?)',
    [name, key.slice(0, 10), hash(key), req.user.id]);
  await log(req.user.id, 'api_key_create', 'system', r.insertId, { name }, req.ip);
  // Der Schlüssel wird nur dieses eine Mal im Klartext gezeigt
  res.status(201).json({ id: r.insertId, name, key });
});
keys.delete('/:id', auth, adminOnly, async (req, res) => {
  await db.query('UPDATE api_keys SET revoked_at=NOW() WHERE id=? AND revoked_at IS NULL', [parseInt(req.params.id)]);
  await log(req.user.id, 'api_key_revoke', 'system', parseInt(req.params.id), null, req.ip);
  res.json({ ok: true });
});

// ── Anmeldung per Schlüssel + einfache Begrenzung (120 Anfragen/Minute) ──
const zaehler = new Map();
async function apiKeyAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const key = (h.startsWith('Bearer ') ? h.slice(7) : req.get('x-api-key') || '').trim();
  if (!key.startsWith('nf_')) return res.status(401).json({ error: 'API-Schlüssel fehlt (Authorization: Bearer nf_…)' });
  const [[k]] = await db.query(
    `SELECT k.id, k.created_by, u.id AS uid, u.full_name, u.role, u.is_active
     FROM api_keys k JOIN users u ON u.id = k.created_by WHERE k.key_hash=? AND k.revoked_at IS NULL`, [hash(key)]);
  if (!k || !k.is_active || k.role !== 'admin') return res.status(401).json({ error: 'API-Schlüssel ungültig oder widerrufen' });
  const min = Math.floor(Date.now() / 60000);
  const z = zaehler.get(k.id);
  const n = z && z.min === min ? z.n + 1 : 1;
  zaehler.set(k.id, { min, n });
  if (n > 120) return res.status(429).json({ error: 'Zu viele Anfragen – höchstens 120 pro Minute' });
  if (n === 1) db.query('UPDATE api_keys SET last_used_at=NOW() WHERE id=?', [k.id]).catch(() => {});
  req.user = { id: k.uid, full_name: k.full_name, role: 'admin' };
  req.apiKeyId = k.id;
  next();
}

// ── Endpunkte ────────────────────────────────────────────────
const v1 = express.Router();
v1.use(express.json({ limit: '1mb' }), apiKeyAuth);
const fehler = (res, e) => { console.error('API v1:', e); res.status(500).json({ error: 'Interner Fehler' }); };
const zahl = (v, std, max) => Math.max(0, Math.min(max, parseInt(v) || std));

const LEAD_SELECT = `SELECT l.id, l.company, l.ceo, l.email, l.phone, l.location, l.website, l.industry, l.employees, l.revenue,
  l.linkedin_url, l.notes, l.status, l.source, l.assigned_to, u.full_name AS assigned_name, l.created_at, l.updated_at, l.archived_at
  FROM leads l LEFT JOIN users u ON u.id = l.assigned_to`;

v1.get('/', (req, res) => res.json({ ok: true, version: 1, user: req.user.full_name }));

v1.get('/leads', async (req, res) => {
  try {
    const where = [], p = [];
    if (req.query.archived !== 'true') where.push('l.archived_at IS NULL');
    if (req.query.status) { where.push('l.status=?'); p.push(String(req.query.status)); }
    if (req.query.assigned_to) { where.push('l.assigned_to=?'); p.push(parseInt(req.query.assigned_to)); }
    if (req.query.updated_since) { where.push('l.updated_at >= ?'); p.push(new Date(req.query.updated_since)); }
    if (req.query.q) { where.push('(l.company LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
    const limit = zahl(req.query.limit, 100, 500), offset = zahl(req.query.offset, 0, 1e9);
    const [rows] = await db.query(`${LEAD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.updated_at DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
    res.json({ data: rows, limit, offset });
  } catch (e) { fehler(res, e); }
});

v1.get('/leads/:id', async (req, res) => {
  try {
    const [[l]] = await db.query(`${LEAD_SELECT} WHERE l.id=?`, [parseInt(req.params.id)]);
    if (!l) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const [deals] = await db.query('SELECT d.id, d.title, d.value, d.status, s.name AS stage FROM deals d LEFT JOIN deal_stages s ON s.id=d.stage_id WHERE d.lead_id=?', [l.id]);
    res.json({ ...l, deals });
  } catch (e) { fehler(res, e); }
});

v1.post('/leads', async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.company || '').trim()) return res.status(400).json({ error: 'company ist erforderlich' });
    if (!b.allow_duplicate) {
      const d = await findDuplicates({ phone: b.phone, email: b.email, website: b.website });
      if (d.length) return res.status(409).json({ error: 'Lead existiert vermutlich schon', duplicate_id: d[0].id, matched_on: d[0].matched_on });
    }
    const status = LEAD_STATUS.includes(b.status) ? b.status : 'neu';
    const werte = LEAD_FELDER.map(f => b[f] == null || b[f] === '' ? null : String(b[f]).slice(0, f === 'notes' ? 5000 : 255));
    const [r] = await db.query(
      `INSERT INTO leads (${LEAD_FELDER.join(', ')}, status, assigned_to, created_by, source, confidence) VALUES (${LEAD_FELDER.map(() => '?').join(',')},?,?,?,?,?)`,
      [...werte, status, parseInt(b.assigned_to) || null, req.user.id, String(b.source || 'api').slice(0, 50), 80]);
    await refreshNorm(r.insertId);
    await log(req.user.id, 'lead_create_api', 'lead', r.insertId, { company: b.company, key: req.apiKeyId }, req.ip);
    res.status(201).json({ id: r.insertId });
  } catch (e) { fehler(res, e); }
});

v1.patch('/leads/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const sets = [], p = [];
    for (const f of LEAD_FELDER) if (b[f] !== undefined) { sets.push(`${f}=?`); p.push(b[f] === null || b[f] === '' ? null : String(b[f]).slice(0, f === 'notes' ? 5000 : 255)); }
    if (b.status !== undefined) { if (!LEAD_STATUS.includes(b.status)) return res.status(400).json({ error: 'Ungültiger Status', erlaubt: LEAD_STATUS }); sets.push('status=?'); p.push(b.status); }
    if (b.assigned_to !== undefined) { sets.push('assigned_to=?'); p.push(parseInt(b.assigned_to) || null); }
    if (!sets.length) return res.status(400).json({ error: 'Nichts zu ändern' });
    const [[vorher]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [id]);
    const [r] = await db.query(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`, [...p, id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (b.assigned_to !== undefined) await require('../helpers/sichtbarkeit').uebergeben(id, vorher && vorher.assigned_to, parseInt(b.assigned_to) || null);
    await refreshNorm(id);
    await log(req.user.id, 'lead_update_api', 'lead', id, { felder: Object.keys(b), key: req.apiKeyId }, req.ip);
    res.json({ ok: true });
  } catch (e) { fehler(res, e); }
});

v1.post('/leads/:id/notes', async (req, res) => {
  try {
    const text = String((req.body || {}).text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: 'text fehlt' });
    const [[l]] = await db.query('SELECT id FROM leads WHERE id=?', [parseInt(req.params.id)]);
    if (!l) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const [r] = await db.query('INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)', [l.id, req.user.id, text]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { fehler(res, e); }
});

v1.get('/deals', async (req, res) => {
  try {
    const where = [], p = [];
    if (req.query.status && req.query.status !== 'all') { where.push('d.status=?'); p.push(String(req.query.status)); }
    if (req.query.lead_id) { where.push('d.lead_id=?'); p.push(parseInt(req.query.lead_id)); }
    const limit = zahl(req.query.limit, 100, 500), offset = zahl(req.query.offset, 0, 1e9);
    const [rows] = await db.query(
      `SELECT d.id, d.lead_id, l.company, d.title, d.value, d.status, s.name AS stage, d.owner_id, u.full_name AS owner_name,
              d.expected_close_date, d.won_at, d.lost_at, d.lost_reason, d.created_at, d.stage_changed_at
       FROM deals d JOIN leads l ON l.id = d.lead_id LEFT JOIN deal_stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
    res.json({ data: rows, limit, offset });
  } catch (e) { fehler(res, e); }
});

v1.post('/deals', async (req, res) => {
  try {
    const { createDeal, parseValue } = require('./deals');
    const b = req.body || {};
    const leadId = parseInt(b.lead_id);
    const [[lead]] = await db.query('SELECT id, company, assigned_to FROM leads WHERE id=?', [leadId]);
    if (!lead) return res.status(400).json({ error: 'lead_id fehlt oder ist unbekannt' });
    let stageId = null;
    if (b.stage) { const [[s]] = await db.query('SELECT id FROM deal_stages WHERE is_active=1 AND (id=? OR name=?)', [parseInt(b.stage) || 0, String(b.stage)]); stageId = s ? s.id : null; }
    const value = parseValue(b.value);
    const id = await createDeal({ leadId, userId: req.user.id, title: String(b.title || '').trim() || lead.company,
      value: Number.isNaN(value) ? 0 : (value || 0), stageId, ownerId: parseInt(b.owner_id) || lead.assigned_to || null, expectedClose: b.expected_close_date || null });
    res.status(201).json({ id });
  } catch (e) { fehler(res, e); }
});

v1.get('/stages', async (req, res) => {
  const [rows] = await db.query('SELECT id, name, probability, sort_order FROM deal_stages WHERE is_active=1 ORDER BY sort_order');
  res.json({ data: rows });
});

v1.get('/users', async (req, res) => {
  const [rows] = await db.query('SELECT id, full_name, role, is_active FROM users ORDER BY full_name');
  res.json({ data: rows });
});

v1.get('/calls', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 864e5);
    const limit = zahl(req.query.limit, 200, 1000);
    const [rows] = await db.query(
      `SELECT c.id, c.lead_id, l.company, c.user_id, u.full_name AS user_name, c.phone_number, c.direction, c.status,
              c.duration_seconds, c.started_at, c.ended_at
       FROM call_logs c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.started_at >= ? ORDER BY c.started_at DESC LIMIT ?`, [since, limit]);
    res.json({ data: rows });
  } catch (e) { fehler(res, e); }
});

v1.use((req, res) => res.status(404).json({ error: 'Unbekannter Endpunkt' }));

module.exports = { keys, v1 };
