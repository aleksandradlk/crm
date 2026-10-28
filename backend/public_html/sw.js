// Service Worker: zeigt Handy-/Browser-Benachrichtigungen aus dem CRM an (Web Push).
// Absichtlich ohne Cache, das CRM lädt wie bisher immer frisch vom Server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NovaFlow CRM', {
    body: d.body || '',
    icon: '/app-icon-192.png',
    badge: '/app-icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
  }));
});

// Antippen: offenes CRM-Fenster nach vorn holen und den Lead öffnen, sonst neues Fenster
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const offen = list.find(c => c.url.startsWith(self.location.origin));
    if (offen && 'navigate' in offen) return offen.navigate(url).then(c => (c || offen).focus());
    return self.clients.openWindow(url);
  }));
});
