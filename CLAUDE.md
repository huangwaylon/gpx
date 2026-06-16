# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Ume-chan's Trails** (梅ちゃんのトレイル) — an offline-capable hiking PWA for iPhone.
It shows 8 trails (in Washington State, USA) on USGS topographic maps with the GPX track
overlaid, live GPS position, waypoints, and an elevation profile. Built to work with **no
cell signal** on the trail once installed to the home screen via Safari.

The UI is **bilingual**: **Japanese is the default**, with a one-tap toggle to English.
All user-facing text — UI chrome, trail names/descriptions/tips, map waypoint labels, units —
is fully translated.

- **Live site:** https://huangwaylon.github.io/gpx/
- **Stack:** plain HTML/CSS/JS + Leaflet 1.9.4 (from unpkg CDN). **No framework, no build
  step, no server, no transpiler.** Files are served verbatim from GitHub Pages.
- **Hosting:** GitHub Pages, repo root, `.nojekyll` present.

## Golden rules

1. **Never add a build step or framework.** The whole design depends on being a static,
   zero-tooling site that deploys to GitHub Pages and caches cleanly offline. If you think
   you need React/Vite/TypeScript/npm — you don't. Match the existing vanilla style.
2. **Never commit the `alltrails/` folder.** It's ~166 MB of saved AllTrails source pages
   (`.html`/`.webarchive`/`.gpx`) and is git-ignored. Only the ~3.5 MB app deploys.
   GitHub Pages has a **hard 100 MB per-file** and soft 1 GB repo limit.
3. **The service worker will serve you stale code during development.** After editing
   `app.js`/`app.css`/`index.html`/`i18n.js`, a plain reload shows the OLD cached version.
   You must clear the SW + caches (see Development below). This bites every time.
4. **Don't shadow Leaflet's global `L`.** A localization helper was once named `L()` and it
   silently overwrote Leaflet's `window.L`, breaking the map (`L.polyline is not a function`).
   The helper is now `loc()`. Keep `L` reserved for Leaflet.
5. **Don't "fix" the elevation-gain stat to use the GPX file.** The displayed gain comes
   from AllTrails' DEM-based number on purpose; raw GPX elevation over-counts ~50–60% due
   to GPS noise. See `docs/DATA-PIPELINE.md` and ADR-4 in `docs/DECISIONS-AND-LESSONS.md`.
6. **Keep both languages complete.** Any new user-facing string must be added to `i18n.js`
   for **both** `en` and `ja`. Any new trail needs a Japanese block in `I18N.trails`. See
   `docs/I18N.md`.
7. **Verify changes in a real browser, including offline and in both languages.** There are
   no automated tests. Stop the dev server and reload to prove offline still works.

## Layout

| Path | Role |
|---|---|
| `index.html` | App shell — `#list` and `#detail` `<section class="screen">`, modal. Static text carries `data-i18n` keys. `<html lang="ja">` |
| `app.js` | All logic — i18n, routing, map, GPX parse, GPS, elevation, tile download |
| `i18n.js` | `window.I18N` — UI strings, dynamic-string fns, enum tables, waypoint names, and per-trail Japanese content |
| `app.css` | Dark, mobile-first, responsive styles (custom properties, safe-area insets, CJK font stack) |
| `trails.js` | The data model — `window.TRAILS` array of 8 trail objects (English base content) |
| `sw.js` | Service worker — precaches shell+i18n+GPX+images; cache-first map tiles |
| `manifest.json`, `icon.svg` | PWA install metadata + icon (Japanese name) |
| `gpx/` | 8 GPX tracks (committed, parsed at runtime) |
| `images/` | 8 WebP hero photos (1200×800, ~2 MB total) |
| `alltrails/` | **git-ignored** raw source pages used to build the data |
| `docs/` | Full documentation suite (see below) |

## Architecture in one breath

One HTML document, two screens toggled by the `hidden` attribute. **Hash routing**:
`#/trail/<slug>` → `openDetail()`; empty hash → `showList()`. The list renders cards from
`window.TRAILS`, merged with Japanese content from `I18N.trails` via `loc(trail)`. The detail
screen builds a Leaflet map (`initMap`), fetches+parses the GPX (`loadTrail` →
`drawTrack`/`drawProfile`), and shows a draggable bottom sheet. GPS uses `watchPosition`.
Offline is three tiers: SW precache (shell+i18n+GPX+images) → cache-first tiles → manual
per-trail tile download. Full detail in `docs/ARCHITECTURE.md`.

## Internationalization (i18n)

- **Default language is Japanese.** `lang` resolves from `localStorage.lang`, falling back
  to `'ja'`. The "EN / 日本語" button in the list header toggles and persists the choice.
- `t(key)` → static UI string; `tf(key)` → dynamic-string function; `loc(trail)` → trail
  object with Japanese fields merged in when `lang==='ja'`.
- Enum/token helpers: `trDiff`, `trRoute`, `trDogs`, `trSeason`, `trWpt` (waypoint names),
  `fmtDist`/`fmtGain`/`fmtTime`/`fmtElevRange` (units: **km/m in JA, mi/ft in EN**).
- `applyStaticI18n()` fills every `[data-i18n]` / `[data-i18n-aria]` node and `<title>`.
- `setLang()` re-renders the list and any open detail view, and re-labels map markers
  (`redrawTrailLabels`) live without reload.
- Full reference + how to add strings/trails/languages: `docs/I18N.md`.

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
users, bump `APP_V` in `sw.js` (currently `wa-trails-app-v3`) — the `activate` handler purges
old caches. Reset language during testing with `localStorage.removeItem('lang')`.

## Adding a trail (short version)

1. Drop the GPX in `gpx/`, a 1200×800 WebP hero in `images/<slug>.webp`.
2. Add a trail object to `window.TRAILS` in `trails.js` (English base content — copy an
   existing entry for the exact field shape).
3. Add a `"<slug>": { ja: { … } }` block to `I18N.trails` in `i18n.js` with the Japanese
   `name, area, summary, description, permit, tips`. Translate any new GPX waypoint names
   into `I18N.wpt`.
4. Register the GPX path **and** image path in `TRAIL_ASSETS` in `sw.js` (so they precache).
5. Update the trail-count copy (`subtitle` in `i18n.js`, both languages) if the count changes.

Full sourcing/extraction process is in `docs/DATA-PIPELINE.md`; translation conventions in
`docs/I18N.md`; step-by-step contributor workflow in `docs/DEVELOPMENT.md`.

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
- **Install is manual** (no `beforeinstallprompt`). The app no longer shows an install
  banner — installation is left to the user via Safari → Share → Add to Home Screen.

Full reference: `docs/IOS-PWA-GUIDE.md`.

## Documentation suite (`docs/`)

| File | Read it when… |
|---|---|
| `ARCHITECTURE.md` | You need the canonical, code-grounded design reference (every subsystem) |
| `I18N.md` | You're touching translations, units, the language toggle, or adding a string/trail/language |
| `DEVELOPMENT.md` | You're running locally, testing, deploying, or adding a trail |
| `IOS-PWA-GUIDE.md` | You're touching offline, GPS, install, caching, or iOS behavior |
| `DATA-PIPELINE.md` | You're sourcing/extracting trail data, images, or stats |
| `DECISIONS-AND-LESSONS.md` | You want the "why" (ADRs) and the bugs/lessons from the build |

## Resolved cleanups (history)

These were flagged earlier and have since been addressed; noted so they don't get
"re-discovered":

- The dead **"Easy" filter chip** was removed (no trails are Easy-rated).
- The install banner and its `#install` markup/CSS/JS were removed per product decision.
- Unused `markerLayer`, `gpsLayer`, and `MI` were removed from `app.js`.
- `mobile-web-app-capable` was added alongside the deprecated `apple-mobile-web-app-capable`.
- The `L()` localization helper was renamed `loc()` to stop shadowing Leaflet's global `L`.

Still open: the offline badge is a heuristic (`refreshCacheStatus()` samples one z14 center
tile per trail), so a partially-downloaded trail can show the green ✓; and there's no
Wake-Lock video fallback for iOS < 18.4.
