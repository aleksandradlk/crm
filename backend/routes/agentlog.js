const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const AGENTS = ['Recherche', 'Content', 'Kundenservice', 'Buchhaltung'];

// POST /api/agent-log — Eintrag durch Claude Code (kein CRM-User, geschützt per Shared-Key)
router.post('/', async (req, res) => {
  const key = req.headers['x-agent-key'];
  if (!process.env.AGENT_LOG_KEY || key !== process.env.AGENT_LOG_KEY) {
    return res.status(401).json({ error: 'Ungültiger Agent-Key' });
  }
  const { agent, action, detail, status } = req.body;
  if (!agent || !AGENTS.includes(agent)) return res.status(400).json({ error: `agent muss einer von: ${AGENTS.join(', ')} sein` });
  if (!action) return res.status(400).json({ error: 'action fehlt' });
  const validStatus = ['ok', 'error', 'pending'].includes(status) ? status : 'ok';
  try {
    const [r] = await db.query(
      'INSERT INTO agent_log (agent, action, detail, status) VALUES (?,?,?,?)',
      [agent, action, detail || null, validStatus]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

// GET /api/agent-log — letzte Einträge (alle eingeloggten CRM-User)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, agent, action, detail, status, created_at FROM agent_log ORDER BY created_at DESC LIMIT 100'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Fehler beim Laden' }); }
});

// PATCH /api/agent-log/:id/approve — Vorschlag freigeben (Admin)
router.patch('/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const [r] = await db.query("UPDATE agent_log SET status='ok' WHERE id=? AND status='pending'", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Kein wartender Eintrag gefunden' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Freigeben' }); }
});

// PATCH /api/agent-log/:id/reject — Vorschlag ablehnen (Admin)
router.patch('/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const [r] = await db.query("UPDATE agent_log SET status='rejected' WHERE id=? AND status='pending'", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Kein wartender Eintrag gefunden' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Ablehnen' }); }
});

module.exports = router;
