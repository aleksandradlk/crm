const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'wiki');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.txt'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Nur PDF, Bilder, Word, Excel und TXT erlaubt'));
  }
});

// GET /api/wiki/files
router.get('/files', auth, async (req, res) => {
  try {
    const [files] = await db.query(
      `SELECT f.*, u.full_name AS uploaded_by_name
       FROM wiki_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       ORDER BY f.category, f.created_at DESC`
    );
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/wiki/files (admin)
router.post('/files', auth, adminOnly, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { name, category } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  if (!category) return res.status(400).json({ error: 'Kategorie fehlt' });
  try {
    const [r] = await db.query(
      `INSERT INTO wiki_files (name, category, filename, mimetype, size, uploaded_by)
       VALUES (?,?,?,?,?,?)`,
      [name || req.file.originalname, category, req.file.filename,
       req.file.mimetype, req.file.size, req.user.id]
    );
    await log(req.user.id, 'wiki_upload', 'wiki', r.insertId, { name, category }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/wiki/files/:id (admin)
router.delete('/files/:id', auth, adminOnly, async (req, res) => {
  try {
    const [[file]] = await db.query('SELECT * FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    const filepath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await db.query('DELETE FROM wiki_files WHERE id=?', [req.params.id]);
    await log(req.user.id, 'wiki_delete', 'wiki', req.params.id, { name: file.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wiki/template
router.get('/template', auth, async (req, res) => {
  try {
    const [[tmpl]] = await db.query('SELECT * FROM email_template WHERE id=1');
    res.json(tmpl || { subject: '', body: '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/wiki/template (admin)
router.put('/template', auth, adminOnly, async (req, res) => {
  const { subject, body } = req.body;
  try {
    await db.query(
      `INSERT INTO email_template (id, subject, body, updated_by) VALUES (1,?,?,?)
       ON DUPLICATE KEY UPDATE subject=VALUES(subject), body=VALUES(body), updated_by=VALUES(updated_by)`,
      [subject || '', body || '', req.user.id]
    );
    await log(req.user.id, 'wiki_template_update', 'wiki', 1, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
