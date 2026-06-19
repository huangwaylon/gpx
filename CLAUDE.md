# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Ume-chan's Trails** (梅ちゃんのトレイル) — an offline-capable hiking PWA for iPhone.
It shows 10 trails — **8 in Washington State (USA)** and **2 in Japan** (Mt. Fuji's Yoshida
route and Mt. Kinpu in the Yamanashi mountains) — on topographic maps with the GPX track overlaid, live GPS position,
waypoints, and an elevation profile. The profile is **scrubbable** (drag a finger to inspect
any point — a readout pill plus a synced marker on the map); the inspected point **persists** when
you let go (a tap reveals it, a tap clears it), and a **live trail-progress**
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
   host must also be added to the tile branch (`isTile`) in `sw.js` so its tiles are served from
   (and saved to) the IndexedDB tile store (`tiles-db.js`).
8. **Two coexisting download affordances — the global "save all" and a per-trail button.** Offline
   tiles are fetched by the global `#dl-all` button in the header (caches every trail across both
   sources) **and** by a per-trail button on each list card's top-right (`.card-dl`, caches just that
   trail). Both share one engine: `saveTiles()` (the fetch/commit loop), `trailTileURLs()`, and the
   `trailSaved()` check; the global path is `downloadAll` (a per-trail loop over `downloadTrail`), the
   per-trail path is `downloadOne(slug)`. Each button's own idle / percent / done state is its single
   source of truth — the old download **modal** and a **separate** per-card ✓ badge stay removed (the
   button's `done` state *is* the badge). **A trail's "✓ saved" is manifest-backed, never a single-tile
   guess:** `done` is set only when `saveTiles` returns `fail===0` (the full expected set committed;
   host 404s count as `absent`, not failures), which writes a completion record to
   `localStorage.tileManifest` (`markSaved`); `trailSaved()`/`refreshCacheStatus()` then report a trail
   saved only if that record exists **and** its multi-zoom probe tiles are still in IndexedDB (so an
   iOS-evicted set is demoted, and tiles the SW cached incidentally while browsing online — which write
   no record — can't fake a ✓). Don't regress this back to an `ok>0` gate or a one-tile probe (ADR-16).
   Per-trail state lives in the `cardDl` slug→state map (+ `cardDlPct` for the busy ring; both survive `renderList`
   re-renders); one delegated `#trail-list` listener handles all card buttons. (Per-trail download was
   removed in an earlier iteration and deliberately re-added on 2026-06-18 — see ADR-15.)


## Layout

| Path | Role |
|---|---|
| `index.html` | App shell — `#list` and `#detail` `<section class="screen">`; the global "save all maps" button (`#dl-all`) sits in the header next to the language toggle (per-trail buttons are rendered into the list cards by `app.js`). Static text carries `data-i18n` keys. `<html lang="ja">` |
| `app.js` | All logic — i18n, routing, map (per-trail tile source via `TILE_SOURCES`), GPX parse, GPS, elevation, global + per-trail tile download |
| `i18n.js` | `window.I18N` — UI strings, dynamic-string fns, enum tables, waypoint names, and per-trail Japanese content |
| `app.css` | Light (paper-cool), mobile-first, responsive styles (custom properties, safe-area insets, CJK font stack) |
| `trails.js` | The data model — `window.TRAILS` array of 10 trail objects (8 US + 2 Japan; English base content). Optional `tiles` field picks the basemap (USGS default; `"gsi"` for Japan) |
| `sw.js` | Service worker — precaches shell+i18n+GPX+images (scoped, cache-first); serves map tiles (USGS + GSI) **from IndexedDB** via `tiles-db.js` |
| `tiles-db.js` | Tiny IndexedDB tile store (`window.TileStore` = get/has/put), shared by the page and the SW (`importScripts`). Saved tiles live here, **not** in Cache Storage, so launch stays fast no matter how many are saved |
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
the trail with an elevation/distance readout that **persists** on release and **toggles by tap**
(tap an empty profile to drop a readout, tap again to clear; the held point is remembered by
distance in `scrubHeld`/`scrubHeldD` so it survives a profile redraw, and GPS/`syncGpsCursor` won't
overwrite it); **live tracking** (`startTracking`/`updateProgress`
→ `recolorProgress`, **started** by the `#btn-track` FAB; **paused/ended from the HUD**, never the
FAB) snaps each GPS fix to the trail with a
windowed-forward search, fills the walked portion green over the red base, and shows percent +
elapsed in the `#track-hud` banner (out-and-back progress locks at the far end so the return leg
doesn't un-color). The tracking session is **mirrored to `localStorage`** (with an absolute start
time) so it survives an iOS reload/eviction mid-hike: a cold relaunch lands **straight back on the
trail and auto-resumes** the live session **regardless of how iOS restored the URL** (`bootRoute()`
decides on the saved session, not on `location.hash` — the old `!location.hash` guard was why
resume was flaky); the elapsed clock counted through the gap, and a resident-process wake (no
reload) is handled by `onWake()` (`pageshow`/`visibilitychange`). After a few rejected fixes a
**stale-window re-acquire** re-snaps your position (and a wake `restartWatch()`s a possibly-dead
iOS `watchPosition`) — built for the pocket-the-phone-then-check-at-the-summit pattern. Offline is
three tiers: SW precache (shell+i18n+GPX+images, in Cache Storage) →
tiles served from **IndexedDB** (IndexedDB-first, both hosts; see `tiles-db.js`) → two download
affordances that share one engine: the global **"save all maps" button** (`downloadAll` → `saveTiles`)
in the list header that fills the store for every trail across both sources, and a **per-trail button**
on each list card (`downloadOne` → `saveTiles`) that saves just that trail. Saved tiles live in
IndexedDB rather than Cache Storage so the app shell launches fast even with ~5k tiles saved (WebKit is
slow to open a Cache holding thousands of entries — see ADR-12). Full detail in `docs/ARCHITECTURE.md`.

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
users, bump `APP_V` in `sw.js` (currently `wa-trails-app-v23`) — the `activate` handler purges
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
- **Wake Lock** is reliable on the iOS 26+ target (standalone PWAs). The app acquires a screen
  lock in `startGPS()`, releases it in `stopGPS()`, and re-acquires on wake (iOS auto-releases
  it whenever the page hides). It only matters for the phone-in-hand, watch-the-map-move case;
  the common pocket-it-and-check-at-the-summit pattern is served by the GPS-gap-recovery path
  (`refreshGpsAfterGap`/`restartWatch`), which is independent of the lock. No Auto-Lock advice
  or video-loop fallback is needed.
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
  (`#dl-all`) in the header. **Update (2026-06-18): a per-trail download button was deliberately
  re-added** to each list card (`.card-dl`), coexisting with the global button and sharing its engine
  (`saveTiles`); the download **modal** and a **separate** ✓ badge stay gone — each button's `done`
  state is its own status. See ADR-15 and Golden Rule #8.
- **Saved map tiles moved from Cache Storage to IndexedDB** (`tiles-db.js`; `APP_V` bumped to
  `wa-trails-app-v15`). A full "Save maps" caches ~5k tiles; on WebKit a Cache holding that many
  entries is slow to open, and that open sat on the launch critical path → a multi-second black
  screen on every relaunch once maps were saved. Tiles now live in IndexedDB (fast keyed lookup),
  Cache Storage holds only the ~20 shell files, `refreshCacheStatus()` no longer blocks first
  paint, and the SW serves the shell scoped to `APP_V` (no global `caches.match`). See ADR-12.

- **Download "✓ saved" is now manifest-backed, not a single-tile guess** (`APP_V` bumped to
  `wa-trails-app-v20`). The old `trailSaved()` sampled **one** z14 center tile per trail — but the SW
  caches every tile you view online, so merely browsing a map planted that probe tile and faked a ✓
  while most tiles were missing (the reported "✓ but blank map offline" bug). `done` was also gated on
  `ok>0`, so a partial/interrupted download flipped to ✓ too. Now a trail is "saved" only if it has a
  **completion record** in `localStorage.tileManifest` — written **solely** by a download that
  committed its full expected tile set with **zero hard failures** (`saveTiles` gates `done` on
  `fail===0`; host 404s count as `absent`) — **and** that record's multi-zoom probe tiles are all still
  in IndexedDB (re-checked on launch to demote an iOS-evicted set). Incidental SW tiles write no
  record, so they can't fake a ✓. The detail map also gets a per-zoom `maxBounds` clamped to the cached
  box, so offline panning can't reach never-cached (blank) tiles. See ADR-16 and Golden Rule #8.

- **The detail map no longer drifts off-center right after load** (`APP_V` bumped to `wa-trails-app-v22`).
  `fitTrack()` fits the track with asymmetric padding that lifts it into the visible band *above* the
  bottom sheet — but `applyMaxBounds()` then clamped the **whole map container** to the bare cached box,
  so `setMaxBounds`'s `_panInsideMaxBounds` animated that sheet-offset view back down, sliding the track
  partly behind the sheet (most visible on the compact Japan trails). `applyMaxBounds()` now widens the
  clamp on the top/bottom edges by the header/sheet insets (converted to degrees at the current zoom), so
  it bounds the **visible** viewport, not the container; the visible map still can't pan onto an uncached
  tile, while the hidden strips behind the header/sheet may, harmlessly. `fitTrack`'s fit is now
  `animate:false` so the follow-up clamp reads a settled view. Don't regress `applyMaxBounds` back to
  clamping the bare box against the full container. See ADR-19.

- **Reliability / accuracy / a11y pass + Fuji round-trip data fix** (`APP_V` bumped to `wa-trails-app-v23`,
  2026-06-19). A batch of fixes from a full test sweep:
  - **Fuji data:** the bundled Yoshida GPX is the **full round trip** (≈10.4 mi, up one trail and down
    another back to the 5th Station). The stats had shipped the one-way ascent (4.2 mi / `Point to point`),
    inconsistent with the track that's drawn/scrubbed. Corrected to `lengthMi: 10.4`, `route: "Loop"`,
    `time: "8 – 10 h"`; gain stays the one-climb DEM figure (4,701 ft) per Golden Rule #4. Summary/
    description (EN + JA) reworded to the round trip. The GPX is authoritative — don't "fix" it back.
  - **Offline downloads:** each tile fetch now has a 15 s `AbortSignal.timeout` (a hung connection can no
    longer freeze a download forever — a timeout counts as a retryable `fail`); `downloadAll` skips trails a
    per-trail download already owns (no two engines racing the same slug's manifest/state), marks each card
    `busy` only as it starts (so an early break leaves the rest idle, not stuck), and **stops early on
    `dlQuotaHit`** (keeps already-completed trails' ✓). `gpxBox` is memoized per slug. The `navigator.onLine`
    guard is now documented as a fast hint, not a reliable gate (saveTiles' fail-reporting is the real net).
  - **Tracking:** sustained off-trail / weak-signal fix rejections now surface a `trackWeakSignal` HUD hint
    (`trackSearching`) instead of a silently frozen percent. The `resize` handler only re-`fitTrack()`s on an
    actual **orientation** change (`mapOrient`) — an iOS URL-bar/keyboard resize no longer yanks a zoomed-in
    hiker back to the full-track view; a same-orientation resize just re-clamps bounds. The non-tracking GPS
    profile cursor scans the downsampled `renderPts` (`nearestRenderPt`), not the full track, bounding per-fix
    work on long trails. The YAMAP timeline leg/stay math wraps past midnight (`dur()`), ready for a multi-day plan.
  - **Accessibility:** pinch-zoom re-enabled (dropped `maximum-scale=1`); `#map` is `role="application"` with a
    label; the card list is `role="list"`/`listitem` with a clean link `aria-label` (hero `alt=""`); filter/sort
    chips expose `aria-pressed`; the track HUD's per-second clock no longer lives in an `aria-live` region (only
    the `.th-msg` milestone announces); the sheet grip is a keyboard `role="button"` (Enter/Space toggles, Esc
    collapses) and the map FABs go `inert` when the sheet is full; the resume `alertdialog` takes focus + traps
    Tab + Esc-dismisses; 44px tap targets added to the small HUD/resume/header controls; a GPX-load failure now
    shows an inline `.load-err` instead of a blank sheet; the global download button's `aria-label` no longer
    mismatches its visible label; `--muted` darkened for contrast; a `<meta name="description">` was added.
