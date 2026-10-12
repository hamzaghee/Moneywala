const CACHE = 'moneywala-shell-v7';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then((clients) =>
          clients.forEach((c) => c.postMessage({ type: 'moneywala-sw-migrated' }))
        )
      )
  );
});
