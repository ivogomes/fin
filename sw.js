/* Service worker: keeps the app's own files so it opens instantly and installs as an app.
   Your data isn't cached here: it always comes from the database (other origins pass straight through).
   Files are served from the cache and refreshed in the background, so a new deploy shows on the next
   visit; bump CACHE to drop everything at once. */
const CACHE = 'finance-v27';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './model.js',
  './store.js',
  './cloud.js',
  './market.js',
  './zip.js',
  './config.js',
  './finance.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  '/src/tokens.css',
  '/src/tools.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only this site's own GET requests; the database, exchange rates and prices go to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first, so the latest shows when online; the cached page when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Scripts, styles and icons: from the cache straight away, refreshed in the background.
  e.respondWith(
    caches.open(CACHE).then((cache) => cache.match(req, { ignoreSearch: true }).then((hit) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit ?? fresh;
    })),
  );
});
