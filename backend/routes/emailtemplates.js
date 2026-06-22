const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');

// GET /api/email-templates
// Admin: alle inkl. inaktive; Closer: nur aktive (ohne created_by etc.)
router.get('/', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const [rows] = await db.query(
      isAdmin
        ? 'SELECT * FROM email_templates ORDER BY is_active DESC, name ASC'
        : 'SELECT id, name, subject, body, category FROM email_templates WHERE is_active=1 ORDER BY name ASC'
    );
    res.json(rows);
  } catch(e) { console.error('EmailTemplates GET:', e); res.status(500).json({ error: 'Fehler beim Laden' }); }
});

// POST /api/email-templates — Admin erstellt Vorlage
router.post('/', auth, adminOnly, async (req, res) => {
  const { name, subject, body, category } = req.body;
  if (!name?.trim() || !subject?.trim() || !body?.trim())
    return res.status(400).json({ error: 'Name, Betreff und Text sind erforderlich' });
  try {
    const [r] = await db.query(
      'INSERT INTO email_templates (name, subject, body, category, created_by) VALUES (?,?,?,?,?)',
      [name.trim(), subject.trim(), body.trim(), category?.trim() || null, req.user.id]
    );
    await log(req.user.id, 'email_tmpl_create', 'template', r.insertId, { name: name.trim() }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { console.error('EmailTemplates POST:', e); res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

// PATCH /api/email-templates/:id — Admin bearbeitet/aktiviert/deaktiviert
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, subject, body, category, is_active } = req.body;
  const updates = [];
  const params  = [];
  if (name      !== undefined) { updates.push('name=?');      params.push(name.trim()); }
  if (subject   !== undefined) { updates.push('subject=?');   params.push(subject.trim()); }
  if (body      !== undefined) { updates.push('body=?');      params.push(body.trim()); }
  if (category  !== undefined) { updates.push('category=?');  params.push(category?.trim() || null); }
  if (is_active !== undefined) { updates.push('is_active=?'); params.push(is_active ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
  updates.push('updated_by=?'); params.push(req.user.id);
  params.push(id);
  try {
    await db.query(`UPDATE email_templates SET ${updates.join(',')} WHERE id=?`, params);
    await log(req.user.id, 'email_tmpl_update', 'template', id, { is_active }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('EmailTemplates PATCH:', e); res.status(500).json({ error: 'Fehler beim Aktualisieren' }); }
});

// DELETE /api/email-templates/:id — Admin löscht Vorlage
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[t]] = await db.query('SELECT name FROM email_templates WHERE id=?', [id]);
    if (!t) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
    await db.query('DELETE FROM email_templates WHERE id=?', [id]);
    await log(req.user.id, 'email_tmpl_delete', 'template', id, { name: t.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('EmailTemplates DELETE:', e); res.status(500).json({ error: 'Fehler beim Löschen' }); }
});

module.exports = router;
