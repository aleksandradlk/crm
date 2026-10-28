// ── Handy-/Browser-Benachrichtigungen (Web Push) ──────────────
// Kommen auch an, wenn das CRM geschlossen, das Handy gesperrt oder der Benutzer
// abgemeldet ist. Am iPhone nur, wenn das CRM über Safari zum Home-Bildschirm
// hinzugefügt wurde (iOS 16.4+). Kostenlos, läuft über die Push-Dienste der Browser.
// Schlüssel (VAPID) werden beim ersten Bedarf erzeugt und in integrations gespeichert
// (nicht in app_settings, die alle Benutzer lesen dürfen).
const db = require('../db');

let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* Paket fehlt → Push aus */ }

let _keys = null;
async function schluessel() {
  if (_keys) return _keys;
  if (!webpush) return null;
  const [[row]] = await db.query("SELECT config FROM integrations WHERE name='webpush'");
  if (row) _keys = JSON.parse(row.config);
  else {
    const k = webpush.generateVAPIDKeys();
    _keys = { publicKey: k.publicKey, privateKey: k.privateKey };
    // Zwei Prozesse gleichzeitig: INSERT IGNORE + neu lesen, damit alle dieselben Schlüssel nutzen
    await db.query("INSERT IGNORE INTO integrations (name, config) VALUES ('webpush', ?)", [JSON.stringify(_keys)]);
    const [[neu]] = await db.query("SELECT config FROM integrations WHERE name='webpush'");
    _keys = JSON.parse(neu.config);
  }
  const absender = process.env.SMTP_USER || 'info@novaflowservices.de';
  webpush.setVapidDetails('mailto:' + absender, _keys.publicKey, _keys.privateKey);
  return _keys;
}

async function oeffentlicherSchluessel() {
  const k = await schluessel();
  return k ? k.publicKey : null;
}

// Link, der beim Antippen geöffnet wird: Lead direkt in der passenden Oberfläche
async function linkFuer(userId, leadId) {
  const [[u]] = await db.query('SELECT role FROM users WHERE id=?', [userId]);
  const seite = u && u.role === 'admin' ? '/admin' : '/closer';
  return leadId ? `${seite}?lead=${leadId}` : seite;
}

// Schickt an alle Geräte des Benutzers. Gibt die Zahl der erreichten Geräte zurück.
// Fehler werden nur protokolliert – eine Benachrichtigung darf nie den Ablauf stören.
async function sendePush(userId, { title, body, leadId, tag }) {
  try {
    if (!(await schluessel())) return 0;
    const [subs] = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?', [userId]);
    if (!subs.length) return 0;
    const payload = JSON.stringify({ title, body: body || '', url: await linkFuer(userId, leadId), tag: tag || undefined });
    let ok = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        ok++;
        await db.query('UPDATE push_subscriptions SET last_ok_at=NOW() WHERE id=?', [s.id]);
      } catch (e) {
        // 404/410: Gerät hat die Benachrichtigungen abgeschaltet oder die App gelöscht → Eintrag entfernen
        if (e.statusCode === 404 || e.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE id=?', [s.id]);
        else console.error(`Push an Benutzer ${userId} fehlgeschlagen:`, e.statusCode || '', e.body || e.message);
      }
    }
    return ok;
  } catch (e) {
    console.error('Push:', e.message);
    return 0;
  }
}

module.exports = { sendePush, oeffentlicherSchluessel, aktiv: () => !!webpush };
