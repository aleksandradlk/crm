// Push-Benachrichtigungen aufs Handy / an den Browser (Web Push).
// Funktioniert auf Android (Chrome) direkt und auf dem iPhone ab iOS 16.4,
// wenn das CRM über „Zum Home-Bildschirm“ als App installiert ist.
// Die VAPID-Schlüssel werden beim ersten Gebrauch erzeugt und in app_settings
// gespeichert – keine Einrichtung in .env nötig.
const db = require('../db');

let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* Paket fehlt → Push aus */ }

let _keys = null;
async function keys() {
  if (_keys) return _keys;
  const [rows] = await db.query(
    "SELECT key_name, value FROM app_settings WHERE key_name IN ('vapid_public','vapid_private')"
  );
  const s = Object.fromEntries(rows.map(r => [r.key_name, r.value]));
  if (s.vapid_public && s.vapid_private) {
    _keys = { publicKey: s.vapid_public, privateKey: s.vapid_private };
  } else {
    const k = webpush.generateVAPIDKeys();
    // INSERT IGNORE: starten zwei Prozesse gleichzeitig, gewinnt der erste
    await db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('vapid_public', ?), ('vapid_private', ?)",
      [k.publicKey, k.privateKey]);
    _keys = null;
    return keys();
  }
  const subject = process.env.VAPID_SUBJECT || `mailto:${process.env.SMTP_USER || 'info@novaflowservices.de'}`;
  webpush.setVapidDetails(subject, _keys.publicKey, _keys.privateKey);
  return _keys;
}

function isAvailable() { return !!webpush; }

async function publicKey() {
  if (!webpush) return null;
  return (await keys()).publicKey;
}

// payload: { title, body, url, tag, requireInteraction }
async function sendToUser(userId, payload) {
  if (!webpush) return 0;
  await keys();
  const [subs] = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?', [userId]);
  const data = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data,
        { TTL: 60, urgency: 'high', timeout: 5000 }
      );
      sent++;
    } catch (e) {
      // 404/410: Gerät hat die Benachrichtigungen abgemeldet → Eintrag entfernen
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id=?', [s.id]).catch(() => {});
      } else {
        console.error('[Push] Senden fehlgeschlagen:', e.statusCode || '', e.message);
      }
    }
  }));
  return sent;
}

async function sendToUsers(userIds, payload) {
  const results = await Promise.all([...new Set(userIds)].map(id => sendToUser(id, payload).catch(() => 0)));
  return results.reduce((a, b) => a + b, 0);
}

module.exports = { isAvailable, publicKey, sendToUser, sendToUsers };
