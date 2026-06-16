# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Washington Trails** — an offline-capable hiking PWA for iPhone. It shows 8 Washington
State trails on USGS topographic maps with the GPX track overlaid, live GPS position,
waypoints, and an elevation profile. Built to work with **no cell signal** on the trail
once installed to the home screen via Safari.

- **Live site:** https://huangwaylon.github.io/gpx/
- **Stack:** plain HTML/CSS/JS + Leaflet 1.9.4 (from unpkg CDN). **No framework, no build
  step, no server, no transpiler.** Files are served verbatim from GitHub Pages.
- **Hosting:** GitHub Pages, repo root, `.nojekyll` present.

## Golden rules

1. **Never add a build step or framework.** The whole design depends on being a static,
   zero-tooling site that deploys to GitHub Pages and caches cleanly offline. If you think
   you need React/Vite/TypeScript/npm — you don't. Match the existing vanilla style.
2. **Never commit the `alltrails/` folder.** It's ~166 MB of saved AllTrails source pages
   (`.html`/`.webarchive`/`.gpx`) and is git-ignored. Only the ~3.4 MB app deploys.
   GitHub Pages has a **hard 100 MB per-file** and soft 1 GB repo limit.
3. **The service worker will serve you stale code during development.** After editing
   `app.js`/`app.css`/`index.html`, a plain reload shows the OLD cached version. You must
   clear the SW + caches (see Development below). This bit us repeatedly.
4. **Don't "fix" the elevation-gain stat to use the GPX file.** The displayed gain comes
   from AllTrails' DEM-based number on purpose; raw GPX elevation over-counts ~50–60% due
   to GPS noise. See `docs/DATA-PIPELINE.md` and ADR-4 in `docs/DECISIONS-AND-LESSONS.md`.
5. **Verify changes in a real browser, including offline.** There are no automated tests.
   Stop the dev server and reload to prove offline still works.

## Layout

| Path | Role |
|---|---|
| `index.html` | App shell — `#list` and `#detail` `<section class="screen">`, modals |
| `app.js` | All logic — routing, map, GPX parse, GPS, elevation, tile download |
| `app.css` | Dark, mobile-first, responsive styles (custom properties, safe-area insets) |
| `trails.js` | The data model — `window.TRAILS` array of 8 trail objects |
| `sw.js` | Service worker — precaches shell+GPX+images; cache-first map tiles |
| `manifest.json`, `icon.svg` | PWA install metadata + icon |
| `gpx/` | 8 GPX tracks (committed, parsed at runtime) |
| `images/` | 8 WebP hero photos (1200×800, ~2 MB total) |
| `alltrails/` | **git-ignored** raw source pages used to build the data |
| `docs/` | Full documentation suite (see below) |

## Architecture in one breath

One HTML document, two screens toggled by the `hidden` attribute. **Hash routing**:
`#/trail/<slug>` → `openDetail()`; empty hash → `showList()`; `routeFromHash()` runs on load
and `hashchange`. The list renders cards from `window.TRAILS`. The detail screen builds a
Leaflet map (`initMap`), fetches+parses the GPX (`loadTrail` → `drawTrack`/`drawProfile`),
and shows a draggable bottom sheet. GPS uses `watchPosition`. Offline is three tiers:
SW precache (shell+GPX+images) → cache-first tiles → manual per-trail tile download.
Full detail in `docs/ARCHITECTURE.md`.

## Development

Serve over HTTP (service workers and GPX `fetch()` do **not** work from `file://`):

```bash
python3 -m http.server 8743
# open http://localhost:8743/
```

After editing shell files, clear the service worker + caches or you'll see stale output.
Paste into the DevTools console:

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

(Or DevTools → Application → Storage → **Clear site data**.) To ship an update to returning
users, bump `APP_V` in `sw.js` — the `activate` handler purges old caches.

## Adding a trail (short version)

1. Drop the GPX in `gpx/`, a 1200×800 WebP hero in `images/<slug>.webp`.
2. Add a trail object to `window.TRAILS` in `trails.js` (copy an existing entry for the
   exact field shape: `slug, name, area, img, gpx, rating, reviews, lengthMi, gainFt, diff,
   route, time, season, dogs, permit, center, summary, description, tips`).
3. Register the GPX path **and** image path in `TRAIL_ASSETS` in `sw.js` (so they precache).
4. Update the hard-coded "8 trails" copy in `index.html` and `README.md` if the count changes.

Full sourcing/extraction process (JSON-LD scraping, webarchive image extraction, URL
upscaling, elevation calibration) is in `docs/DATA-PIPELINE.md`. Step-by-step contributor
workflow is in `docs/DEVELOPMENT.md`.

## Deployment

Push to `main`; GitHub Pages serves the repo root. Pages must be enabled in repo
Settings → Pages (branch `main`, root `/`). `.nojekyll` disables Jekyll.

## Key iOS PWA constraints (why the app is shaped this way)

- **No background anything** — no Background Sync/Fetch, and JS suspends when the screen
  locks. Hence tiles are downloaded by an explicit foreground button, and GPS only works
  with the screen on.
- **7-day storage eviction** — iOS clears caches after a week of non-use; downloaded tiles
  can vanish. `refreshCacheStatus()` re-checks per trail on load.
- **Wake Lock** is unreliable in standalone PWAs before iOS 18.4; there's no video-loop
  fallback yet (known gap). Advise users to raise Auto-Lock.
- **Install is manual** (no `beforeinstallprompt`) — the app shows its own install banner.

Full reference: `docs/IOS-PWA-GUIDE.md`.

## Documentation suite (`docs/`)

| File | Read it when… |
|---|---|
| `ARCHITECTURE.md` | You need the canonical, code-grounded design reference (every subsystem) |
| `DEVELOPMENT.md` | You're running locally, testing, deploying, or adding a trail |
| `IOS-PWA-GUIDE.md` | You're touching offline, GPS, install, caching, or iOS behavior |
| `DATA-PIPELINE.md` | You're sourcing/extracting trail data, images, or stats |
| `DECISIONS-AND-LESSONS.md` | You want the "why" (ADRs) and the bugs/lessons from the build |

## Known issues / cleanup opportunities

These were surfaced while documenting; none are blocking, but don't be surprised by them:

- **Dead "Easy" filter chip** — all 8 trails are Moderate/Hard/Very Hard, so the "Easy"
  filter matches zero trails. (`Easy` is still a valid `diff` value in the badge logic.)
- **Dead CSS** — `.card-offline.no` is styled but never emitted; uncached trails render no
  badge at all.
- **Unused variables in `app.js`** — `markerLayer`, `gpsLayer`, and the `MI` constant are
  declared but unused; `sheetState: 'hidden'` is in the nominal state set but never set.
- **Deprecated meta tag** — `apple-mobile-web-app-capable` logs a deprecation warning;
  add `mobile-web-app-capable` alongside it.
- **Offline badge is a heuristic** — `refreshCacheStatus()` samples one z14 center tile per
  trail, so a partially-downloaded trail can still show the green ✓.
