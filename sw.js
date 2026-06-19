const APP_V = 'wa-trails-app-v20';   // bumped: completion-manifest offline-download fix + GPS/lifecycle correctness fixes

importScripts('./tiles-db.js');       // shared store → self.TileStore (also loaded by the page)

const SHELL = [
  './', './index.html', './app.css', './app.js', './trails.js', './i18n.js', './tiles-db.js',
  './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Trail GPX + hero images (bundled, cached on install for full offline)
const TRAIL_ASSETS = [
  // Washington (8)
  'gpx/Lake_22_Trail.gpx','gpx/Snow_Lake_Trail.gpx','gpx/Lake_Valhalla_Trail.gpx',
  'gpx/Talapus_Lake_Trail.gpx','gpx/Mount_Pilchuck_Trail.gpx',
  'gpx/Bridal_Veil_Falls_and_Lunch_Rock_via_Lake_Serene_Trail.gpx',
  'gpx/Skyline_Loop.gpx','gpx/The_Enchantments_Traverse.gpx',
  'images/lake-22.webp','images/snow-lake.webp','images/lake-valhalla.webp',
  'images/talapus-lake.webp','images/mount-pilchuck.webp','images/bridal-veil.webp',
  'images/skyline-loop.webp','images/enchantments.webp',
  // Japan (2)
  'gpx/Mt_Fuji_Yoshida.gpx','gpx/Mount_Kinpu_Odarumi.gpx',
  'images/fuji-yoshida.webp','images/kinpu-odarumi.webp',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_V);
    // Precache bypassing the HTTP cache ({cache:'reload'}) so a new version never stores a STALE
    // copy of a shell file — e.g. an index.html missing a freshly-added script. Shell must
    // succeed; trail assets are best-effort so one failure can't abort install.
    await Promise.all(SHELL.map(async u => {
      const res = await fetch(u, { cache: 'reload' });
      if (!res.ok) throw new Error('precache failed: ' + u);
      await c.put(u, res);
    }));
    await Promise.allSettled(TRAIL_ASSETS.map(async u => {
      const res = await fetch(u, { cache: 'reload' });
      if (res.ok) await c.put(u, res);
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // The shell cache is now the ONLY cache — drop everything else, including the old
    // wa-trails-tiles-v1 tile cache (tiles live in IndexedDB now). Freeing that big cache
    // is also what restores fast launch for users upgrading from a tiles-in-Cache build.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== APP_V).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

const isTile = url => url.includes('nationalmap.gov') || url.includes('cyberjapandata.gsi.go.jp');

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Map tiles (USGS topo for US trails, GSI 地理院タイル for Japan) — IndexedDB-first, fill on miss.
  // Stored bytes are replayed as a fresh Response; both sources are CORS so the body is readable.
  if (isTile(url)) {
    e.respondWith((async () => {
      try {
        const rec = await TileStore.get(url);
        if (rec) return new Response(rec.body, { headers: { 'Content-Type': rec.type } });
      } catch (_) {}
      try {
        const res = await fetch(e.request);
        if (res.ok) {                                   // keep the SW alive to finish the write
          const type = res.headers.get('Content-Type') || 'image/png';
          e.waitUntil(res.clone().arrayBuffer().then(body => TileStore.put(url, { body, type })).catch(() => {}));
        }
        return res;
      } catch (_) { return new Response('', { status: 503 }); }
    })());
    return;
  }

  // App shell + bundled assets — cache-first, scoped to APP_V. (A global caches.match() can make
  // WebKit open/scan unrelated caches; scoping keeps shell serving off any large store.)
  e.respondWith(caches.open(APP_V).then(cache =>
    cache.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) {
        const u = new URL(url);
        if (u.origin === self.location.origin || u.hostname.includes('unpkg.com'))
          cache.put(e.request, res.clone());
      }
      return res;
    }).catch(() => e.request.mode === 'navigate' ? cache.match('./index.html') : new Response('', { status: 503 })))
  ));
});
