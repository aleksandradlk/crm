const jwt = require('jsonwebtoken');
const db  = require('../db');

// In-Memory-Cache für Wartungsmodus (30-Sekunden-TTL)
let _maintCache = { active: false, until: '', fetchedAt: 0 };

// Throttle für last_active-Writes: der 30s-Heartbeat (shared/api.js) hält die
// Spalte ohnehin aktuell, daher reicht ein Write pro Request-Middleware alle 15s.
const _lastActiveWrites = new Map();
const LAST_ACTIVE_THROTTLE_MS = 15_000;

async function getMaintenanceStatus() {
  const now = Date.now();
  if (now - _maintCache.fetchedAt < 30_000) return _maintCache;
  try {
    const [rows] = await db.query(
      "SELECT key_name, value FROM app_settings WHERE key_name IN ('maintenance_mode','maintenance_until')"
    );
    const s = {};
    rows.forEach(r => { s[r.key_name] = r.value; });
    _maintCache = { active: s.maintenance_mode === 'true', until: s.maintenance_until || '', fetchedAt: now };
  } catch (_) {
    // Bei DB-Fehler: fetchedAt auf now setzen damit kein Request-Stampede entsteht,
    // alten Cache-Wert (inkl. active-Flag) beibehalten
    _maintCache = { ..._maintCache, fetchedAt: now };
  }
  return _maintCache;
}

// Cache sofort ungültig machen (nach Settings-Änderung aufrufen)
function invalidateMaintenanceCache() {
  _maintCache.fetchedAt = 0;
}

// Verify JWT and attach user to req
async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [[user]] = await db.query(
      `SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active,
              u.can_edit_contacts, u.can_archive_leads, u.can_reassign_leads, u.can_view_all_leads,
              u.can_create_users, u.can_generate_leads, u.can_manage_email_templates,
              s.token AS session_token
       FROM users u
       LEFT JOIN sessions s ON s.user_id = u.id
       WHERE u.id = ?`,
      [payload.id]
    );
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account gesperrt oder nicht gefunden' });
    // Token muss die aktuell gültige Session sein - nach Logout, Passwortänderung oder
    // Login auf einem anderen Gerät wird die alte Session-Zeile gelöscht/ersetzt, damit
    // ein gestohlenes/altes Token nicht einfach weiterverwendet werden kann.
    if (user.session_token !== token) return res.status(401).json({ error: 'Sitzung beendet, bitte erneut anmelden' });
    delete user.session_token;
    req.user = user;

    // Session-Timestamp aktualisieren (auch während Wartung, damit Closer nicht ausgeloggt werden),
    // aber throttled statt bei jedem Request zu schreiben
    const now = Date.now();
    if (now - (_lastActiveWrites.get(user.id) || 0) > LAST_ACTIVE_THROTTLE_MS) {
      _lastActiveWrites.set(user.id, now);
      db.query('UPDATE sessions SET last_active = NOW() WHERE user_id = ?', [user.id]).catch(() => {});
    }

    // Wartungsmodus: Closer werden blockiert, Admin kommt immer durch
    if (user.role !== 'admin') {
      const maint = await getMaintenanceStatus();
      // Automatisches Ablaufen: wenn until-Zeit in der Vergangenheit liegt → Wartung beendet
      const isExpired = maint.until && new Date(maint.until) <= new Date();
      if (maint.active && !isExpired) {
        return res.status(503).json({
          error: 'maintenance',
          message: 'Das System befindet sich aktuell in Wartung.',
          until: maint.until || null,
        });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}

// Only allow admins
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
  next();
}

module.exports = { auth, adminOnly, invalidateMaintenanceCache, getMaintenanceStatus };
