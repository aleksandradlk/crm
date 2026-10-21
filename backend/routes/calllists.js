// ── Wähllisten: gespeicherte Filter, die direkt im Anrufmodus abtelefoniert werden ──
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { buildQueue, cleanFilters } = require('../helpers/queue');

function parse(row) {
  let filters = {};
  try { filters = JSON.parse(row.filters || '{}'); } catch (_) {}
  return { ...row, filters, shared: !!row.shared };
}

async function loadVisible(user, id) {
  const [[row]] = await db.query(
    'SELECT * FROM call_lists WHERE id=? AND (user_id=? OR shared=1)', [id, user.id]);
  return row ? parse(row) : null;
}

// Eigene + vom Team geteilte Listen, jeweils mit Anzahl anrufbarer Leads
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.*, u.full_name AS owner_name FROM call_lists c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.user_id = ? OR c.shared = 1 ORDER BY c.user_id = ? DESC, c.name`, [req.user.id, req.user.id]);
    const lists = [];
    for (const r of rows.map(parse)) {
      const q = await buildQueue(req.user, r.filters);
      lists.push({ ...r, count: q.leads.length, mine: r.user_id === req.user.id });
    }
    res.json(lists);
  } catch (e) {
    console.error('Call lists error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// Vorschau beim Bearbeiten: wie viele Leads und welche?
router.post('/preview', auth, async (req, res) => {
  try {
    const q = await buildQueue(req.user, req.body.filters || {});
    res.json({ count: q.leads.length, without_phone: q.without_phone, sample: q.leads.slice(0, 8) });
  } catch (e) {
    console.error('Call list preview error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

router.post('/', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Bitte einen Namen angeben' });
  const shared = req.user.role === 'admin' && !!req.body.shared;
  const [r] = await db.query('INSERT INTO call_lists (user_id, name, filters, shared) VALUES (?,?,?,?)',
    [req.user.id, name, JSON.stringify(cleanFilters(req.body.filters)), shared ? 1 : 0]);
  res.status(201).json({ ok: true, id: r.insertId });
});

router.patch('/:id', auth, async (req, res) => {
  const [[row]] = await db.query('SELECT * FROM call_lists WHERE id=?', [parseInt(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Liste nicht gefunden' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Nur eigene Listen bearbeitbar' });
  const updates = [], params = [];
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen angeben' });
    updates.push('name=?'); params.push(name);
  }
  if (req.body.filters !== undefined) { updates.push('filters=?'); params.push(JSON.stringify(cleanFilters(req.body.filters))); }
  if (req.body.shared !== undefined && req.user.role === 'admin') { updates.push('shared=?'); params.push(req.body.shared ? 1 : 0); }
  if (!updates.length) return res.json({ ok: true });
  params.push(row.id);
  await db.query(`UPDATE call_lists SET ${updates.join(',')} WHERE id=?`, params);
  res.json({ ok: true });
});

router.delete('/:id', auth, async (req, res) => {
  const [[row]] = await db.query('SELECT * FROM call_lists WHERE id=?', [parseInt(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Liste nicht gefunden' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Nur eigene Listen löschbar' });
  await db.query('DELETE FROM call_lists WHERE id=?', [row.id]);
  res.json({ ok: true });
});

module.exports = router;
module.exports.loadVisible = loadVisible;
