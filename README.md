# Ume-chan's Trails 梅ちゃんのトレイル

An offline-capable hiking PWA for iPhone. Browse 10 trails — 8 in Washington State (USA) and
2 in Japan (Mt. Fuji and the Yamanashi mountains) — view topographic maps with GPX tracks, see
live GPS position, elevation profiles, and full trail details — all working offline once cached.
The interface is **bilingual: Japanese by default, with a one-tap toggle to English**.

## Features

- **Bilingual UI (日本語 / English)** — Japanese by default; everything is translated,
  including trail descriptions, map labels, and units (km/m in JA, mi/ft in EN)
- **10 curated trails** (8 USA + 2 Japan) with stats, descriptions, tips, and photos (data via AllTrails)
- **Topographic maps** — USGS National Map for US trails, GSI 地理院タイル (Geospatial
  Information Authority of Japan) for Japan trails, with the route, waypoints, and trailhead
- **Live GPS** — your location plotted on the map and the elevation profile
- **Elevation profiles** drawn from the GPX track
- **Offline first** — app shell, trail data, GPX, and hero images are cached on install;
  tap *Save maps* to cache every trail's map tiles at once, or save a single trail from its
  card, for no-signal use
- **Responsive** — works in portrait and landscape on iPhone

## Install on iPhone

1. Open the site in **Safari**
2. Tap **Share → Add to Home Screen**
3. Launch from the home screen for full-screen, offline use

Before heading out: tap **Save maps** (in the list header) while on Wi-Fi to cache every
trail's tiles — or tap the download button on a single trail's card to save just that one.
The app keeps the screen awake while a hike is active, so the map stays visible as you navigate.

## Tech

Static site — no build step, no server. Plain HTML/CSS/JS + [Leaflet](https://leafletjs.com).
Deployable to GitHub Pages as-is.

- `index.html` — app shell (list + detail screens)
- `app.js` — i18n, routing, map (per-trail tile source), GPX parsing, GPS, elevation, global + per-trail tile download
- `i18n.js` — UI strings, unit formatting, and per-trail Japanese translations
- `app.css` — light "paper", mobile-first, responsive styles
- `trails.js` — trail metadata (English base content)
- `gpx/` — GPX tracks · `images/` — hero photos
- `sw.js` — service worker (offline caching)
- `tiles-db.js` — IndexedDB store for saved map tiles (shared by the page and the service worker)

## Documentation

Thorough docs live in [`docs/`](docs/) — architecture, internationalization, development
guide, iOS PWA constraints, the data pipeline, and decisions/lessons. See [`CLAUDE.md`](CLAUDE.md)
for a quick orientation and the golden rules. Start at [`docs/README.md`](docs/README.md).

Map tiles © USGS National Map (US) and © 国土地理院 / 地理院タイル — GSI Japan (Japan trails).
Trail info & photos via AllTrails.
