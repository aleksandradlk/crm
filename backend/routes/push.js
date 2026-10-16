// Geräte für Push-Benachrichtigungen an- und abmelden
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const push   = require('../helpers/push');
const crypto = require('crypto');

const hash = s => crypto.createHash('sha256').update(s).digest('hex');

// ── GET /api/push/config — öffentlicher Schlüssel + Anzahl eigener Geräte ──
router.get('/config', auth, async (req, res) => {
  try {
    if (!push.isAvailable()) return res.json({ enabled: false });
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM push_subscriptions WHERE user_id=?', [req.user.id]);
    res.json({ enabled: true, public_key: await push.publicKey(), devices: cnt });
  } catch (e) {
    console.error('Push config error:', e.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/push/subscribe — dieses Gerät anmelden ──
router.post('/subscribe', auth, async (req, res) => {
  const sub = req.body && req.body.subscription;
  const endpoint = sub && String(sub.endpoint || '');
  const p256dh = sub && sub.keys && String(sub.keys.p256dh || '');
  const authKey = sub && sub.keys && String(sub.keys.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !authKey)
    return res.status(400).json({ error: 'Ungültige Anmeldung' });
  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), endpoint=VALUES(endpoint), p256dh=VALUES(p256dh), auth=VALUES(auth), user_agent=VALUES(user_agent)`,
      [req.user.id, hash(endpoint), endpoint, p256dh, authKey, String(req.get('User-Agent') || '').slice(0, 255)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Push subscribe error:', e.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/push/unsubscribe — dieses Gerät abmelden ──
router.post('/unsubscribe', auth, async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  await db.query('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?', [req.user.id, hash(endpoint)]).catch(() => {});
  res.json({ ok: true });
});

// ── POST /api/push/test — Testbenachrichtigung an alle eigenen Geräte ──
router.post('/test', auth, async (req, res) => {
  try {
    const sent = await push.sendToUser(req.user.id, {
      title: '📞 Test: Müller Bau GmbH ruft an',
      body: 'So sieht ein eingehender Anruf aus: Ansprechpartner, Status, offene Angebote.',
      url: '/',
      tag: 'test',
    });
    res.json({ ok: true, sent });
  } catch (e) {
    console.error('Push test error:', e.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
