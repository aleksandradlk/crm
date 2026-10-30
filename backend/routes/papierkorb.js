// ── Papierkorb (nur Admin): ansehen, wiederherstellen, endgültig löschen ──
const router = require('express').Router();
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const pk = require('../helpers/papierkorb');

router.get('/', auth, adminOnly, async (req, res) => {
  try { res.json(await pk.liste()); }
  catch (e) { console.error('Papierkorb:', e); res.status(500).json({ error: 'Papierkorb konnte nicht geladen werden.' }); }
});
router.post('/:id/wiederherstellen', auth, adminOnly, async (req, res) => {
  try {
    const p = await pk.wiederherstellen(parseInt(req.params.id));
    await log(req.user.id, 'papierkorb_wiederherstellen', p.lead_id ? 'lead' : 'system', p.lead_id || null, { art: p.art, titel: p.titel }, req.ip);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await pk.endgueltig(parseInt(req.params.id));
    await log(req.user.id, 'papierkorb_endgueltig', 'system', null, { id: parseInt(req.params.id) }, req.ip);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
module.exports = router;
