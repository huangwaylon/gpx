# Washington Trails

An offline-capable hiking PWA for iPhone. Browse 8 Washington State trails, view
topographic maps with GPX tracks, see live GPS position, elevation profiles, and
full trail details — all working offline once cached.

## Features

- **8 curated WA trails** with stats, descriptions, tips, and photos (data via AllTrails)
- **USGS topographic maps** (public domain) with the trail route, waypoints, and trailhead
- **Live GPS** — your location plotted on the map and the elevation profile
- **Elevation profiles** drawn from the GPX track
- **Offline first** — app shell, trail data, GPX, and hero images are cached on install;
  tap *Download map for offline* on a trail to cache its map tiles for no-signal use
- **Responsive** — works in portrait and landscape on iPhone

## Install on iPhone

1. Open the site in **Safari**
2. Tap **Share → Add to Home Screen**
3. Launch from the home screen for full-screen, offline use

Before heading out: open each trail you'll hike and tap **Download map for offline**
while on Wi-Fi. Set *Auto-Lock* to a longer interval (Settings → Display & Brightness)
so the screen stays on while navigating.

## Tech

Static site — no build step, no server. Plain HTML/CSS/JS + [Leaflet](https://leafletjs.com).
Deployable to GitHub Pages as-is.

- `index.html` — app shell (list + detail screens)
- `app.js` — routing, map, GPX parsing, GPS, elevation, tile download
- `app.css` — dark, mobile-first, responsive styles
- `trails.js` — trail metadata
- `gpx/` — GPX tracks · `images/` — hero photos
- `sw.js` — service worker (offline caching)

## Documentation

Thorough docs live in [`docs/`](docs/) — architecture, development guide, iOS PWA
constraints, the data pipeline, and decisions/lessons. See [`CLAUDE.md`](CLAUDE.md) for a
quick orientation and the golden rules. Start at [`docs/README.md`](docs/README.md).

Map tiles © USGS National Map. Trail info & photos via AllTrails.
