# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Ume-chan's Trails** (梅ちゃんのトレイル) — an offline-capable hiking PWA for iPhone.
It shows 10 trails — **8 in Washington State (USA)** and **2 in Japan** (Mt. Fuji's Yoshida
route and Mt. Kinpu in the Yamanashi mountains) — on topographic maps with the GPX track overlaid, live GPS position,
waypoints, and an elevation profile. The profile is **scrubbable** (drag a finger to inspect
any point — a readout pill plus a synced marker on the map), and a **live trail-progress**
mode fills the walked portion green and tracks elapsed time. US trails use **USGS** topo tiles;
Japan trails use
**GSI 地理院タイル** (Geospatial Information Authority of Japan). Built to work with **no
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
2. **The service worker will serve you stale code during development.** After editing
   `app.js`/`app.css`/`index.html`/`i18n.js`, a plain reload shows the OLD cached version.
   You must clear the SW + caches (see Development below). This bites every time.
3. **Don't shadow Leaflet's global `L`.** A localization helper was once named `L()` and it
   silently overwrote Leaflet's `window.L`, breaking the map (`L.polyline is not a function`).
   The helper is now `loc()`. Keep `L` reserved for Leaflet.
4. **Don't "fix" the elevation-gain stat to use the GPX file.** The displayed gain comes
   from AllTrails' DEM-based number on purpose; raw GPX elevation over-counts ~50–60% due
   to GPS noise. See `docs/DATA-PIPELINE.md` and ADR-4 in `docs/DECISIONS-AND-LESSONS.md`.
5. **Keep both languages complete.** Any new user-facing string must be added to `i18n.js`
   for **both** `en` and `ja`. Any new trail needs a Japanese block in `I18N.trails`. See
   `docs/I18N.md`.
6. **Verify changes in a real browser, including offline and in both languages.** There are
   no automated tests. Stop the dev server and reload to prove offline still works.
7. **Pick the basemap by region; never hardcode one tile URL.** US trails use USGS topo,
   Japan trails use GSI 地理院タイル — selected per trail via the `tiles` field and the
   `TILE_SOURCES` map in `app.js`. USGS templates are `{z}/{y}/{x}`, GSI is `{z}/{x}/{y}`; the
   tile math substitutes tokens by name, so keep the right order in each template. Any new tile
   host must also be added to the cache-first branch in `sw.js`.
8. **One global "download all maps" button — don't reintroduce per-trail downloads.** Offline
   tiles are fetched by the single `#dl-all` button (next to the language toggle), which caches
   every trail across both sources. The old per-trail download button, the download modal, and
   the per-card offline ✓ badge were deliberately removed; the button's own idle / percent /
   done state is the single source of truth.

## Layout

| Path | Role |
|---|---|
| `index.html` | App shell — `#list` and `#detail` `<section class="screen">`; the global "download all maps" button (`#dl-all`) sits in the header next to the language toggle. Static text carries `data-i18n` keys. `<html lang="ja">` |
| `app.js` | All logic — i18n, routing, map (per-trail tile source via `TILE_SOURCES`), GPX parse, GPS, elevation, global tile download |
| `i18n.js` | `window.I18N` — UI strings, dynamic-string fns, enum tables, waypoint names, and per-trail Japanese content |
| `app.css` | Dark, mobile-first, responsive styles (custom properties, safe-area insets, CJK font stack) |
| `trails.js` | The data model — `window.TRAILS` array of 10 trail objects (8 US + 2 Japan; English base content). Optional `tiles` field picks the basemap (USGS default; `"gsi"` for Japan) |
| `sw.js` | Service worker — precaches shell+i18n+GPX+images; cache-first map tiles (USGS + GSI) |
| `manifest.json`, `icon-{180,192,512}.png` | PWA install metadata + Home-Screen icon (cropped from the Enchantments photo) |
| `gpx/` | 10 GPX tracks (committed, parsed at runtime) |
| `images/` | 10 WebP hero photos (1200×800) |
| `alltrails/` | Raw AllTrails source. The `.html` + `.gpx` exports (~8 MB) are committed for provenance; the heavy `.webarchive` captures are kept locally but **git-ignored** (they embed third-party secret tokens). Neither is referenced or served by the app |
| `docs/` | Full documentation suite (see below) |

## Architecture in one breath

One HTML document, two screens toggled by the `hidden` attribute. **Hash routing**:
`#/trail/<slug>` → `openDetail()`; empty hash → `showList()`. The list renders cards from
`window.TRAILS` (10 trails), merged with Japanese content from `I18N.trails` via `loc(trail)`.
The detail screen builds a Leaflet map (`initMap`) using the trail's tile source
(`TILE_SOURCES` — USGS for US, GSI for Japan, chosen by each trail's optional `tiles` field),
fetches+parses the GPX (`loadTrail` → `drawTrack`/`drawProfile`), and shows a draggable bottom
sheet. GPS uses `watchPosition`. Two interactive layers sit on top: **scrubbing** the elevation
profile (`initProfileScrub`/`drawProfileCursor` → `pointAtDistance`) drags a synced marker along
the trail with an elevation/distance readout; **live tracking** (`startTracking`/`updateProgress`
→ `recolorProgress`, toggled by the `#btn-track` FAB) snaps each GPS fix to the trail with a
windowed-forward search, fills the walked portion green over the red base, and shows percent +
elapsed in the `#track-hud` banner (out-and-back progress locks at the far end so the return leg
doesn't un-color). Offline is three tiers: SW precache (shell+i18n+GPX+images) →
cache-first tiles (both hosts) → a **single global "download all maps" button** (`downloadAll`)
in the list header that pre-caches every trail's tiles across both sources. Full detail in
`docs/ARCHITECTURE.md`.

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
users, bump `APP_V` in `sw.js` (currently `wa-trails-app-v9`) — the `activate` handler purges
old caches. Reset language during testing with `localStorage.removeItem('lang')`.

## Adding a trail (short version)

1. Drop the GPX in `gpx/`, a 1200×800 WebP hero in `images/<slug>.webp`.
2. Add a trail object to `window.TRAILS` in `trails.js` (English base content — copy an
   existing entry for the exact field shape). For a non-US trail, set `tiles: "gsi"` so it uses
   the GSI 地理院タイル basemap (US trails omit `tiles` and default to USGS).
3. Add a `"<slug>": { ja: { … } }` block to `I18N.trails` in `i18n.js` with the Japanese
   `name, area, summary, description, permit, tips`. Translate any new GPX waypoint names
   into `I18N.wpt`.
4. Register the GPX path **and** image path in `TRAIL_ASSETS` in `sw.js` (so they precache),
   and bump `APP_V` so returning users pick up the new asset list.
5. The list subtitle no longer shows a trail count, so no copy needs updating when the count changes.

Full sourcing/extraction process is in `docs/DATA-PIPELINE.md`; translation conventions in
`docs/I18N.md`; step-by-step contributor workflow in `docs/DEVELOPMENT.md`.

## Deployment

Push to `main`; GitHub Pages serves the repo root. Pages must be enabled in repo
Settings → Pages (branch `main`, root `/`). `.nojekyll` disables Jekyll.

Mind GitHub's limits **and secret-scanning push protection**: a **hard 100 MB per-file** cap
(a larger file makes `git push` fail) and a soft 1 GB repo limit. The committed `alltrails/`
source (`.html` + `.gpx`, ~8 MB) keeps the whole repo around ~13 MB — well under both. The
`.webarchive` captures are **git-ignored**: they're large and embed third-party secret tokens
(a Mapbox token) that push protection rejects, so they must not be committed.

## Key iOS PWA constraints (why the app is shaped this way)

- **No background anything** — no Background Sync/Fetch, and JS suspends when the screen
  locks. Hence tiles are downloaded by an explicit foreground button (one tap caches every
  trail), and GPS only works with the screen on.
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
- The per-trail "Download map for offline" button, the `#dl-modal` download modal, and the
  per-card offline ✓ badge were all removed in favor of one global "download all maps" button
  (`#dl-all`) in the header — it downloads every trail's tiles across both sources at once.

Still open: the global download button's "✓ saved" state is a heuristic
(`refreshCacheStatus()` samples one z14 center tile per trail and requires all of them to be
present), so a partially-downloaded set can still flip it to ✓; and there's no Wake-Lock video
fallback for iOS < 18.4.
