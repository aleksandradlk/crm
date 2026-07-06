const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { log } = require('../helpers/logger');

// Fester Dummy-Hash, gegen den verglichen wird, wenn der Benutzername nicht existiert -
// verhindert, dass die Antwortzeit (bcrypt.compare läuft nur bei existierendem User)
// verrät, ob ein Benutzername gültig ist.
const DUMMY_PASSWORD_HASH = '$2a$12$ruvSUFekmTHS5V/oBDrOr.vNQDBdZRTmjledXxWBp6b3ASwToyXna';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Felder fehlen' });

  const [[user]] = await db.query(
    'SELECT * FROM users WHERE username = ? AND is_active = 1', [username]
  );
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '4h' });

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
      onboarding_shown:   !!user.onboarding_shown,
      can_edit_contacts:  !!user.can_edit_contacts,
      can_archive_leads:  !!user.can_archive_leads,
      can_reassign_leads: !!user.can_reassign_leads,
      can_view_all_leads: !!user.can_view_all_leads,
      can_create_users:              !!user.can_create_users,
      can_generate_leads:            !!user.can_generate_leads,
      can_manage_email_templates:    !!user.can_manage_email_templates,
    }
  });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const header = req.headers['authorization'];
  const { reason } = req.body || {};
  if (header) {
    try {
      const token = header.startsWith('Bearer ') ? header.slice(7) : header;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      await db.query('DELETE FROM sessions WHERE user_id = ?', [payload.id]);
      const action = reason === 'inactivity' ? 'logout_inactivity' : 'logout';
      await log(payload.id, action, 'system', null,
        reason === 'inactivity' ? { reason: 'Automatisch nach 5 Min Inaktivität' } : null,
        req.ip);
    } catch {}
  }
  res.json({ ok: true });
});

// GET /api/auth/needs-setup — schreibfreier Status-Check für die Login-Seite
// (bewusst nicht unter /api/auth/setup, damit dieser Check nicht das
// Rate-Limit des eigentlichen Setup-Endpunkts verbraucht)
router.get('/needs-setup', async (req, res) => {
  const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM users');
  res.json({ needsSetup: cnt === 0 });
});

// POST /api/auth/setup — einmalig ersten Admin anlegen (nur wenn noch kein User existiert)
router.post('/setup', async (req, res) => {
  // Named Lock statt reinem COUNT-Check: verhindert, dass zwei gleichzeitige
  // Requests im selben kurzen Fenster beide den ersten Admin anlegen.
  const conn = await db.getConnection();
  try {
    const [[{ acquired }]] = await conn.query("SELECT GET_LOCK('novaflow_setup', 5) AS acquired");
    if (!acquired) return res.status(503).json({ error: 'Setup wird gerade verarbeitet, bitte kurz erneut versuchen' });
    try {
      const [[{ cnt }]] = await conn.query('SELECT COUNT(*) as cnt FROM users');
      if (cnt > 0) return res.status(403).json({ error: 'Setup bereits abgeschlossen' });

      const { username, password, full_name, email } = req.body;
      if (!username || !password || !full_name || !email)
        return res.status(400).json({ error: 'Alle Felder erforderlich' });

      const hash = await bcrypt.hash(password, 12);
      await conn.query(
        'INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?,?,?,?,?)',
        [username, hash, full_name, email, 'admin']
      );
      res.json({ ok: true, message: 'Admin-Account erstellt' });
    } finally {
      await conn.query("SELECT RELEASE_LOCK('novaflow_setup')");
    }
  } finally {
    conn.release();
  }
});

// POST /api/auth/heartbeat — Aktivität + Klick-Tracking
router.post('/heartbeat', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  try {
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const clicks = Math.max(0, Math.min(parseInt(req.body.clicks) || 0, 10000));
    await db.query(
      'UPDATE sessions SET last_active = NOW(), click_count = click_count + ? WHERE user_id = ?',
      [clicks, payload.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
});

// PATCH /api/auth/password — eigenes Passwort ändern
router.patch('/password', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const token   = header.startsWith('Bearer ') ? header.slice(7) : header;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });

    const [[user]] = await db.query('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });

    const hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, payload.id]);
    await db.query('DELETE FROM sessions WHERE user_id=? AND token!=?', [payload.id, token]);
    await log(payload.id, 'password_change', 'user', payload.id, null, req.ip);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
});

// GET /api/auth/me — eigenes Profil incl. Benachrichtigungs-Prefs
const { auth } = require('../middleware/auth');
router.get('/me', auth, async (req, res) => {
  try {
    const [[user]] = await db.query(
      'SELECT id, username, full_name, email, role, notify_email, notify_sms, phone, can_edit_contacts, can_archive_leads, can_reassign_leads, can_view_all_leads, can_create_users, can_generate_leads, can_manage_email_templates FROM users WHERE id=?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(user);
  } catch(e) { console.error('Auth /me error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

module.exports = router;
