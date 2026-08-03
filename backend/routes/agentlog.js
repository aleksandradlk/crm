const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const canva  = require('../helpers/canva');

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

// POST /api/agent-log/manual — Eintrag durch eingeloggten CRM-User selbst
router.post('/manual', auth, async (req, res) => {
  const { agent, action, detail, status } = req.body;
  if (!agent || !AGENTS.includes(agent)) return res.status(400).json({ error: `agent muss einer von: ${AGENTS.join(', ')} sein` });
  if (!action) return res.status(400).json({ error: 'action fehlt' });
  const validStatus = ['ok', 'pending'].includes(status) ? status : 'ok';
  try {
    const [r] = await db.query(
      'INSERT INTO agent_log (agent, action, detail, status, created_by) VALUES (?,?,?,?,?)',
      [agent, action, detail || null, validStatus, req.user.id]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

// GET /api/agent-log/diag — Diagnose-Abfrage für Claude Code (Agent-Key statt CRM-Login)
router.get('/diag', async (req, res) => {
  const key = req.headers['x-agent-key'];
  if (!process.env.AGENT_LOG_KEY || key !== process.env.AGENT_LOG_KEY) {
    return res.status(401).json({ error: 'Ungültiger Agent-Key' });
  }
  try {
    const [rows] = await db.query(
      'SELECT id, agent, action, status, created_at FROM agent_log ORDER BY created_at DESC LIMIT 20'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Fehler beim Laden' }); }
});

// GET /api/agent-log — letzte Einträge (alle eingeloggten CRM-User)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT al.id, al.agent, al.action, al.detail, al.status, al.created_at, u.full_name AS created_by_name
       FROM agent_log al LEFT JOIN users u ON u.id = al.created_by
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Fehler beim Laden' }); }
});

// PATCH /api/agent-log/:id/approve — Vorschlag freigeben (Admin)
// Bei Content-Einträgen wird zusätzlich ein Canva-Design aus der hinterlegten Vorlage erstellt.
router.patch('/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const [[entry]] = await db.query("SELECT * FROM agent_log WHERE id=? AND status='pending'", [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Kein wartender Eintrag gefunden' });

    let designUrl = null;
    let designError = null;
    if (entry.agent === 'Content') {
      try {
        const [[setting]] = await db.query("SELECT value FROM app_settings WHERE key_name='canva_brand_template_id'");
        if (!setting) throw new Error('Keine Canva-Vorlage ausgewählt (Einstellungen → Canva)');
        const design = await canva.createDesignFromTemplate(setting.value, entry.action, entry.detail);
        designUrl = design.urls?.edit_url || design.url || null;
      } catch (e) { designError = e.message; }
    }

    await db.query(
      'UPDATE agent_log SET status=?, design_url=? WHERE id=?',
      [designError ? 'error' : 'ok', designUrl, req.params.id]
    );
    res.json({ ok: true, designUrl, designError });
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
