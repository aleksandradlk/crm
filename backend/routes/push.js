// ── Benachrichtigungen: Handy-Benachrichtigungen (Web Push) und Test-Mail ──
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const push   = require('../helpers/push');
const { sendInfoMail } = require('../helpers/mailer');

// GET /api/push/status — öffentlicher Schlüssel und Zahl der eigenen Geräte
router.get('/status', auth, async (req, res) => {
  try {
    const key = await push.oeffentlicherSchluessel();
    const [[n]] = await db.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?', [req.user.id]);
    res.json({ aktiv: !!key, key, geraete: Number(n.n) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/push/subscribe — dieses Gerät anmelden (gleiches Gerät = gleicher endpoint → wird übernommen)
router.post('/subscribe', auth, async (req, res) => {
  const s = req.body && req.body.subscription;
  const endpoint = s && String(s.endpoint || '');
  const p256dh = s && s.keys && String(s.keys.p256dh || '');
  const authKey = s && s.keys && String(s.keys.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 600 || !p256dh || !authKey || p256dh.length > 200 || authKey.length > 100)
    return res.status(400).json({ error: 'Ungültige Anmeldung für Benachrichtigungen' });
  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, geraet) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh), auth=VALUES(auth), geraet=VALUES(geraet)`,
      [req.user.id, endpoint, p256dh, authKey, String(req.headers['user-agent'] || '').slice(0, 255)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/push/unsubscribe — dieses Gerät abmelden
router.post('/unsubscribe', auth, async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  try {
    await db.query('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', [req.user.id, endpoint]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/push/test — Test-Benachrichtigung an alle eigenen Geräte
router.post('/test', auth, async (req, res) => {
  const n = await push.sendePush(req.user.id, { title: 'NovaFlow CRM', body: 'Test: Benachrichtigungen funktionieren auf diesem Gerät.', tag: 'test' });
  if (!n) return res.status(400).json({ error: 'Kein Gerät erreicht. Bitte Benachrichtigungen auf diesem Gerät zuerst einschalten.' });
  res.json({ ok: true, geraete: n });
});

// POST /api/push/testmail — Test-Mail an die eigene hinterlegte Adresse
router.post('/testmail', auth, async (req, res) => {
  try {
    const [[u]] = await db.query('SELECT email, full_name, notify_email FROM users WHERE id=?', [req.user.id]);
    if (!u || !u.email) return res.status(400).json({ error: 'Für dich ist noch keine E-Mail-Adresse hinterlegt. Bitte Aleksa fragen, damit sie eingetragen wird.' });
    await sendInfoMail({ to: u.email, toName: u.full_name, subject: 'Test: E-Mails aus dem NovaFlow CRM kommen an', zeilen: [
      'Diese Test-Mail zeigt: Erinnerungen aus dem CRM erreichen dich unter dieser Adresse.',
      u.notify_email ? '' : '<b>Hinweis:</b> Die E-Mail-Benachrichtigung für Reminder ist bei dir gerade ausgeschaltet.',
    ] });
    res.json({ ok: true, email: u.email });
  } catch (e) {
    console.error('Test-Mail:', e.message);
    // Admin sieht den Grund vom Mailserver, Closer einen verständlichen Hinweis
    res.status(500).json({ error: req.user.role === 'admin'
      ? `Die Test-Mail konnte nicht verschickt werden. Grund vom Mailserver: ${e.message}`
      : 'Die Test-Mail konnte nicht verschickt werden. Bitte Aleksa Bescheid geben.' });
  }
});

module.exports = router;
