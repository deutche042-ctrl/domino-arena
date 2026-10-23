// Domino Arena service worker — offline app shell.
// Strategy:
//   - navigations (index.html): network-first, cache fallback (stay fresh, work offline)
//   - static assets (js/css/vendor/fonts/icons): cache-first, filled at runtime
//   - everything else (socket.io): network only — live data never cached
// Cache name is versioned: bump SW_VER when shipped asset expectations change.
const SW_VER = 'domino-v20';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SW_VER).then(c => c.addAll([
    './', './index.html', './manifest.webmanifest', './icons/icon.svg',
  ])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SW_VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const p = url.pathname;
  // live traffic: never intercept
  if (p.startsWith('/socket.io')) return;

  if (e.request.mode === 'navigate') {
    // page: try the network, fall back to the cached shell when offline
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(SW_VER).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (p.startsWith('/js/') || p.startsWith('/css/') || p.startsWith('/vendor/') ||
      p.startsWith('/icons/') || p === '/manifest.webmanifest') {
    // static: cache-first (the ?v=N query keeps entries versioned)
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SW_VER).then(c => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
