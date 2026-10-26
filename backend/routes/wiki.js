const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// Außerhalb des App-Verzeichnisses — überlebt Neustarts und Deployments
const UPLOAD_DIR = process.env.WIKI_UPLOAD_DIR
  || path.join(require('os').homedir(), 'uploads', 'wiki');
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
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// POST /api/wiki/files (admin)
router.post('/files', auth, adminOnly, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { name, note } = req.body;
  const category = String(req.body.category || '').trim().slice(0, 100);
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  if (!category) return res.status(400).json({ error: 'Kategorie fehlt' });
  try {
    const [r] = await db.query(
      `INSERT INTO wiki_files (name, category, filename, mimetype, size, uploaded_by, note)
       VALUES (?,?,?,?,?,?,?)`,
      [(name?.trim() || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 255), category, req.file.filename,
       req.file.mimetype, req.file.size, req.user.id, note?.trim() || null]
    );
    await log(req.user.id, 'wiki_upload', 'wiki', r.insertId, { name, category }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// PATCH /api/wiki/files/:id — Bezeichnung, Kategorie, Notiz bearbeiten (admin)
router.patch('/files/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, category, note } = req.body;
    const [[file]] = await db.query('SELECT id FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    const sets = [], vals = [];
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Bezeichnung fehlt' });
      sets.push('name=?'); vals.push(String(name).trim().slice(0, 255));
    }
    if (category !== undefined) {
      if (!String(category).trim()) return res.status(400).json({ error: 'Kategorie fehlt' });
      sets.push('category=?'); vals.push(String(category).trim().slice(0, 100));
    }
    if (note !== undefined) { sets.push('note=?'); vals.push(note?.trim() || null); }
    if (sets.length) await db.query(`UPDATE wiki_files SET ${sets.join(', ')} WHERE id=?`, [...vals, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// PUT /api/wiki/files/:id/replace — Datei austauschen (admin)
router.put('/files/:id/replace', auth, adminOnly, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  try {
    const [[file]] = await db.query('SELECT * FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    // alte Datei löschen
    const oldPath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    await db.query(
      'UPDATE wiki_files SET filename=?, mimetype=?, size=?, uploaded_by=? WHERE id=?',
      [req.file.filename, req.file.mimetype, req.file.size, req.user.id, req.params.id]
    );
    await log(req.user.id, 'wiki_replace', 'wiki', req.params.id, { name: file.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

router.delete('/files/:id', auth, adminOnly, async (req, res) => {
  try {
    const [[file]] = await db.query('SELECT * FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    const filepath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await db.query('DELETE FROM wiki_files WHERE id=?', [req.params.id]);
    await log(req.user.id, 'wiki_delete', 'wiki', req.params.id, { name: file.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── Artikel (Markdown) ────────────────────────────────────────────────────
// Kategorie „Vertrieb“ mit 00_Start-hier … 08_FAQ: Schlüssel = Nummer aus dem
// Dateinamen („07_Einwaende.md“ → „07“), Reihenfolge nach Nummer.
const textOk = (v, max) => String(v ?? '').slice(0, max);
function ausDatei(name, inhalt) {
  const basis = String(name || '').replace(/\.(md|markdown|txt)$/i, '');
  const nr = (/^(\d{1,3})[\s_.-]/.exec(basis) || [])[1] || null;
  const h1 = /^\s*#\s+(.+)$/m.exec(inhalt || '');
  const titel = (h1 ? h1[1] : basis.replace(/^\d{1,3}[\s_.-]+/, '').replace(/[_-]+/g, ' ')).trim() || basis;
  return { schluessel: nr ? nr.padStart(2, '0') : basis.toLowerCase().slice(0, 80), titel: titel.slice(0, 255), sort: nr ? parseInt(nr) : 999 };
}

router.get('/artikel', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.id, a.kategorie, a.schluessel, a.titel, a.inhalt, a.sort, a.updated_at, a.created_at, u.full_name AS updated_by_name
       FROM wiki_artikel a LEFT JOIN users u ON u.id = a.updated_by ORDER BY a.kategorie, a.sort, a.titel`);
    res.json(rows);
  } catch (e) { console.error('Wiki Artikel:', e); res.status(500).json({ error: 'Artikel konnten nicht geladen werden.' }); }
});

router.post('/artikel', auth, adminOnly, async (req, res) => {
  const titel = textOk(req.body.titel, 255).trim(), inhalt = textOk(req.body.inhalt, 2e6);
  if (!titel) return res.status(400).json({ error: 'Bitte einen Titel eingeben.' });
  try {
    const [r] = await db.query('INSERT INTO wiki_artikel (kategorie, schluessel, titel, inhalt, sort, updated_by) VALUES (?,?,?,?,?,?)',
      [textOk(req.body.kategorie || 'Vertrieb', 100).trim() || 'Vertrieb', req.body.schluessel ? textOk(req.body.schluessel, 80) : null,
       titel, inhalt, parseInt(req.body.sort) || 999, req.user.id]);
    await log(req.user.id, 'wiki_artikel_neu', 'wiki', r.insertId, { titel }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Es gibt schon einen Artikel mit dieser Nummer.' });
    console.error('Wiki Artikel:', e); res.status(500).json({ error: 'Artikel konnte nicht gespeichert werden.' });
  }
});

router.put('/artikel/:id', auth, adminOnly, async (req, res) => {
  const titel = textOk(req.body.titel, 255).trim();
  if (!titel) return res.status(400).json({ error: 'Bitte einen Titel eingeben.' });
  try {
    await db.query('UPDATE wiki_artikel SET kategorie=?, titel=?, inhalt=?, sort=?, updated_by=?, updated_at=NOW() WHERE id=?',
      [textOk(req.body.kategorie || 'Vertrieb', 100).trim() || 'Vertrieb', titel, textOk(req.body.inhalt, 2e6),
       parseInt(req.body.sort) || 999, req.user.id, parseInt(req.params.id)]);
    await log(req.user.id, 'wiki_artikel_update', 'wiki', parseInt(req.params.id), { titel }, req.ip);
    res.json({ ok: true });
  } catch (e) { console.error('Wiki Artikel:', e); res.status(500).json({ error: 'Artikel konnte nicht gespeichert werden.' }); }
});

router.delete('/artikel/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM wiki_artikel WHERE id=?', [parseInt(req.params.id)]);
    await log(req.user.id, 'wiki_artikel_loeschen', 'wiki', parseInt(req.params.id), {}, req.ip);
    res.json({ ok: true });
  } catch (e) { console.error('Wiki Artikel:', e); res.status(500).json({ error: 'Artikel konnte nicht gelöscht werden.' }); }
});

// POST /api/wiki/artikel/import { name, inhalt, kategorie? } – eine .md-Datei; gleiche Nummer ersetzt den Artikel
router.post('/artikel/import', auth, adminOnly, async (req, res) => {
  const inhalt = textOk(req.body.inhalt, 2e6);
  if (!inhalt.trim()) return res.status(400).json({ error: 'Die Datei ist leer.' });
  const a = ausDatei(req.body.name, inhalt);
  const kategorie = textOk(req.body.kategorie || 'Vertrieb', 100).trim() || 'Vertrieb';
  try {
    const [[alt]] = await db.query('SELECT id, inhalt FROM wiki_artikel WHERE schluessel=?', [a.schluessel]);
    if (alt) {
      if (alt.inhalt === inhalt) return res.json({ ok: true, id: alt.id, titel: a.titel, unveraendert: true });
      await db.query('UPDATE wiki_artikel SET titel=?, inhalt=?, sort=?, kategorie=?, updated_by=?, updated_at=NOW() WHERE id=?',
        [a.titel, inhalt, a.sort, kategorie, req.user.id, alt.id]);
      await log(req.user.id, 'wiki_artikel_import', 'wiki', alt.id, { titel: a.titel, ersetzt: true }, req.ip);
      return res.json({ ok: true, id: alt.id, titel: a.titel, ersetzt: true });
    }
    const [r] = await db.query('INSERT INTO wiki_artikel (kategorie, schluessel, titel, inhalt, sort, updated_by) VALUES (?,?,?,?,?,?)',
      [kategorie, a.schluessel, a.titel, inhalt, a.sort, req.user.id]);
    await log(req.user.id, 'wiki_artikel_import', 'wiki', r.insertId, { titel: a.titel }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId, titel: a.titel, neu: true });
  } catch (e) { console.error('Wiki Import:', e); res.status(500).json({ error: 'Import fehlgeschlagen.' }); }
});

// ── Referenzen ─────────────────────────────────────────────────────────────
const refFelder = b => [textOk(b.betrieb, 255).trim(), textOk(b.branche, 120).trim() || null, textOk(b.paket, 60).trim() || null,
  textOk(b.ergebnis, 2000).trim() || null, /^https?:\/\//i.test(String(b.link || '').trim()) ? textOk(b.link, 500).trim() : null];
router.get('/referenzen', auth, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM wiki_referenzen ORDER BY created_at DESC'); res.json(rows); }
  catch (e) { console.error('Referenzen:', e); res.status(500).json({ error: 'Referenzen konnten nicht geladen werden.' }); }
});
router.post('/referenzen', auth, adminOnly, async (req, res) => {
  const f = refFelder(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Bitte den Betrieb eintragen.' });
  try {
    const [r] = await db.query('INSERT INTO wiki_referenzen (betrieb, branche, paket, ergebnis, link, created_by) VALUES (?,?,?,?,?,?)', [...f, req.user.id]);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { console.error('Referenzen:', e); res.status(500).json({ error: 'Referenz konnte nicht gespeichert werden.' }); }
});
router.put('/referenzen/:id', auth, adminOnly, async (req, res) => {
  const f = refFelder(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Bitte den Betrieb eintragen.' });
  try { await db.query('UPDATE wiki_referenzen SET betrieb=?, branche=?, paket=?, ergebnis=?, link=? WHERE id=?', [...f, parseInt(req.params.id)]); res.json({ ok: true }); }
  catch (e) { console.error('Referenzen:', e); res.status(500).json({ error: 'Referenz konnte nicht gespeichert werden.' }); }
});
router.delete('/referenzen/:id', auth, adminOnly, async (req, res) => {
  try { await db.query('DELETE FROM wiki_referenzen WHERE id=?', [parseInt(req.params.id)]); res.json({ ok: true }); }
  catch (e) { console.error('Referenzen:', e); res.status(500).json({ error: 'Referenz konnte nicht gelöscht werden.' }); }
});

// ── „Aktualisiert: …“ – einmaliger Hinweis je Benutzer ─────────────────────
// Neu seit dem letzten Öffnen der Wissensdatenbank (eigene Änderungen zählen nicht)
router.get('/neu', auth, async (req, res) => {
  try {
    const [[u]] = await db.query('SELECT wiki_gesehen_at, created_at FROM users WHERE id=?', [req.user.id]);
    const seit = u?.wiki_gesehen_at || u?.created_at || new Date();
    const [artikel] = await db.query(
      `SELECT id, titel, updated_at FROM wiki_artikel WHERE updated_at > ? AND (updated_by IS NULL OR updated_by <> ?) ORDER BY updated_at DESC`,
      [seit, req.user.id]);
    const [dateien] = await db.query(
      'SELECT id, name AS titel, created_at AS updated_at FROM wiki_files WHERE created_at > ? AND (uploaded_by IS NULL OR uploaded_by <> ?) ORDER BY created_at DESC',
      [seit, req.user.id]);
    res.json({ seit, artikel, dateien, anzahl: artikel.length + dateien.length });
  } catch (e) { res.json({ artikel: [], dateien: [], anzahl: 0 }); }
});
router.post('/gesehen', auth, async (req, res) => {
  try { await db.query('UPDATE users SET wiki_gesehen_at=NOW() WHERE id=?', [req.user.id]); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false }); }
});

// GET /api/wiki/template
router.get('/template', auth, async (req, res) => {
  try {
    const [[tmpl]] = await db.query('SELECT * FROM email_template WHERE id=1');
    res.json(tmpl || { subject: '', body: '' });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
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
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// GET /api/wiki/files/:filename — authenticated file delivery
// Akzeptiert Auth-Token wahlweise als Bearer-Header ODER ?token= Query-Param (für direkte Tab-Öffnung)
const jwt = require('jsonwebtoken');
router.get('/files/:filename', async (req, res) => {
  try {
    const raw = req.headers['authorization'] || '';
    const tokenStr = raw.startsWith('Bearer ') ? raw.slice(7) : (req.query.token || '');
    if (!tokenStr) return res.status(401).json({ error: 'Kein Token' });
    const payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    const [[user]] = await db.query('SELECT id, is_active FROM users WHERE id=?', [payload.id]);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Nicht berechtigt' });
  } catch {
    return res.status(401).json({ error: 'Token ungültig' });
  }

  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!filepath.startsWith(path.resolve(UPLOAD_DIR) + path.sep))
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Nicht gefunden' });

  const [[file]] = await db.query('SELECT mimetype, name FROM wiki_files WHERE filename=?', [filename]).catch(() => [[]]);
  const EXT_MIME = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.txt': 'text/plain', '.html': 'text/html',
  };
  const ext = path.extname(filename).toLowerCase();
  const mime = (file?.mimetype && file.mimetype !== 'application/octet-stream')
    ? file.mimetype
    : (EXT_MIME[ext] || 'application/octet-stream');
  const displayName = file?.name || filename;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(displayName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.sendFile(filepath);
});

module.exports = router;
