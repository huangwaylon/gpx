# Washington Trails — Decisions & Lessons

Architecture decision records and engineering lessons for **Washington Trails**, a static,
offline-capable hiking PWA for iPhone.

**Stack:** plain HTML/CSS/JS, [Leaflet 1.9.4](https://leafletjs.com/), USGS National Map topo
tiles, no build step, deployed on GitHub Pages. Eight Washington trails, each with a map, GPX
track, live GPS, and an elevation profile.

This document captures (1) the key architecture decisions — including the alternatives that were
rejected and why — and (2) the concrete bugs found while building and testing, as symptom → root
cause → fix. All fixes described here have been verified against the current source.

Related docs (siblings in `docs/`):

- `docs/DATA-PIPELINE.md` — how trail stats and GPX geometry are sourced and processed.
- `docs/IOS-PWA-GUIDE.md` — iOS-specific PWA constraints and behaviors.
- `docs/DEVELOPMENT.md` — local dev loop, including service-worker hygiene.

---

## Part 1 — Architecture Decision Records

### ADR-1: Leaflet + raster tiles over PMTiles/MapLibre or MBTiles + SQL.js

**Context.**
The app must render a topographic map that works fully offline on iPhone, deploy as static files
to GitHub Pages, and stay stable when reopened repeatedly on the trail (often on a cold device,
low battery, flaky or no signal). GitHub Pages enforces a **hard 100 MB per-file limit**, which
rules out committing a single large vector-tile archive (`.pmtiles`) or tile database (`.mbtiles`)
to the repo.

**Decision.**
Use **Leaflet 1.9.4** with **raster (image) tiles**, cached per-trail into the Cache Storage API.

In code, the map is a vanilla Leaflet raster setup:

```js
map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
L.tileLayer(TILE_URL, { maxZoom:16, minZoom:8, attribution:'© USGS', crossOrigin:true }).addTo(map);
```

**Rationale.**

- Leaflet is **canvas/DOM-based (no WebGL)**, small, and rock-solid on iOS Safari.
- Raster tiles are individually small files fetched on demand, so nothing in the repo approaches
  the 100 MB per-file limit — offline data is built up in the browser cache by the user, not
  shipped as a monolith.
- Per-trail caching keeps each download bounded to the area that matters (see ADR-7).

**Alternatives considered and rejected.**

- **MapLibre GL JS + PMTiles (vector).** Attractive on paper (small vector data, crisp at any
  zoom), but MapLibre GL JS had an **active, unresolved iOS 18 crash bug**: a memory leak that
  added roughly **~120 MB per reload** until iOS killed the process. For an app whose entire
  purpose is to be reopened over and over on a hike, that is disqualifying. PMTiles archives also
  push against the 100 MB per-file limit if bundled.
- **MBTiles via sql.js.** `sql.js` loads the **entire SQLite database into memory** to query it.
  That is a poor fit for constrained mobile RAM, and an `.mbtiles` of meaningful coverage would
  again collide with the 100 MB per-file limit.

**Consequences.**

- Raster tiles are heavier on the wire than vector tiles, and they are raster-resolution (they
  pixelate past their native zoom). Accepted in exchange for stability and simplicity.
- Rendering is simple and stable on iOS; no WebGL context loss, no GL memory leaks.
- Offline coverage is per-trail and explicit (ADR-7), not global.

---

### ADR-2: USGS National Map topo tiles

**Context.**
The basemap needs **contour lines** (essential for judging a hike), must be legal to **cache for
offline personal use**, and should not require an API key or a paid plan that forbids offline
bundling.

**Decision.**
Use **USGS National Map "USGSTopo"** raster tiles. The URL template lives in both `app.js` and
`sw.js`:

```
https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}
```

**Rationale.**

- US federal product → **public domain**, no API key.
- Includes **contour lines and topographic detail** — ideal for hiking.
- Legally cacheable for offline personal use, which is exactly what the per-trail download feature
  does.

**Alternatives considered and rejected.**

- **OpenTopoMap.** Great cartography, but its **tile usage policy forbids bulk downloading**, which
  is fundamentally what an offline "download this trail's tiles" feature does.
- **Mapbox / Stadia Maps.** Require **API keys** and their terms **forbid bundling tiles for
  offline use**.

**Consequences.**

- Coverage and styling are fixed to what USGS serves (and limited here to `minZoom:8`–`maxZoom:16`).
- The service worker special-cases this host (`url.includes('nationalmap.gov')`) for cache-first
  tile handling (ADR-7).

---

### ADR-3: Bundle hero images locally instead of hotlinking the AllTrails CDN

**Context.**
Each trail card and detail screen shows a hero photo. The trail content and photos originate from
AllTrails. The app must work with **no network**.

**Decision.**
Commit the eight hero images as local `.webp` files under `images/` and reference them by relative
path (e.g. `images/lake-22.webp`). They are precached by the service worker on install
(`TRAIL_ASSETS` in `sw.js`).

**Rationale.**

- **True offline requires local assets** — a hotlinked image is a network request that fails on the
  trail.
- The AllTrails CDN **blocks hotlinking (HTTP 403)**, and its image URLs can **expire**, so even
  online hotlinking would be unreliable.

**Alternatives considered and rejected.**

- **Hotlink the AllTrails CDN directly.** Rejected: breaks offline, returns 403 on hotlink, and
  URLs are not stable.

**Consequences.**

- Roughly **~2 MB of WebP** is committed under `images/` (eight files, ~196–315 KB each).
- Attribution is shown in the UI ("Trail info & photo via AllTrails. Map © USGS National Map.").

---

### ADR-4: Display AllTrails' official elevation gain, not GPX-computed gain

**Context.**
The detail screen shows an **elevation gain** stat and an **elevation profile** curve. The obvious
implementation — sum the positive deltas between consecutive GPX track points — produces badly
inflated numbers because consumer GPS elevation is noisy, and every little up-down wiggle adds to
the total.

Measured on the actual bundled GPX files (raw cumulative positive gain):

| Trail | Raw GPX gain | AllTrails (DEM-based) official | Inflation |
|---|---|---|---|
| Lake 22 | ~ +2,302 ft | +1,456 ft | ~58% over |
| The Enchantments Traverse | ~ +8,080 ft | +4,845 ft | ~67% over |

(Both raw figures were reproduced from `gpx/Lake_22_Trail.gpx` and
`gpx/The_Enchantments_Traverse.gpx`.)

**Decision.**
Two separate concerns, two separate sources:

- The **displayed gain stat** uses AllTrails' **DEM-based official number** (`gainFt` in
  `trails.js`), e.g. Lake 22 shows **1,456 ft**.
- The **elevation-profile curve** is drawn from a **moving-average-smoothed GPX elevation series**
  (`smoothEle`, window 15) and is used for **shape only**, not for a gain number.

The smoothing is a centered moving average; the smoothed value is stored as `p.se` and the curve is
rendered from `p.se` (never the raw `p.ele`):

```js
function smoothEle() {
  const w = 15, n = trackPts.length;
  const raw = trackPts.map(p => p.ele);
  for (let i=0;i<n;i++){
    const lo=Math.max(0,i-(w>>1)), hi=Math.min(n,i+(w>>1)+1);
    let s=0; for(let j=lo;j<hi;j++) s+=raw[j];
    trackPts[i].se = s/(hi-lo);
  }
}
```

The profile's min/max label likewise comes from the smoothed series (`p.se`), so the displayed
elevation range and the curve agree with each other.

**Rationale.**

- Summing raw deltas over-counts gain by **~58–67%** due to GPS noise — wrong enough to mislead a
  hiker about effort.
- AllTrails' DEM-derived gain is the calibrated, trustworthy number to show.
- The GPX still has value for the **shape** of the climb (where it's steep vs. flat), which
  smoothing preserves while suppressing jitter.

**Alternatives considered and rejected.**

- **Compute and display gain from raw GPX deltas.** Rejected: ~58–67% inflation.
- **Compute gain from a smoothed/threshold GPX series.** Rejected for the *displayed stat*: still a
  homegrown approximation of what AllTrails already provides accurately. Smoothing is used only for
  the curve's appearance.

**Consequences.**

- The number and the curve come from different sources by design; this is intentional and
  documented. See `docs/DATA-PIPELINE.md` for the full sourcing/processing pipeline.

---

### ADR-5: No framework, no build step

**Context.**
This is a small, long-lived personal utility that must deploy to GitHub Pages and be trivially
cacheable offline.

**Decision.**
**Vanilla HTML/CSS/JS, no framework, no bundler, no transpile.** The entire app is
`index.html` + `app.css` + `app.js` + `trails.js` + `sw.js`, plus Leaflet loaded from a CDN
(unpkg) and precached.

**Rationale.**

- **Maximizes longevity** — nothing to keep upgrading, no toolchain rot.
- **Loads fast** and is **trivial to cache** offline (the shell is a handful of static files).
- **Zero tooling to deploy** to GitHub Pages — push and it's live.

**Alternatives considered and rejected.**

- **A SPA framework + bundler (React/Vite/etc.).** Rejected as unjustified overhead at this app's
  size; it would add a build step, a dependency tree to maintain, and larger/opaquer output to
  cache.

**Consequences.**

- DOM is built manually with template strings and `querySelector` helpers (`$`, `$$`). Acceptable
  and readable at this scale; would not scale to a large app.

---

### ADR-6: Hash-based routing (`#/trail/<slug>`)

**Context.**
The app has two screens — a trail list and a trail detail — and should support deep links and the
back button, while remaining a **static** site with **no server** and working **offline**.

**Decision.**
Use **hash-based routing**. The detail route is `#/trail/<slug>`; an empty hash shows the list.

```js
function routeFromHash() {
  const m = location.hash.match(/^#\/trail\/([\w-]+)/);
  if (m) {
    const t = TRAILS.find(x => x.slug === m[1]);
    if (t) { openDetail(t); return; }
  }
  showList();
}
window.addEventListener('hashchange', routeFromHash);
```

**Rationale.**

- Works on **static GitHub Pages with no server rewrites** — there is no backend to map
  `/trail/lake-22` to `index.html`.
- **Survives offline:** changing the hash does **not** issue a navigation request, so sub-routes
  never depend on the network or on a SPA fallback.

**Alternatives considered and rejected.**

- **History API / clean paths (`/trail/<slug>`).** Rejected: would need server-side rewrites (or a
  404-fallback hack) on GitHub Pages, and a navigation to a sub-path while offline is fragile.

**Consequences.**

- URLs contain a `#` (e.g. `…/#/trail/lake-22`). Cosmetically less clean, but entirely fine for this
  use case.

---

### ADR-7: Three-tier offline caching with manual per-trail tile download

**Context.**
The app must be usable with **no signal on the trail**. iOS Safari PWAs have **no Background Fetch
and no Background Sync**, so the app **cannot prefetch tiles in the background** — any tile download
must happen in the foreground while the user is looking at it (typically on Wi-Fi before leaving).

**Decision.**
A **three-tier** caching strategy:

1. **Shell + GPX + hero images — precached on service-worker install.**
   `SHELL` (HTML/CSS/JS/manifest/icon + Leaflet from unpkg) is added with `cache.addAll` and
   **must succeed**; `TRAIL_ASSETS` (the eight GPX files and eight images) are added **best-effort**
   with `Promise.allSettled` so one failure doesn't abort install.

   ```js
   const c = await caches.open(APP_V);
   await c.addAll(SHELL);                                   // must succeed
   await Promise.allSettled(TRAIL_ASSETS.map(u => c.add(u))); // best-effort
   ```

2. **Map tiles — cache-first with network fallback**, in a separate cache (`TILE_V`) so they can be
   managed independently of the shell. The fetch handler special-cases the USGS host:

   ```js
   if (url.includes('nationalmap.gov')) {
     e.respondWith(caches.open(TILE_V).then(cache =>
       cache.match(url).then(hit => hit || fetch(e.request).then(res => {
         if (res.ok || res.type==='opaque') cache.put(url, res.clone());
         return res;
       }).catch(() => new Response('', {status:503})))
     ));
     return;
   }
   ```

3. **Explicit per-trail tile download — user-initiated, foreground.**
   The user taps "Download map for offline." The app computes the trail's bounding box (from the
   loaded track, falling back to a box around the trail center), enumerates tiles across
   `DL_ZOOMS = [10..16]`, and fetches them in **batches of 8** into `TILE_CACHE`, showing live
   progress. Offline availability is later detected by sampling one center tile per trail at zoom 14
   (`refreshCacheStatus`), which drives the "✓ available offline" badges.

**Rationale.**

- **iOS has no background prefetch**, so caching the heavy data (tiles) is necessarily a deliberate,
  foreground, user-driven action — the UI is built around that constraint.
- Splitting **shell vs. tiles** into separate caches lets the shell update independently (ADR/Bug-3,
  `APP_V` bumping) without wiping potentially large downloaded tile sets.
- **Cache-first** for both shell and tiles is what makes the app instant and fully functional
  offline once content is present.

**Alternatives considered and rejected.**

- **Automatic/background tile prefetch.** Not possible on iOS Safari PWAs (no Background
  Fetch/Sync).
- **Single combined cache for shell + tiles.** Rejected: it would couple shell updates to tile data
  and risk discarding large downloads on every shell version bump.

**Consequences.**

- Offline coverage is **explicit and per-trail** — the user must remember to download each trail
  while online.
- Tile downloads can be sizeable; they run in the foreground with a progress UI. See
  `docs/IOS-PWA-GUIDE.md` for the iOS storage/background constraints behind this design.

---

## Part 2 — Bugs found during build & testing

All three bugs below are **fixed in the current source**; each entry notes the verification.

### Bug 1 — Trail cards collapsed / overlapping (~69 px tall)

**Symptom.**
In the trail list, card content overlapped: cards rendered at roughly **~69 px** tall instead of the
intended **~249 px**, and each card's hero image bled over the card below it.

**Root cause.**
`#trail-list` was a **CSS grid with auto rows**, and the card's image wrapper used **`aspect-ratio`**
to derive its height. Inside an auto-sized grid track, the percentage/aspect-derived height had no
definite basis to resolve against, so it computed to **~0**, collapsing the grid row. The fixed
chrome (title bar, stats) was all that gave the card any height, hence ~69 px, and the absolutely
positioned image overflowed into the next card.

**Fix.**
Make `#trail-list` a **flex column** with non-shrinking cards, and give the image wrapper a
**fixed (clamped) height** instead of `aspect-ratio`:

Before (conceptually):

```css
#trail-list { display:grid; grid-auto-rows:auto; }
.card-img-wrap { aspect-ratio: 16 / 10; }   /* collapsed to ~0 in an auto grid track */
```

After (current source, `app.css`):

```css
#trail-list {
  flex:1; overflow-y:auto;
  display:flex; flex-direction:column; gap:14px;
}
.card { flex-shrink:0; /* … */ }
.card-img-wrap { position:relative; width:100%; height:clamp(150px,44vw,210px); background:var(--bg-2); }
```

Landscape still uses a two-column grid, but with **`grid-auto-rows:min-content`** so rows size to
their content rather than collapsing:

```css
@media (orientation:landscape) and (max-height:560px) {
  #trail-list { display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:min-content; }
}
```

**Verification.** Confirmed in `app.css`: `#trail-list` is `display:flex; flex-direction:column`,
`.card` has `flex-shrink:0`, `.card-img-wrap` uses `height:clamp(150px,44vw,210px)` (no
`aspect-ratio`), and the landscape grid uses `grid-auto-rows:min-content`.

**Lesson.** CSS grid intrinsic sizing has sharp edges: an `aspect-ratio`/percentage-height child in
an auto-sized track can resolve to zero. Give such children a definite height, or size the track
explicitly.

---

### Bug 2 — Detail screen showed the map but no track or elevation on first load

**Symptom.**
On a **cold** navigation to a trail (e.g. opening a `#/trail/<slug>` deep link), the map tiles
appeared but **`trackPts` stayed at 0** and the **elevation profile was empty**. Calling
`loadTrail()` manually afterward worked — which *masked* the real cause, because by then the map was
already created.

**Root cause.**
`initMap()` creates the Leaflet map with the **built-in zoom control disabled**
(`zoomControl:false`) and then adds its own via `L.control.zoom()`. The original code, however,
reached for **`map.zoomControl.getContainer()`** to nudge the control below the header — but
**`map.zoomControl` is `undefined`** precisely because the built-in control was disabled. That threw
a `TypeError` **inside `openDetail()` after `initMap()`**, which **aborted `openDetail()` before
`loadTrail()` ran**. The map existed (it's created earlier in `initMap`), but the track/profile load
never happened.

**Fix.**
Capture the control returned by `L.control.zoom(...)` and call `.getContainer()` on **that**:

Before:

```js
map = L.map('map', { zoomControl:false, /* … */ });
L.control.zoom({ position:'topright' }).addTo(map);
// …
map.zoomControl.getContainer().style.marginTop = '…'; // TypeError: map.zoomControl is undefined
```

After (current source, `app.js`):

```js
map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
const zoom = L.control.zoom({ position:'topright' }).addTo(map);
L.tileLayer(TILE_URL, { maxZoom:16, minZoom:8, attribution:'© USGS', crossOrigin:true }).addTo(map);
map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
// nudge zoom control below header
zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
```

**Verification.** Confirmed in `app.js`: the control is captured as `const zoom = L.control.zoom(…)`
and the later call is `zoom.getContainer()` — there is no remaining reference to
`map.zoomControl`.

**Lesson.** An exception thrown mid-async-flow **silently skipped the later steps** of
`openDetail()`, and the manual workaround hid it. The bug was pinpointed by surfacing
`unhandledrejection`/console errors during testing rather than only watching the UI. When `option`
disables a built-in feature, don't assume the corresponding property exists — use the handle the
factory returns.

---

### Bug 3 — Stale code during development from the service worker

**Symptom.**
Edits to `app.js` / `app.css` **didn't appear after reload**. At one point an **old single-trail
`index.html`** from a previous version was even served out of the cache, masking new work entirely.

**Root cause.**
The service worker serves the **app shell cache-first**. Once the shell is cached, reloads are
satisfied from the cache, so source edits are invisible until the cache is invalidated.

**Fix / practice.**

- During iteration: **unregister the service worker and clear Cache Storage** between changes (so a
  reload re-fetches from disk).
- To ship updates to users: **bump the cache version** so the new SW installs a fresh shell and the
  `activate` handler deletes the stale caches. The shell cache version is `APP_V` in `sw.js`
  (currently **`'wa-trails-app-v2'`** — already bumped past v1), while the tile cache `TILE_V`
  (`'wa-trails-tiles-v1'`) is kept stable so downloaded tiles survive shell updates:

```js
const APP_V  = 'wa-trails-app-v2';
const TILE_V = 'wa-trails-tiles-v1';

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k!==APP_V && k!==TILE_V).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});
```

**Verification.** Confirmed in `sw.js`: `APP_V` is `'wa-trails-app-v2'`, the shell is served
cache-first, and `activate` deletes every cache except the current `APP_V` and `TILE_V`.

**Lesson.** Cache-first service workers are great in production and **hostile during development**.
Keep a fixed "clear SW + caches" step in the dev loop and treat the cache version as the release
lever. See `docs/DEVELOPMENT.md`.

---

## Part 3 — Testing methodology & lessons

**Tooling.**
Browser automation via **Chrome DevTools** — programmatic `navigate`, `resize`, `evaluate_script`
(to read live in-page state), and `screenshot`.

**Viewports tested.**

- **Portrait 390 × 844**
- **Landscape 844 × 390**

The responsive breakpoint under test is:

```css
@media (orientation:landscape) and (max-height:560px) { /* … */ }
```

**State-inspection pattern.**
Rather than eyeballing the UI, **evaluate JS in-page** to read ground truth directly: `trackPts.length`,
the elevation `<svg>` contents, Cache Storage contents, computed styles, and element bounding rects.
This is far faster and more precise — it's also what surfaced Bug 2 (seeing `trackPts.length === 0`
while the map looked fine) and Bug 1 (reading the ~69 px card rects).

**Offline verification.**
**Stop the dev server and reload** to prove the app shell **and a downloaded trail** work with **no
network** (shell + GPX + images from precache; tiles from the per-trail download).

**Functional checks (verified by reading the rendered DOM, cross-checked against `trails.js`).**

- **Filter:** selecting **Hard** shows **exactly 3** trails — *Mount Pilchuck*, *Bridal Veil Falls &
  Lake Serene*, *Skyline Loop*. Confirmed: those are the only three with `diff: "Hard"`.
- **Sort:** **distance ascending** begins **3.5 → 5.4 → 5.7 → 6.1 mi** (Talapus Lake → Mount
  Pilchuck → Skyline Loop → Lake 22). Confirmed against the `lengthMi` values.
- The list reports **8 trails**, matching the eight entries in `trails.js`.

**Lessons.**

- **Data calibration matters.** The elevation work (ADR-4) is the clearest example: trusting raw GPX
  would have shown gains inflated **~58–67%**. Show the calibrated number; use GPX only for shape.
- **CSS grid intrinsic sizing has sharp edges** with `aspect-ratio`/percentage-height children
  (Bug 1) — prefer definite heights inside auto tracks.
- **Inspect state, don't infer it.** Reading live values in-page (track point counts, SVG content,
  cache keys, rects) caught issues that a glance at the screen would have missed — most notably the
  silently-aborted async flow in Bug 2.
