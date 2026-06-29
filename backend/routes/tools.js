const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/tools — alle Tools (alle Auth-User)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tools ORDER BY sort_order, id');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tools — neues Tool (Admin)
router.post('/', auth, adminOnly, async (req, res) => {
  const { name, url, closer_visible } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name und URL sind Pflichtfelder' });
  try {
    const [r] = await db.query(
      'INSERT INTO tools (name, url, closer_visible) VALUES (?, ?, ?)',
      [name.trim(), url.trim(), closer_visible ? 1 : 0]
    );
    res.json({ id: r.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tools/:id — Tool aktualisieren (Admin)
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const { name, url, closer_visible } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name und URL sind Pflichtfelder' });
  try {
    await db.query(
      'UPDATE tools SET name=?, url=?, closer_visible=? WHERE id=?',
      [name.trim(), url.trim(), closer_visible ? 1 : 0, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tools/:id — Tool löschen (Admin)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM tools WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
