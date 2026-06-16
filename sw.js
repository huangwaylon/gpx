const APP_V  = 'wa-trails-app-v6';
const TILE_V = 'wa-trails-tiles-v1';

const SHELL = [
  './', './index.html', './app.css', './app.js', './trails.js', './i18n.js',
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
  // Japan (5)
  'gpx/Mt_Fuji_Yoshida.gpx','gpx/Mt_Fuji_Gotemba.gpx',
  'gpx/Mount_Daibosatsu_Loop.gpx','gpx/Mount_Kinpu_Kanayama.gpx',
  'gpx/Mount_Kinpu_Odarumi.gpx',
  'images/fuji-yoshida.webp','images/fuji-gotemba.webp',
  'images/daibosatsu.webp','images/kinpu.webp','images/kinpu-odarumi.webp',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_V);
    // shell must succeed; trail assets best-effort
    await c.addAll(SHELL);
    await Promise.allSettled(TRAIL_ASSETS.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k!==APP_V && k!==TILE_V).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Map tiles (USGS topo for US trails, GSI 地理院タイル for Japan) — cache-first
  if (url.includes('nationalmap.gov') || url.includes('cyberjapandata.gsi.go.jp')) {
    e.respondWith(caches.open(TILE_V).then(cache =>
      cache.match(url).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok || res.type==='opaque') cache.put(url, res.clone());
        return res;
      }).catch(() => new Response('', {status:503})))
    ));
    return;
  }

  // App shell + bundled assets — cache-first, fill on miss
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok) {
      const u = new URL(url);
      if (u.origin === self.location.origin || u.hostname.includes('unpkg.com'))
        caches.open(APP_V).then(c => c.put(e.request, res.clone()));
    }
    return res;
  }).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : new Response('', {status:503}))));
});
