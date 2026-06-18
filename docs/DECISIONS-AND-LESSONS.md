# Ume-chan's Trails (梅ちゃんのトレイル) — Decisions & Lessons

Architecture decision records and engineering lessons for **Ume-chan's Trails**
(梅ちゃんのトレイル), a static, offline-capable hiking PWA for iPhone.

**Stack:** plain HTML/CSS/JS, [Leaflet 1.9.4](https://leafletjs.com/), per-trail raster topo tiles
(USGS National Map for the US, GSI 地理院タイル for Japan — ADR-2, ADR-9), no build step, deployed
on GitHub Pages. Ten trails — eight in Washington State (USA) plus two in Japan (Mt. Fuji's
Yoshida route and Mount Kinpu via Odarumi Pass, in Yamanashi) — each with a map, GPX track, live GPS, and an
elevation profile. The UI is bilingual — Japanese by default with an English toggle (ADR-8).

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

In code, the map is a vanilla Leaflet raster setup (the URL/attribution/`maxZoom` are now read from
the trail's tile source — `trailSource(curTrail)` — rather than the literal USGS constants shown
here; see ADR-9):

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

> **Updated by ADR-9 (12-trail / Japan support).** USGS is no longer *the* single basemap — it is
> now the **default** source for the US trails and the source for any trail without a `tiles` field.
> Japan trails use GSI 地理院タイル instead. The USGS URL template and the "topo with contours, no
> API key, cacheable" rationale below are unchanged; ADR-9 generalizes the single-source assumption
> into a `TILE_SOURCES` map. The cache-first host special-case is also no longer USGS-only — the
> service worker now matches both `nationalmap.gov` **and** `cyberjapandata.gsi.go.jp` (ADR-9).

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
- Legally cacheable for offline personal use, which is exactly what the offline-map download feature
  does.

**Alternatives considered and rejected.**

- **OpenTopoMap.** Great cartography, but its **tile usage policy forbids bulk downloading**, which
  is fundamentally what an offline "download this trail's tiles" feature does.
- **Mapbox / Stadia Maps.** Require **API keys** and their terms **forbid bundling tiles for
  offline use**.

**Consequences.**

- Coverage and styling are fixed to what USGS serves (and limited here to `minZoom:8`–`maxZoom:16`).
- The service worker special-cases this host (`url.includes('nationalmap.gov')`) for cache-first
  tile handling (ADR-7) — and now the GSI host alongside it (ADR-9).

---

### ADR-3: Bundle hero images locally instead of hotlinking the AllTrails CDN

**Context.**
Each trail card and detail screen shows a hero photo. The trail content and photos originate from
AllTrails. The app must work with **no network**.

**Decision.**
Commit the hero images as local `.webp` files under `images/` (now **ten**, one per trail) and
reference them by relative path (e.g. `images/lake-22.webp`). They are precached by the service
worker on install (`TRAIL_ASSETS` in `sw.js`).

**Rationale.**

- **True offline requires local assets** — a hotlinked image is a network request that fails on the
  trail.
- The AllTrails CDN **blocks hotlinking (HTTP 403)**, and its image URLs can **expire**, so even
  online hotlinking would be unreliable.

**Alternatives considered and rejected.**

- **Hotlink the AllTrails CDN directly.** Rejected: breaks offline, returns 403 on hotlink, and
  URLs are not stable.

**Consequences.**

- Roughly **~2.5 MB of WebP** is committed under `images/` (ten files, ~140–315 KB each).
- Attribution is shown in the UI ("Trail info & photo via AllTrails." plus a per-source map credit —
  "Map © USGS National Map" or "Map © GSI Japan (地理院タイル)", chosen by the trail's tile source;
  see ADR-9).

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

> **Updated by ADR-10 (one-button "download all maps").** Tier 3 below — the per-trail "Download
> map for offline" button, its modal, and the per-card "✓ available offline" badges — was
> **replaced** by a single global "download all maps" button that caches every trail's tiles
> (across both sources) in one foreground action. Tiers 1 and 2 (SW-precached shell/GPX/images;
> cache-first tiles) are unchanged, as is the underlying constraint (iOS has no Background Fetch).
> Read this ADR for the three-tier *structure* and ADR-10 for the current *download UX*.
>
> **Updated by ADR-12 (tiles → IndexedDB).** Tier 2's "cache-first tiles in a separate `TILE_V`
> cache" is now **IndexedDB-first** via `tiles-db.js` (the SW reads/writes `TileStore`; there is no
> longer a `TILE_V` tile cache), and tier 3's `downloadAll()` writes tiles into **IndexedDB**, not a
> Cache. The three-tier *structure* and the iOS "no Background Fetch" constraint are unchanged.

**Context.**
The app must be usable with **no signal on the trail**. iOS Safari PWAs have **no Background Fetch
and no Background Sync**, so the app **cannot prefetch tiles in the background** — any tile download
must happen in the foreground while the user is looking at it (typically on Wi-Fi before leaving).

**Decision.**
A **three-tier** caching strategy:

1. **Shell + GPX + hero images — precached on service-worker install.**
   `SHELL` (HTML/CSS/JS/manifest/icon + Leaflet from unpkg) is added with `cache.addAll` and
   **must succeed**; `TRAIL_ASSETS` (the ten GPX files and ten images) are added **best-effort**
   with `Promise.allSettled` so one failure doesn't abort install.

   ```js
   const c = await caches.open(APP_V);
   await c.addAll(SHELL);                                   // must succeed
   await Promise.allSettled(TRAIL_ASSETS.map(u => c.add(u))); // best-effort
   ```

2. **Map tiles — cache-first with network fallback**, in a separate cache (`TILE_V`) so they can be
   managed independently of the shell. The fetch handler special-cases the tile hosts (now **both**
   USGS and GSI — see ADR-9):

   ```js
   if (url.includes('nationalmap.gov') || url.includes('cyberjapandata.gsi.go.jp')) {
     e.respondWith(caches.open(TILE_V).then(cache =>
       cache.match(url).then(hit => hit || fetch(e.request).then(res => {
         if (res.ok || res.type==='opaque') cache.put(url, res.clone());
         return res;
       }).catch(() => new Response('', {status:503})))
     ));
     return;
   }
   ```

3. **Explicit per-trail tile download — user-initiated, foreground.** *(Superseded by ADR-10 — see
   below. Kept here for the three-tier structure.)*
   The user taps "Download map for offline." The app computes the trail's bounding box (from the
   loaded track, falling back to a box around the trail center), enumerates tiles from z10 up to
   the source's `maxZoom` (z10–16 USGS, z10–18 GSI), and fetches them in **batches of 8** into
   `TILE_CACHE`, showing live
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

- Offline coverage is **explicit and user-driven** — tiles are never prefetched automatically.
  *(Originally per-trail; ADR-10 changed this to one all-trails download — the user no longer picks
  trails individually.)*
- Tile downloads can be sizeable; they run in the foreground with a progress UI. See
  `docs/IOS-PWA-GUIDE.md` for the iOS storage/background constraints behind this design.

---

### ADR-8: Bilingual UI with Japanese as the default, plain-object i18n (no library)

**Context.**
The app needed a full, natural **Japanese** translation — not just labels, but trail summaries,
descriptions, tips, waypoint names, and unit conventions — and it had to **default to Japanese**
with a one-tap **English** toggle. This had to happen without a build step, without a framework,
and without breaking the offline-cacheable static-file model (ADR-5, ADR-7).

**Decision.**
A **hand-rolled i18n layer** lives in `i18n.js` as a single plain object, `window.I18N`, with:

- `ui` — static UI strings, keyed `en` / `ja` (titles, buttons, section headings, alerts).
- `fn` — locale-aware **string functions** for dynamic text. *(Currently holds one function,
  `planParty` — used to render the hike-plan party size, e.g. `"3 hikers"` / `"3人"`. The per-trail
  download descriptions/progress that once lived here were removed with the download-UX overhaul
  (ADR-10); the global button now shows a bare percentage.)*
- **enum/token tables** — `diff`, `route`, `dogs`, `months` — translating data *tokens* at render
  time (e.g. `"Hard"` → `"上級"`, `"Loop"` → `"周回"`).
- `wpt` — GPX **waypoint name** translations (English → Japanese).
- `trails.<slug>.ja` — **per-trail Japanese content** (`name`, `area`, `summary`, `description`,
  `tips`, `permit`) that overrides the English base by slug.

`app.js` consumes this through small helpers:

- `t(key)` — a `ui` string in the active language, falling back to English then the key itself.
- `tf(key)` — a `fn` string-builder in the active language.
- `loc(trail)` — returns the trail object with locale text fields **merged in**: in Japanese it
  spreads `I18N.trails[slug].ja` over the English base; in English it returns the base unchanged.

**English base content stays in `trails.js`**; Japanese overrides **merge via `loc()`**.

Units switch with language **at render time** while the **stored data stays imperial**: feet and
miles are the single canonical source in `trails.js`, and the formatters convert to km/m for
Japanese (`fmtDist`, `fmtGain`, `fmtElevRange`) — e.g. `mi * MI_PER_KM` and `ft / FT`
(`FT = 3.28084`). Date/duration/season text is also localized at render time
(`fmtTime`, `trSeason` via the `months` table).

The language preference persists in `localStorage.lang` and defaults to `ja`:

```js
let lang = (localStorage.lang === 'en' || localStorage.lang === 'ja')
  ? localStorage.lang : 'ja';   // Japanese is the default
```

**Rationale.**

- **No build step / no framework (ADR-5)** rules out an i18n library — there is nothing to compile
  message catalogs or wire up a provider.
- The **dataset is tiny** (ten trails, a few dozen UI strings), so plain objects are more than
  enough and keep everything **debuggable** and **offline-cacheable** as ordinary static JS.
- **Merging-with-fallback** means a missing Japanese field **degrades gracefully to English**
  rather than rendering blank or throwing — important while translations are filled in.

**Alternatives considered and rejected.**

- **An i18n framework/library (i18next, FormatJS, etc.).** Rejected: needs tooling/a build step and
  a dependency to maintain, contradicting ADR-5 for a dataset this small.
- **Duplicating all of `trails.js` per language.** Rejected: two parallel copies **drift** — a fix
  to one (a stat, a coordinate, a typo) silently fails to land in the other. One canonical English
  base + Japanese overrides avoids the drift.
- **Translating enum *values* in the data** (storing `"上級"` etc. on each trail). Rejected: it
  would couple data to one language and defeat the English/Japanese toggle; chose **render-time enum
  tables** (`diff`/`route`/`dogs`/`months`) instead.
- **Storing metric in the data.** Rejected: chose to keep **one canonical imperial source** and
  **convert on display**, so the stored numbers match the AllTrails-sourced figures (ADR-4) and only
  the presentation changes.

**Consequences.**

- **Every new string must be added in both languages** (and a new trail needs a `trails.<slug>.ja`
  block); a missing key falls back to English rather than failing loudly.
- **Adding a 3rd language** would need new `ui`/`fn`/enum blocks **and** a real toggle UI — the
  current toggle is a simple two-way switch (`setLang(lang === 'ja' ? 'en' : 'ja')`), not a picker.
- **Live switching** can't just swap text: it required **re-rendering** the list and the open detail
  view and **re-binding the Leaflet map marker popups** in the new language. That popup re-bind is
  `redrawTrailLabels()`, which re-sets the popup content for the endpoint markers (each carries an
  `_i18nKey`) and the waypoint markers on `setLang()`.

---

### ADR-9: Per-trail tile source — GSI 地理院タイル for the Japan trails (USGS stays the US/default)

**Context.**
Expanding to the Japan trails (ADR-11) broke a hidden assumption in ADR-2: that there is **one**
basemap. USGS National Map covers only the US, so the Japan trails would render on blank tiles.
Japan needs its own topographic raster source that is **free, key-less, CORS-enabled** (the SW
caches cross-origin tile responses), and **tolerant of the app's per-use caching** — the same bar
USGS cleared in ADR-2.

**Decision.**
Make the tile source **per-trail**. A `TILE_SOURCES` map in `app.js` defines two sources, and each
trail optionally names one via a `tiles` field; **absent ⇒ `usgs`**, so the eight US trails were
untouched. Both Japan trails set `tiles: "gsi"`, pointing at the official **GSI 地理院タイル
"std"** raster set from the Geospatial Information Authority of Japan (国土地理院):

```js
const TILE_SOURCES = {
  usgs: { url:'…/USGSTopo/MapServer/tile/{z}/{y}/{x}',                          maxZoom:16, leaflet:'© USGS',              creditKey:'attribUsgs' },
  gsi:  { url:'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',       maxZoom:18, leaflet:'地理院タイル © 国土地理院', creditKey:'attribGsi' },
};
const trailSource = trail => TILE_SOURCES[trail.tiles] || TILE_SOURCES.usgs;
```

`initMap` builds the Leaflet tile layer from `trailSource(curTrail)`; the displayed map attribution
is now dynamic per source (`attribUsgs` / `attribGsi` in `i18n.js`, both languages), as is the
detail-screen attribution line.

**Rationale.**

- GSI "std" is the **direct analog of USGS Topo for Japan**: free, no API key, served with
  `Access-Control-Allow-Origin: *`, with **contour lines and Japanese labels** — ideal for a
  Japanese-default app.
- A `tiles` field defaulting to `usgs` is the **smallest possible change** — zero edits to the US
  trails or their offline behavior.

**Alternatives considered and rejected.**

- **GSI "pale" (淡色地図).** Same underlying data but muted styling — **rejected**: less topographic
  detail; "std" is the better hiking basemap.
- **OpenTopoMap / OSM / Esri for Japan.** **Rejected as the *download* source** for the same reason
  ADR-2 rejected them for the US: their tile-usage policies discourage bulk pre-downloading, which
  is exactly what the offline-save feature does. GSI tolerates the app's per-use caching.

**Consequences.**

- **Token order differs between the two URLs** — USGS is `{z}/{y}/{x}` (y before x) while GSI is
  `{z}/{x}/{y}` (x before y). This is **safe** only because the download/probe code substitutes
  tokens **by name** (`.replace('{z}',z).replace('{y}',y).replace('{x}',x)`), so the identical
  Web-Mercator XYZ math drives both with **no branching** — see the lesson in Part 3. The one
  invariant to protect is the correct token *order inside each template*.
- **Each source's `maxZoom` is set to its real native ceiling, not a shared cap.** The USGSTopo
  cache stops at **z16** (z17+ return HTTP 404, confirmed by probing the live service), so US
  trails keep `maxZoom:16`. GSI's `std` raster serves to **z18**, so the Japan trails set
  `maxZoom:18` and zoom in two levels further for fine detail. Because `initMap` rebuilds the
  layer per trail with `maxZoom: src.maxZoom`, display and download both follow the per-source
  ceiling (downloads run z10 up to `src.maxZoom`); offline coverage still matches what's
  displayable. *(The earlier shared `maxZoom:16` / `z10–16` cap was lifted for GSI — see the
  edit history; USGS was already at its native max.)*
- The service worker's cache-first tile handler now matches **both** hosts (ADR-7, tier 2).

---

### ADR-10: One global "download all maps" button (replaces per-trail download + modal + badge)

> **Updated by ADR-12 (tiles → IndexedDB).** The "~3,200 tiles" figure below is now **~5,200**
> (≈2,830 USGS + ≈2,480 GSI, after the GSI z17–18 levels were added — ADR-9), and `downloadAll()`
> fills **IndexedDB** (via the service worker when it controls the page; see ADR-12), not a
> `TILE_CACHE`. The one-button UX described here is otherwise unchanged.

**Context.**
ADR-7's tier 3 gave each trail its own "Download map for offline" button, a progress modal, and a
per-card "✓ available offline" badge. With ten trails across two tile sources that is a lot of
surface area, and "are my maps saved?" had **ten answers**. The user asked for a single button.

**Decision.**
Replace all of that with **one global button** (`#dl-all`) in the list header, beside the language
toggle. One tap caches tiles for **all ten trails across both sources** in a single foreground
pass; the button is the **single source of truth** for download status and shows its own state:
idle (`⬇ Save maps`) → live `NN%` → done (`✓ Maps saved`).

A single `dlState` (`'idle' | 'busy' | 'done'`) replaced the per-slug `cacheStatus` map.
`downloadAll()` gathers every tile URL across every trail (each via its own source template),
**dedupes with a `Set`**, and fetches in batches of 8 into `TILE_CACHE`. Each trail's bounding box
comes from `gpxBox(trail)`, which parses that trail's **precached GPX** — so the download no longer
depends on a trail being open (the old `trailBox` read the live `trackPts`). On startup
`refreshCacheStatus()` flips the button to `done` only if **every** trail's z14 center sample tile
(from that trail's own source) is already cached.

**Rationale.**

- **One source of truth** for "are my maps saved" — far simpler than reconciling ten badges.
- It's a direct, explicit, user-initiated **foreground** action, which is all iOS allows (no
  Background Fetch — unchanged from ADR-7).

**Alternatives considered and rejected.**

- **Keep per-trail selective download.** Rejected per the explicit product request for one button,
  and because per-trail badges are a heuristic that was already prone to false greens.

**Consequences.**

- **All-or-nothing, not selective**, and it downloads more in one go: a full run caches **~3,200
  tiles** (≈2,760 USGS + ~465 GSI). Acceptable trade for the simpler model; the download is
  deduped, batched, and shows live progress.
- The removed per-trail button, modal, and per-card badge are noted in Part 4. The dynamic
  download strings they used were also removed from `i18n.js`; the only `fn` function remaining is
  `planParty` (ADR-8).

---

### ADR-11: Include both Mt. Fuji routes despite "[CLOSED]" — surface the seasonal/reservation facts in content

**Context.**
The four Japan trails were sourced through the existing AllTrails pipeline (`docs/DATA-PIPELINE.md`).
Both Mt. Fuji routes are flagged **"[CLOSED]"** on AllTrails — Fuji is climbable only ~early July to
early September, and since 2024 the Yoshida route adds a **reservation + ¥2,000 entry fee + ~4,000/
day cap**. The question was whether to include them at all, and how to represent the closure.

**Decision.**
**Include both Fuji routes** (the user wanted these iconic climbs), **strip the literal "[CLOSED]"**
from the display name, and surface the **seasonal-closure and reservation/fee facts in each trail's
`permit` / `summary` / `tips`** instead — in both languages. The two routes are `fuji-yoshida` and
`fuji-gotemba`; the other two Japan trails are `daibosatsu` and `kinpu` (both Yamanashi).

**Rationale.**

- A clear, in-content seasonal note ("Climbing season only — roughly early July to early September…")
  is **more useful to a hiker** than either hiding the trail or shouting "[CLOSED]" in its title.
- Keeping the literal tag out of the `name` keeps card titles and the detail header clean while the
  facts live where a user actually reads them.

**Consequences.**

- The two Fuji entries deliberately diverge from the raw AllTrails title (no "[CLOSED]"); the
  closure information is **not lost**, just relocated to `permit`/`tips`/`summary`.
- **All four Japan trails were labeled `"Hard"`**, faithful to AllTrails' `difficulty_rating`, even
  though **Gotemba** (12.5 mi / 7,775 ft, climbing to ~3,751 m) was the **single biggest climb in the
  app** and is arguably "Very Hard." This is kept faithful to the documented pipeline on purpose —
  flagged here (and in Part 4) so it isn't "re-discovered" as a bug. See `docs/DATA-PIPELINE.md` for
  the Japan-trail sourcing notes (webarchive recovery, `trailGeoStats`).

> **Update (2026-06):** of these four Japan trails, only **`fuji-yoshida`** remains —
> `fuji-gotemba`, `daibosatsu`, and `kinpu` (Kanayama) were later removed, and a separate
> Mt. Kinpu route via **Odarumi Pass** (`kinpu-odarumi`) was added. So the two Japan trails
> today are `fuji-yoshida` and `kinpu-odarumi`. With Gotemba gone, the "single biggest climb"
> note above is historical — the **Enchantments Traverse** (US, ~4,845 ft) is now the app's
> biggest climb. The decision to include the Fuji **Yoshida** route (and to relocate the
> `[CLOSED]` facts into `permit`/`tips`/`summary`) still stands.

---

### ADR-12: Saved map tiles in IndexedDB, not the Cache API (fix the slow PWA launch)

**Context.**
A full "Save maps" run now caches **~5,200 tiles (~100 MB)** — the z17–18 GSI levels added for the
Japan trails roughly doubled the count. On iOS/WebKit, **opening a Cache Storage cache that holds
thousands of records is slow**, and that open sat on the **launch critical path** in two places: the
service worker served every app-shell asset via a **global** `caches.match()`, and the app boot
**`await`ed** `refreshCacheStatus()` (which opens the tile cache and probes ten tiles) *before*
routing the first screen. Result: once maps were saved, relaunching the installed PWA showed a
**multi-second black screen** before first paint; with no tiles saved (or online with an empty
cache) launch was fast. The symptom scaled **purely with tile-cache size** — the tell that the cost
was Cache Storage open/scan, a known WebKit characteristic. A Chrome/Blink repro showed *no*
per-operation slowdown at 5k entries, confirming the bottleneck is engine-specific to WebKit.

**Decision.**
Move saved tiles **out of Cache Storage into IndexedDB** (`tiles-db.js`, exposing
`window.TileStore` = `get`/`has`/`put`, shared by the page and the SW via `importScripts`). Cache
Storage now holds only the ~20 shell files, so it opens instantly no matter how many tiles are
saved. Alongside that move:

- The SW tile branch is **IndexedDB-first** (`TileStore.get` → replay the bytes as a `Response`; on
  a network miss it stores the fetched bytes via `e.waitUntil`).
- The SW serves the shell **scoped to `APP_V`** (`caches.open(APP_V).then(c => c.match(…))`) instead
  of a global `caches.match()`, so it never opens or scans any other store.
- `refreshCacheStatus()` is taken **off the boot critical path** — `routeFromHash()` paints first and
  the saved-maps button state updates a tick later (`refreshCacheStatus().then(updateDlBtn)`).
- `install` **precaches with `{cache:'reload'}`** so a new version never stores a stale shell file
  from the HTTP cache — important now that `tiles-db.js` is a *required* shell file.
- `activate` deletes **every** cache except `APP_V` (including the old `wa-trails-tiles-v1`), freeing
  the big cache on upgrade.

**Rationale.**

- IndexedDB does an **indexed key lookup (O(log n))**, so neither launch nor offline tile reads
  degrade as the tile set grows — and offline map panning gets quicker too (it no longer `match`es
  against a huge cache per tile).
- It works in the **service worker** on every iOS the app targets, stores **readable bytes** (both
  tile sources are CORS, never opaque), shares the same per-origin quota, and is subject to the
  **same 7-day eviction** as the Cache API (no regression).
- Keeps the **vanilla, no-build** model — one small shared script, no library (ADR-5).

**Alternatives considered and rejected.**

- **Keep the Cache API, cap the offline download zoom** (drop GSI z17–18, ~38% fewer entries).
  Rejected as the *primary* fix: it only *reduces* the cost, doesn't remove it, and sacrifices the
  max-zoom Japan detail just added. Still a valid future lever.
- **Structural fixes only** (scoped match + non-blocking status). Necessary and kept — but the SW
  must still open *some* cache to serve the shell, so on their own they may not fully remove the
  WebKit open cost once a large cache exists.
- **OPFS.** Faster for blobs, but unavailable before iOS 17; IndexedDB has broader support for the
  target audience.

**Consequences.**

- **Two storage systems now:** Cache Storage (shell) + IndexedDB (tiles). The earlier "no
  IndexedDB / exactly two caches" notes in `docs/IOS-PWA-GUIDE.md` are **superseded** by this ADR.
- **One-time re-download for existing users:** upgrading drops the old `wa-trails-tiles-v1` cache, so
  the "Save maps" button reverts to idle until tapped again (tiles were always disposable under the
  7-day rule).
- Tile persistence lives in **one place** (the SW tile branch); `downloadAll()` just requests the
  misses and lets the SW store them, with a direct-store fallback for the brief window before the SW
  controls the page.
- An opt-in boot timer (`localStorage.perf === '1'`) logs `sw-served shell …ms` for on-device
  before/after measurement.

**Verification.** Chrome DevTools against the local server: a clean install leaves **only**
`wa-trails-app-v15` in Cache Storage (old tile cache purged); the full SW tile round-trip
(miss → network → IndexedDB → hit) round-trips bytes + content-type for both a real GSI host and a
synthetic URL; and **offline** (network emulation off) the app shell launches, a previously-saved
tile serves from IndexedDB, `refreshCacheStatus()` runs without throwing, and a trail's track +
elevation render from the precached GPX.

---

### ADR-13: Auto-resume the active hike's trail screen on cold relaunch

**Context.**
iOS routinely kills the installed PWA mid-hike — the screen locks, the user switches apps, the
process is reaped to reclaim memory. The manifest `start_url` is `"./"`, so a cold relaunch routed
to the **list** screen, not the trail the hiker was actually on. A live-tracking session already
survived the kill (it's mirrored to `localStorage` with an absolute start timestamp — ADR-12's
sibling work), and the list showed a **`#list-resume`** banner the hiker could tap to get back. But
that is one extra tap, at exactly the moment a cold, gloved, or distracted hiker least wants
friction: reopening the app should simply bring them back to where they were.

**Decision.**
Add a **boot-only** routing step, `bootRoute()` (`app.js`), called once from the `load` handler
**in place of** the bare `routeFromHash()`. If there is **no `location.hash`** *and* a fresh
resumable session exists — its `slug` is in `TRAILS`, `Date.now() - savedAt ≤ SESSION_MAX_AGE_MS`
(18 h), and `savedElapsedMs ≥ RESUME_MIN_MS` — it sets `resumeOnOpen = true` and
`history.replaceState(null, '', '#/trail/' + slug)`, then calls `routeFromHash()`. So a cold
relaunch mid-hike lands **straight on the trail and auto-resumes**: the elapsed clock, derived from
the absolute `trackStartTs`, has kept counting through the gap, so it shows the true elapsed time on
arrival.

```js
function bootRoute() {
  const s = readSession();
  if (!location.hash && s && TRAILS.some(x => x.slug === s.slug)
      && (Date.now() - (s.savedAt || 0) <= SESSION_MAX_AGE_MS) && savedElapsedMs(s) >= RESUME_MIN_MS) {
    resumeOnOpen = true;
    history.replaceState(null, '', '#/trail/' + s.slug);
  }
  routeFromHash();
}
```

Two supporting changes ship with it:

- A new constant **`RESUME_MIN_MS = 20000`** *replaces* the old hardcoded **`60000`** in every place
  a resume is offered or performed — `openDetail`'s `resumeOnOpen` branch, `maybeOfferResume`,
  `updateListResume`, and `bootRoute` — so the threshold is consistent everywhere: an active hike
  (> 20 s) is reliably offered/resumed, while a trivial accidental start (< 20 s) is ignored.
  `SESSION_MAX_AGE_MS` stays **18 h** (measured from `savedAt`/last activity).
- `visibilitychange → visible` now calls `if (tracking) updateHUD();`, so the elapsed clock
  **repaints immediately on wake**. The 1 s `setInterval` that drives the HUD is suspended while the
  app is backgrounded on iOS; without this the displayed time could sit stale for up to ~1 s after
  the app comes back to the foreground.

An opt-in boot perf log (`localStorage.perf === '1'`) emits
`console.info('[perf] sw-served shell ~Nms · …')` for on-device before/after measurement of boot +
route.

**Rationale.**
- "I reopened the app, take me back to my hike" is the correct behavior for a tool whose whole job
  is to be reopened repeatedly on the trail — it removes a tap at the worst moment for friction.
- Using **`replaceState`** rather than assigning `location.hash` avoids firing a **second**
  `hashchange` (the route is already set before `routeFromHash()` runs) **and** keeps the Back button
  working: Back pops the hash to `''`, which routes to the list. Because `bootRoute()` runs **only at
  boot**, Back is never re-trapped on the trail.
- The threshold unification (`RESUME_MIN_MS`) means the banner, the auto-resume, and the offer-on-
  open all agree on what counts as a "real" hike, so behavior can't diverge between entry paths.

**Alternatives considered and rejected.**
- **Keep the list-only resume banner (the 1-tap status quo).** Rejected as a UX gap: it still drops
  the hiker on the list and makes them find and tap the banner, contradicting "reopening should bring
  me back to the trail." The banner is **kept as the fallback** for sub-threshold sessions and for
  after the user has navigated back to the list.
- **Auto-route inside `routeFromHash()` itself.** Rejected: `routeFromHash` also runs on every
  `hashchange`, so resuming there would fire on the **Back button**'s `hashchange` (hash → `''`) and
  immediately bounce the user back onto the trail — **trapping** them. Confining the behavior to a
  boot-only `bootRoute()` + `replaceState` is precisely what avoids that.
- **Decouple "leave the map" from "stop tracking" on Back.** A cleaner model in the abstract
  (Back leaves the map view without ending the hike), but a larger routing/state refactor —
  **deferred**.

**Consequences.**
- An **un-ended hike stays "active"** and auto-resumes on *every* relaunch until either the user taps
  the HUD ✕ (`endTracking → clearSession`) or **18 h** pass since last activity (`savedAt`), at which
  point the session is treated as stale and dropped. This is intentional — a hiker who pockets the
  phone for hours still wants the hike back — but it means "stop" is an explicit action, not implied
  by closing the app.
- The `#list-resume` banner remains the resume path for sub-threshold sessions and for the post-
  Back-navigation case.

**Verification.** Chrome with network emulation off and a deterministic GPS shim: an active hike
(> 20 s) relaunches **straight onto the trail** with the timer still running; a < 20 s session stays
on the **list** (no hijack); **Back returns to the list** and is not re-trapped on the trail;
the **HUD repaints on wake** even with the 1 s interval killed while backgrounded; GPS and the green
progress fill resume; no console errors.

---

## Part 2 — Bugs found during build & testing

All four bugs below are **fixed in the current source**; each entry notes the verification.

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
const src = trailSource(curTrail);                       // per-trail tile source (ADR-9)
map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
const zoom = L.control.zoom({ position:'topright' }).addTo(map);
L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:8, attribution:src.leaflet, crossOrigin:true }).addTo(map);
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
  (currently **`'wa-trails-app-v15'`** — bumped each shell release; it was v2 when this bug was first
  written up). There is now **only one cache** (the shell): tiles moved out of Cache Storage into
  IndexedDB in **ADR-12**, so the old `TILE_V` (`'wa-trails-tiles-v1'`) tile cache is gone and
  `activate` deletes **every** cache except the current `APP_V`:

```js
const APP_V = 'wa-trails-app-v15';   // tiles moved out of Cache Storage into IndexedDB (ADR-12)

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== APP_V).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});
```

**Verification.** Confirmed in `sw.js`: `APP_V` is `'wa-trails-app-v15'`, there is no `TILE_V`, the
shell is served cache-first (scoped to `APP_V` — ADR-12), and `activate` deletes every cache except
the current `APP_V`.

**Lesson.** Cache-first service workers are great in production and **hostile during development**.
Keep a fixed "clear SW + caches" step in the dev loop and treat the cache version as the release
lever. See `docs/DEVELOPMENT.md`.

---

### Bug 4 — Adding i18n broke the map: `L.polyline is not a function`

**Symptom.**
After adding the i18n layer (ADR-8), opening **any** trail showed the **map tiles but no track and
no elevation profile**, and the console threw `TypeError: L.polyline is not a function`. Oddly, the
global `L` still *existed* — but `L.map`, `L.polyline`, `L.control`, `L.marker`, etc. were all
`undefined`.

**Root cause.**
The new trail-localization helper had been declared at **`app.js` top level** as a function
named `L`:

```js
function L(trail) { /* merge in Japanese fields … */ }
```

A top-level `function L(...)` is **hoisted** and **shadows Leaflet's global `window.L`** for the
whole module. So every `L.*` Leaflet call — `L.map`, `L.tileLayer`, `L.polyline`, `L.marker`,
`L.control.zoom`, `L.divIcon` — was now resolving against the localization function (which has none
of those properties), hence `L.polyline is not a function`. The tiles still appeared only because
the map object had been created on a path before the shadowing bit (and partially via cached state
during iteration), which made the failure look map-specific rather than global.

**Fix.**
Rename the helper to **`loc(trail)`** and update **all call sites**:

```js
function loc(trail) {
  if (lang === 'ja') {
    const j = I18N.trails[trail.slug]?.ja;
    if (j) return { ...trail, ...j };
  }
  return trail;
}
```

With the single-letter `L` gone, Leaflet's global `L` is intact and the track/markers/profile draw
normally again.

**Verification.** Confirmed in the current `app.js`: the helper is `function loc(trail)`, there is
**no `function L(`** anywhere, and the call sites all use `loc(...)`
(`loc(curTrail).name`, and `loc(trail)` in `renderList`/`renderPeek`/`renderSheetBody`/`openDetail`).
Leaflet calls (`L.map`, `L.polyline`, `L.control.zoom`, …) remain unshadowed.

**Lesson.** **Never introduce a global single-letter `L` in a Leaflet app** — and more generally,
watch for top-level names colliding with globals exported by CDN libraries (`L` for Leaflet, `$`
for jQuery, etc.). A hoisted top-level `function` is especially dangerous because it overrides the
global silently and for the entire file. Surfacing the console `TypeError` (not just eyeballing the
half-rendered map) is what pinpointed it.

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
**Stop the dev server and reload** to prove the app shell **and downloaded trails** work with **no
network** (shell + GPX + images from precache; tiles from the global "download all maps" pass —
ADR-10 — across both USGS and GSI).

**Functional checks (verified by reading the rendered DOM, cross-checked against `trails.js`).**

- **Filter:** selecting **Hard** shows **4** trails — the three WA *Hard* routes (*Mount Pilchuck*,
  *Bridal Veil Falls & Lake Serene*, *Skyline Loop*) plus **Fuji Yoshida** (Japan), all labeled
  `diff: "Hard"`. **Moderate** shows **5** (including *Mount Kinpu / Odarumi Pass*); **Very Hard**
  shows exactly one (*The Enchantments Traverse*).
- **Sort:** **distance ascending** begins **3.5 → 4.2 → 5.2 → 5.4 → 5.7 mi** (Talapus Lake → Fuji
  Yoshida → Mount Kinpu / Odarumi Pass → Mount Pilchuck → Skyline Loop). Confirmed against the
  `lengthMi` values.
- The list reports **10 trails**, matching the ten entries in `trails.js` (eight WA + two Japan).

**Lessons.**

- **Data calibration matters.** The elevation work (ADR-4) is the clearest example: trusting raw GPX
  would have shown gains inflated **~58–67%**. Show the calibrated number; use GPX only for shape.
- **CSS grid intrinsic sizing has sharp edges** with `aspect-ratio`/percentage-height children
  (Bug 1) — prefer definite heights inside auto tracks.
- **Inspect state, don't infer it.** Reading live values in-page (track point counts, SVG content,
  cache keys, rects) caught issues that a glance at the screen would have missed — most notably the
  silently-aborted async flow in Bug 2.
- **Mind globals from CDN libraries.** A top-level `function L(...)` silently shadowed Leaflet's
  global `L` and broke every map call (Bug 4). Avoid single-letter top-level names that collide with
  library globals, and read the console `TypeError` rather than only the half-rendered UI.
- **Substitute URL tokens by name, not position.** USGS tiles are `{z}/{y}/{x}` but GSI tiles are
  `{z}/{x}/{y}` (x and y swapped). Because the tile code does
  `.replace('{z}',z).replace('{y}',y).replace('{x}',x)` — **by name** — the same Web-Mercator math
  serves both sources with no branching (ADR-9). The lesson generalizes: name-keyed templates absorb
  per-source axis-order differences for free; positional formatting would have silently transposed
  tiles. Just keep the right token order inside each template.
- **A datacenter/CI 403 is not "the tiles are down."** GSI returns **HTTP 403 with a text error
  page** (not a 404) from some datacenter/CI IP ranges, while the same URLs serve fine from real
  browsers and home networks. When verifying GSI offline-download from CI, don't mistake that 403
  for a broken tile source — confirm from a real browser before concluding anything is wrong.

---

## Part 4 — Resolved cleanups

Several previously-flagged items were addressed and **verified against the current source**:

- **Dead "Easy" filter chip removed.** `index.html`'s filter bar now has only **All / Moderate /
  Hard / Very Hard** (`data-filter="all|moderate|hard|veryhard"`); there is **no `data-filter="easy"`
  chip**. (The `diffClass`/`diffKey` lookup tables in `app.js` still *map* an `"Easy"` key, which is
  harmless — no trail uses it and no chip exposes it.)
- **Install banner removed (product decision).** The `#install` banner markup, its CSS, the
  `checkInstall()` function, and the `installDismiss` handling are all **gone**. The only remaining
  "install" references are the unrelated service-worker `install` event in `sw.js`.
- **Unused globals removed.** `markerLayer`, `gpsLayer`, and the `MI` constant no longer exist in
  `app.js`. (The `FT` constant is **retained** — it is still used for the imperial⇄metric unit
  conversions in `fmtGain`, `renderSheetBody`, and `fmtElevRange`; distance conversion uses the
  named constant `MI_PER_KM` (`= 1.609344`).)
- **`mobile-web-app-capable` added.** `index.html` now declares
  `<meta name="mobile-web-app-capable" content="yes">` alongside the existing
  `<meta name="apple-mobile-web-app-capable" content="yes">`.
- **Per-trail download button + modal + per-card "✓ available offline" badge removed** (ADR-10).
  Replaced by the single global `#dl-all` button in the list header; `index.html` has **no download
  modal** and **no per-card offline badge**, and `app.js` has **no per-slug `cacheStatus` map** (one
  `dlState` instead).
- **Dead download/modal i18n strings removed.** The dynamic download descriptions/progress strings
  are **gone** from `i18n.js`; `fn` now holds just `planParty` after the download strings were
  removed (ADR-8). The current
  download UI uses static `dlAll` / `dlAllDone` / `dlAllAria` keys plus a bare percentage. New
  per-source attribution keys `attribTrail` / `attribUsgs` / `attribGsi` were added in both
  languages.
- **`sw.js` cache bumped to `wa-trails-app-v15`.** `TRAIL_ASSETS` now precaches **ten** GPX files and
  ten hero images (eight WA + two Japan), and the tile fetch branch matches **both**
  `nationalmap.gov` and `cyberjapandata.gsi.go.jp` (ADR-9). Saved tiles no longer live in a
  `TILE_V` Cache — they moved to **IndexedDB** via `tiles-db.js` (ADR-12), so there is now only the
  one shell cache and `activate` purges everything else; the cache-version-as-release-lever practice
  from Bug 3 is unchanged.

**Known-faithful, do-not-"fix":**

- **Difficulty labels stay faithful to AllTrails' `difficulty_rating`**, not re-judged — e.g.
  **Fuji Yoshida** is `"Hard"` (short at 4.2 mi but +4,701 ft to ~3,710 m). Not a bug. (The
  earlier note here flagged the now-removed **Gotemba** route as an arguable "Very Hard"; see
  ADR-11's update. With Gotemba gone, *The Enchantments Traverse* is the only `"Very Hard"`.)
