/* LASTPICK service worker: works offline during the pick phase.
 *  - pages: network first, cached shell when offline;
 *  - /data/*.json: network first (refreshed daily), cache when offline;
 *  - hashed assets, portraits, medals, icons, fonts: cache first.
 * Bump VERSION to drop old caches. */
const VERSION = 'lastpick-v1';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(fallbackUrl ?? request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(fallbackUrl ?? request, { ignoreSearch: !!fallbackUrl });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // only real files: a missing portrait is rewritten to index.html (text/html)
  if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, '/'));
    return;
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/builds/')) event.respondWith(networkFirst(req));
    else if (/^\/(assets|heroes|ranks|icons|brand)\//.test(url.pathname) || url.pathname === '/favicon.svg') event.respondWith(cacheFirst(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') event.respondWith(cacheFirst(req));
});
