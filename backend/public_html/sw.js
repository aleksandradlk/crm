/* NovaFlow CRM — Service Worker: Push-Benachrichtigungen (Anrufe, Erinnerungen) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'NovaFlow CRM', body: event.data && event.data.text() }; }
  const title = data.title || 'NovaFlow CRM';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/shared/icon-192.png',
    badge: '/shared/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin);
  const leadId = parseInt(url.searchParams.get('lead'));
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // CRM schon offen → dort den Lead öffnen statt ein neues Fenster
    const same = wins.find(w => new URL(w.url).pathname === url.pathname);
    if (same && leadId) {
      same.postMessage({ type: 'open-lead', leadId });
      return same.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
