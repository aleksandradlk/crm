// ── Ziele pro Closer: Anwahlen, Gespräche, Angebotsanfragen/Termine ────────
// Je Closer pro Tag oder pro Woche einstellbar; ohne eigene Werte gelten die
// Standards aus den Einstellungen (daily_call_goal, ziel_gespraeche, ziel_ergebnisse).
// Woche = Montag bis Sonntag, ein Tagesziel zählt für 5 Arbeitstage.
const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const ARBEITSTAGE = 5;
const KEYS = ['anwahlen', 'gespraeche', 'ergebnisse'];
// Gespräch = jemand erreicht (Status oder Ergebnis aus dem Anrufmodus)
const GESPRAECH = `(c.status IN ('reached','completed') OR c.outcome IN ('rueckruf','interesse','termin','kein_interesse','kunde'))`;

async function standards() {
  const [rows] = await db.query("SELECT key_name, value FROM app_settings WHERE key_name IN ('daily_call_goal','ziel_gespraeche','ziel_ergebnisse')");
  const s = Object.fromEntries(rows.map(r => [r.key_name, parseInt(r.value)]));
  return { anwahlen: s.daily_call_goal || 50, gespraeche: s.ziel_gespraeche || 10, ergebnisse: s.ziel_ergebnisse || 2 };
}

// Ziel eines Benutzers: { zeitraum, ziel (im gewählten Zeitraum), tag, woche }
function zielVon(u, std) {
  const zeitraum = u.goal_period === 'woche' ? 'woche' : 'tag';
  const eigen = { anwahlen: u.goal_calls, gespraeche: u.goal_talks, ergebnisse: u.goal_results };
  const ziel = {}, tag = {}, woche = {};
  for (const k of KEYS) {
    const v = eigen[k] > 0 ? eigen[k] : (zeitraum === 'woche' ? std[k] * ARBEITSTAGE : std[k]);
    ziel[k] = v;
    tag[k] = zeitraum === 'woche' ? Math.ceil(v / ARBEITSTAGE) : v;
    woche[k] = zeitraum === 'woche' ? v : v * ARBEITSTAGE;
  }
  return { zeitraum, eigen: KEYS.some(k => eigen[k] > 0), ziel, tag, woche };
}

// Zahlen je Benutzer und Tag im Bereich [von, bis)
async function zahlen(von, bis, userIds) {
  if (!userIds.length) return [];
  const [calls] = await db.query(
    `SELECT c.user_id, DATE_FORMAT(c.started_at, '%Y-%m-%d') AS tag, COUNT(*) AS anwahlen, SUM(${GESPRAECH}) AS gespraeche
     FROM call_logs c
     WHERE c.user_id IN (?) AND c.started_at >= ? AND c.started_at < ? AND (c.direction IS NULL OR c.direction <> 'inbound')
     GROUP BY c.user_id, tag`, [userIds, von, bis]);
  // Ergebnisse: selbst vereinbarte Termine + angeforderte Angebote
  const [termine] = await db.query(
    `SELECT closer_id AS user_id, DATE_FORMAT(created_at, '%Y-%m-%d') AS tag, COUNT(*) AS n FROM appointments
     WHERE closer_id IN (?) AND proposed_by = closer_id AND status <> 'abgesagt' AND created_at >= ? AND created_at < ?
     GROUP BY closer_id, tag`, [userIds, von, bis]).catch(() => [[]]);
  const [angebote] = await db.query(
    `SELECT user_id, DATE_FORMAT(created_at, '%Y-%m-%d') AS tag, COUNT(*) AS n FROM comments
     WHERE user_id IN (?) AND text LIKE '📝 Angebot angefordert%' AND created_at >= ? AND created_at < ?
     GROUP BY user_id, tag`, [userIds, von, bis]);
  const map = {};
  const zeile = (u, t) => ((map[u] = map[u] || {})[t] = map[u][t] || { anwahlen: 0, gespraeche: 0, ergebnisse: 0 });
  calls.forEach(r => { const z = zeile(r.user_id, r.tag); z.anwahlen += Number(r.anwahlen); z.gespraeche += Number(r.gespraeche || 0); });
  [...termine, ...angebote].forEach(r => { zeile(r.user_id, r.tag).ergebnisse += Number(r.n); });
  return map;
}

const summe = tage => KEYS.reduce((s, k) => ({ ...s, [k]: Object.values(tage || {}).reduce((a, t) => a + t[k], 0) }), {});

async function wochenStart(offset = 0) {
  const [[r]] = await db.query(
    "SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) + INTERVAL ? WEEK, '%Y-%m-%d') AS von, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS heute",
    [offset]);
  const bis = new Date(r.von + 'T00:00:00Z'); bis.setUTCDate(bis.getUTCDate() + 7);
  return { von: r.von, bis: bis.toISOString().slice(0, 10), heute: r.heute };
}

// ── GET /api/ziele/mein — eigenes Ziel und Stand heute/diese Woche ──
router.get('/mein', auth, async (req, res) => {
  try {
    const [[u]] = await db.query('SELECT id, goal_period, goal_calls, goal_talks, goal_results FROM users WHERE id=?', [req.user.id]);
    const z = zielVon(u, await standards());
    const w = await wochenStart(0);
    const map = (await zahlen(w.von, w.bis, [u.id]))[u.id] || {};
    res.json({ ...z, heute: map[w.heute] || { anwahlen: 0, gespraeche: 0, ergebnisse: 0 }, diese_woche: summe(map), woche_von: w.von });
  } catch (e) { console.error('Ziele mein:', e); res.status(500).json({ error: 'Ziele konnten nicht geladen werden.' }); }
});

// ── GET /api/ziele/team?woche=0 — Wochenübersicht aller Closer (Admin) ──
router.get('/team', auth, adminOnly, async (req, res) => {
  try {
    const offset = Math.max(-52, Math.min(0, parseInt(req.query.woche) || 0));
    const w = await wochenStart(offset);
    const [users] = await db.query(
      `SELECT u.id, u.full_name, u.role, u.goal_period, u.goal_calls, u.goal_talks, u.goal_results FROM users u
       WHERE u.is_active = 1 AND (u.role = 'closer'
         OR EXISTS (SELECT 1 FROM call_logs c WHERE c.user_id = u.id AND c.started_at >= ? AND c.started_at < ?))
       ORDER BY u.role = 'closer' DESC, u.full_name`, [w.von, w.bis]);
    const std = await standards();
    const map = await zahlen(w.von, w.bis, users.map(u => u.id));
    const tage = Array.from({ length: 7 }, (_, i) => { const d = new Date(w.von + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
    res.json({
      von: w.von, bis: w.bis, heute: w.heute, tage, standard: std,
      closer: users.map(u => ({
        id: u.id, full_name: u.full_name, role: u.role, ...zielVon(u, std),
        roh: { zeitraum: u.goal_period || 'tag', anwahlen: u.goal_calls, gespraeche: u.goal_talks, ergebnisse: u.goal_results },
        tage: tage.map(t => ({ tag: t, ...((map[u.id] || {})[t] || { anwahlen: 0, gespraeche: 0, ergebnisse: 0 }) })),
        summe: summe(map[u.id]),
      })),
    });
  } catch (e) { console.error('Ziele team:', e); res.status(500).json({ error: 'Übersicht konnte nicht geladen werden.' }); }
});

// ── PATCH /api/ziele/:userId — Ziel eines Closers setzen (leer = Standard) ──
router.patch('/:userId', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.userId);
  const zahl = v => { const n = parseInt(v); return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : null; };
  const b = req.body || {};
  try {
    await db.query('UPDATE users SET goal_period=?, goal_calls=?, goal_talks=?, goal_results=? WHERE id=?',
      [b.zeitraum === 'woche' ? 'woche' : 'tag', zahl(b.anwahlen), zahl(b.gespraeche), zahl(b.ergebnisse), id]);
    await log(req.user.id, 'ziel_update', 'user', id, { zeitraum: b.zeitraum }, req.ip);
    res.json({ ok: true });
  } catch (e) { console.error('Ziele PATCH:', e); res.status(500).json({ error: 'Ziel konnte nicht gespeichert werden.' }); }
});

module.exports = router;
