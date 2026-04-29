const CACHE = 'bsc-ops-v19';
const STATIC_ASSETS = ['/images/icon-180.png', '/images/icon-192.png', '/images/icon-512.png', '/images/BSC%20Ops%20Logo%20V3%20Transparent.png', '/images/BSC%20Ops%20Logo%20V3%20Animated.gif', '/images/Square%20Sync%20Icon.png', '/images/feather.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept cross-origin, API, or auth requests
  if (!url.origin.startsWith(self.location.origin)) return;
  if (url.pathname.startsWith('/api/')) return;

  const isHTML = e.request.mode === 'navigate' ||
                 (e.request.headers.get('accept') || '').includes('text/html');
  const isJS = url.pathname.endsWith('.js');

  // Network-first for HTML — users must see the new app shell immediately after a deploy
  if (isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Stale-while-revalidate for JS — returning users boot instantly from cache while
  // fresh code downloads in the background. Safe because each deploy bumps
  // APP_VERSION, so new HTML references new ?v=… URLs → cache miss → network fetch.
  if (isJS) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const networkPromise = fetch(e.request).then(resp => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return resp;
        }).catch(() => cached); // network failed → use cached copy if we have one
        return cached || networkPromise;
      })
    );
    return;
  }

  // Cache-first for static assets (images, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp.ok && resp.type === 'basic') {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return resp;
    }))
  );
});
