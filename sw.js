const CACHE = 'bsc-ops-v1';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Pass through to network — do not intercept external requests
  const url = e.request.url;
  if (url.includes('graph.microsoft.com') ||
      url.includes('login.microsoftonline.com') ||
      url.includes('hooks.slack.com') ||
      url.includes('alcdn.msauth.net') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('sharepoint.com') ||
      url.includes('connect.squareup.com') ||
      !url.startsWith(self.location.origin)) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
