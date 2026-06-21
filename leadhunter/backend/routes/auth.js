const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { log } = require('../helpers/logger');
const { auth: authMiddleware } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Felder fehlen' });

  const [[user]] = await db.query(
    'SELECT * FROM users WHERE username = ? AND is_active = 1', [username]
  );
  if (!user) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });

  // Upsert session
  await db.query(
    `INSERT INTO sessions (user_id, token, login_at, last_active, click_count, ip)
     VALUES (?, ?, NOW(), NOW(), 0, ?)
     ON DUPLICATE KEY UPDATE token=VALUES(token), login_at=NOW(), last_active=NOW(), click_count=0, ip=VALUES(ip)`,
    [user.id, token, req.ip]
  );
  await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
  await log(user.id, 'login', 'system', null, null, req.ip);

  res.json({
    token,
    user: {
      id: user.id, username: user.username, full_name: user.full_name, role: user.role,
      can_edit_contacts:  !!user.can_edit_contacts,
      can_archive_leads:  !!user.can_archive_leads,
      can_reassign_leads: !!user.can_reassign_leads,
      can_view_all_leads: !!user.can_view_all_leads,
    }
  });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const header = req.headers['authorization'];
  if (header) {
    try {
      const token = header.startsWith('Bearer ') ? header.slice(7) : header;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      await db.query('DELETE FROM sessions WHERE user_id = ?', [payload.id]);
      await log(payload.id, 'logout', 'system', null, null, req.ip);
    } catch {}
  }
  res.json({ ok: true });
});

// POST /api/auth/setup — einmalig ersten Admin anlegen (nur wenn noch kein User existiert)
router.post('/setup', async (req, res) => {
  const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM users');
  if (cnt > 0) return res.status(403).json({ error: 'Setup bereits abgeschlossen' });

  const { username, password, full_name, email } = req.body;
  if (!username || !password || !full_name || !email)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    'INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?,?,?,?,?)',
    [username, hash, full_name, email, 'admin']
  );
  res.json({ ok: true, message: 'Admin-Account erstellt' });
});

// POST /api/auth/heartbeat — Aktivität + Klick-Tracking
router.post('/heartbeat', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  try {
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { clicks } = req.body;
    await db.query(
      'UPDATE sessions SET last_active = NOW(), click_count = click_count + ? WHERE user_id = ?',
      [clicks || 0, payload.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
});

// GET /api/auth/me — aktuellen Benutzer mit Rechten zurückgeben
router.get('/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, full_name: u.full_name, role: u.role,
    can_edit_contacts:  !!u.can_edit_contacts,
    can_archive_leads:  !!u.can_archive_leads,
    can_reassign_leads: !!u.can_reassign_leads,
    can_view_all_leads: !!u.can_view_all_leads,
  });
});

module.exports = router;
