const APP_V    = 'lake22-app-v1';
const TILE_V   = 'lake22-tiles-v1';
const SHELL    = [
  './',
  './index.html',
  './manifest.json',
  './Lake_22_Trail.gpx',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP_V)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== APP_V && k !== TILE_V).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // USGS map tiles — cache-first, network fallback
  if (url.includes('nationalmap.gov')) {
    e.respondWith(
      caches.open(TILE_V).then(cache =>
        cache.match(url).then(hit => {
          if (hit) return hit;
          return fetch(e.request).then(res => {
            // cache cors (ok) and opaque (status 0) responses; skip errors
            if (res.ok || res.type === 'opaque') cache.put(url, res.clone());
            return res;
          }).catch(() => new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // App shell + CDN assets — cache-first, network fallback, cache on miss
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const u = new URL(url);
          if (u.origin === self.location.origin || u.hostname.includes('unpkg.com')) {
            caches.open(APP_V).then(c => c.put(e.request, res.clone()));
          }
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
