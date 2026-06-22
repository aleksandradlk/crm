const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/settings — öffentliche Einstellungen (alle Auth-User)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, value FROM app_settings');
    const obj = {};
    rows.forEach(r => { obj[r.key_name] = r.value; });
    res.json(obj);
  } catch(e) { res.status(500).json({ error: 'Fehler beim Laden der Einstellungen' }); }
});

// PATCH /api/settings/:key — Einstellung setzen (Admin)
router.patch('/:key', auth, adminOnly, async (req, res) => {
  const key   = req.params.key;
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value fehlt' });
  try {
    await db.query(
      'INSERT INTO app_settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
      [key, String(value), String(value)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

module.exports = router;
