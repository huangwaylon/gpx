# Ume-chan's Trails — Architecture

> Canonical architecture reference for the **Ume-chan's Trails** (梅ちゃんのトレイル)
> Progressive Web App.
> Every claim below is grounded in the source as of this writing; `file:line` references
> point at the exact code.

> **Tile storage (ADR-12):** saved map tiles live in **IndexedDB** (`tiles-db.js` →
> `window.TileStore`), **not** the Cache API. Cache Storage holds **only** the app shell, in a
> single cache `APP_V` (`wa-trails-app-v20`). The body below reflects this; for the rationale see
> ADR-12 in `docs/DECISIONS-AND-LESSONS.md`. **Cold-relaunch auto-resume (ADR-13):** a relaunch
> mid-hike lands straight on the trail screen and resumes the live session (see §10a).
> **Completion-manifest download gate:** a trail reads as "saved" only when a `localStorage`
> manifest records a *complete* download **and** that record's multi-zoom probe tiles are still in
> IndexedDB — incidentally-cached or partial tiles can no longer fake a green ✓ (see §12).

---

## 1. High-level overview

**Ume-chan's Trails** (Japanese: 梅ちゃんのトレイル) is an **offline-capable hiking PWA** built
for the iPhone (Safari / "Add to Home Screen"). It presents **10 trails — 8 in Washington
State (USA) and 2 in Japan** — and is **bilingual** — **Japanese by default**, with a
one-tap toggle to English (see §1a). A user browses a scrollable list of trail cards, taps
one, and lands on a full-screen trail-detail view with:

- a **topographic** base map (Leaflet) — **USGS** topo for the US trails, **GSI 地理院タイル**
  (Geospatial Information Authority of Japan) for the Japan trails, chosen per trail (§7),
- the trail's **GPX track** overlaid as a red polyline with a white halo,
- **trailhead / endpoint / waypoint** markers,
- **live GPS position** (pulsing blue dot + accuracy circle) with optional follow mode,
- an **SVG elevation profile** that tracks the hiker's position along the route,
- a draggable **bottom sheet** with trail stats, description, tips, and a details table.

A global **"save all maps"** button in the list header pre-caches the map tiles for **every** trail
(across both tile sources) in one tap, and a **per-trail button** on each list card saves just that
trail; both share one engine (§12).

### The two-screen, single-page model

The entire app is **one HTML document** (`index.html`) containing two
`<section class="screen">` elements — `#list` and `#detail` — that are toggled by the
`hidden` attribute (`index.html:20`, `index.html:38`). There is no client-side framework and
no virtual DOM; screens are plain DOM that JS shows/hides and re-renders by writing
`innerHTML`. CSS pins both screens to `position:absolute; inset:0` and hides the inactive one
with `.screen[hidden]{display:none}` (`app.css:23-25`).

### Tech stack

| Concern | Choice |
|---|---|
| Markup | Hand-written semantic HTML5 (`index.html`) |
| Styling | One plain CSS file with custom properties (`app.css`) |
| Logic | One plain ES (`'use strict'`) script (`app.js`), no modules/bundler |
| Data | A global array literal, `window.TRAILS` (`trails.js`) |
| i18n | A global object literal, `window.I18N` (`i18n.js`) — UI strings + per-trail Japanese (see §1a) |
| Mapping | **Leaflet 1.9.4** loaded from the **unpkg CDN** (`index.html:15`, `index.html:106`) |
| Offline | A Service Worker (`sw.js`) + Web App Manifest (`manifest.json`) |
| Hosting | Static files on **GitHub Pages** (note the `.nojekyll` marker) |

### No-build / static philosophy

There is **no build step, no server, no framework, and no transpilation**. The repository's
deployable files are served verbatim. Third-party code (Leaflet's CSS and JS) is pulled
straight from `unpkg.com` rather than vendored or bundled. Routing is **hash-based**
specifically so the app keeps working on GitHub Pages (no server-side rewrite rules) and
while fully offline (see §4). This keeps the mental model tiny: open `index.html`, five
script tags load in order (`leaflet.js` → `i18n.js` → `trails.js` → `tiles-db.js` → `app.js`),
and the app boots on `window load`.

```
                          ┌───────────────────────────────────────────────┐
                          │                  index.html                    │
                          │     (app shell: #list + #detail sections)      │
                          └───────────────┬───────────────────────────────┘
                                          │ <script> tags, in order
   ┌──────────────┬──────────────┬────────┼────────────┬───────────────────┐
   ▼              ▼              ▼         ▼             ▼                   ▼
leaflet@1.9.4   i18n.js      trails.js  tiles-db.js   app.js
 (unpkg)       window.I18N window.TRAILS window.    ALL app logic
 map+CSS      (UI+JA text)    [10]     TileStore         │
   ┌────────────────────────────────────────────────────┼───────────────┐
   ▼              ▼                ▼              ▼       ▼                ▼
 renderList()  openDetail()    initMap()     loadTrail() GPS subsystem  downloadAll()
 (list screen)(detail screen) (Leaflet)     (GPX parse)(watchPosition)(IndexedDB tiles)
   │              │                │              │                          │
   ▼              ▼                ▼              ▼                          ▼
 #trail-list   #sheet + #map   USGS / GSI     drawTrack()              TileStore.put()
 cards         bottom sheet    tiles  ───────►   drawProfile()         (IndexedDB
                                    ▲                                   'wa-trails-tiles')
                                    │                                          │
                                    └──────────────┬───────────────────────────┘
                                                   ▼
                                          ┌──────────────────────┐
                                          │        sw.js         │
                                          │  APP_V (shell cache) │ ◄── HTML/CSS/JS/GPX/img
                                          │   cache-first, scoped│
                                          │  IndexedDB-first ────┼──► TileStore (USGS+GSI)
                                          └──────────────────────┘
```

---

## 1a. Internationalization (i18n)

The app is **bilingual**: **Japanese by default**, English via a one-tap toggle. Everything
user-facing is translated — UI chrome, trail names/areas/summaries/descriptions/tips/permits,
map marker labels, the difficulty/route/dog enums, seasons, times, and measurement units
(km/m in Japanese, mi/ft in English; the stored data stays imperial — `lengthMi`, `gainFt`).

> This section is a summary; **`docs/I18N.md`** is the dedicated, full-detail reference for
> the i18n subsystem (mental model, helper-by-helper walkthrough, and the unit/season/time
> formatters).

### The `window.I18N` object (`i18n.js`)

`i18n.js` loads **before** `trails.js` and `app.js` (`index.html:107`) and assigns a single
global, `window.I18N` (`i18n.js:6`), holding all UI strings and the Japanese overrides:

- **`ui.{en,ja}`** — static UI strings keyed by name (`appName`, `tagline`, filter labels,
  section headings, the download-button labels `dlAll`/`dlAllDone`, the per-trail download labels
  `dlOne`/`dlOneDone`, the `dlOffline` warning and the download-result alerts `dlPartial`/`dlQuota`,
  the attribution credits
  `attribTrail`/`attribUsgs`/`attribGsi`, marker labels, alerts, …) (`i18n.js:9-130`).
- **`fn.{en,ja}`** — functions producing locale-aware **dynamic** strings, called via `tf()`.
  Currently one entry, `planParty(n)` (EN `"<n> hikers"` / JA `"<n>人"`), used by the YAMAP
  plan card (`i18n.js:132-135`).
- **Enum tables** `diff` / `route` / `dogs` — map the English data tokens (`"Moderate"`,
  `"Out & back"`, `"Leashed"`, …) to their JA equivalents (`i18n.js:138-149`).
- **`months`** — English month abbreviation → JA (`"Apr"`→`"4月"`) for season strings
  (`i18n.js:150-153`).
- **`wpt`** — GPX waypoint name → JA (`"Bridge"`→`"橋"`, …) (`i18n.js:155-162`).
- **`trails.<slug>.ja`** — per-trail Japanese content (`name`, `area`, `summary`,
  `description`, `permit`, `tips`) that **overrides** the English base from `trails.js`
  (`i18n.js:165-295`). All 10 trails (including the 2 Japan trails) have a Japanese block.

`trails.js` remains the **English base**; the Japanese for each trail lives in
`I18N.trails[slug].ja` and is merged over the base at render time (see `loc()` below).

### Static markup hooks (`index.html`)

The document is now **`<html lang="ja">`** (`index.html:2`). Static text nodes carry
**`data-i18n`** (textContent) or **`data-i18n-aria`** (aria-label) attributes naming a `ui`
key, e.g. the `<h1 data-i18n="appName">`, the filter chips, and the back button
(`data-i18n-aria="back"`). The list header's top row is a **`.head-top`** containing the
eyebrow `<span data-i18n="tagline">` and a **`.head-actions`** wrapper that holds the global
**"download all maps" button `#dl-all`** (`data-i18n-aria="dlAllAria"`) and the **language
toggle button `#lang-toggle`**; the `<h1 data-i18n="appName">` is a sibling below `.head-top`
(`index.html:35-44`).

### The i18n helpers (`app.js`)

A module-level **`lang`** holds the active language: it reads `localStorage.lang` and
defaults to **`'ja'`** (`app.js:110-111`). The helpers:

- **`t(key)`** (`app.js:113`) — look up a **static** `ui` string for `lang`, falling back to
  English then to the raw key.
- **`tf(key)`** (`app.js:114`) — look up a **dynamic-string function** from `fn`, called with
  arguments — e.g. `tf('planParty')(n)` for the plan card's party size.
- **`loc(trail)`** (`app.js:130`) — when `lang==='ja'`, returns `{ ...trail,
  ...I18N.trails[slug].ja }` (Japanese fields override the English base); otherwise returns
  the trail unchanged. Render code reads localized fields off `loc(trail)` and
  language-neutral fields (slug, stats, paths) off the raw trail. (It is named `loc`, **not**
  `L`, to avoid shadowing Leaflet's global `L`.)
- **`trDiff` / `trRoute` / `trDogs`** (`app.js:117-119`) — translate the enum tokens via the
  `diff`/`route`/`dogs` tables (used for display only; `diffClass`/`diffKey` still key off
  the raw English token).
- **`trWpt(name)`** (`app.js:120`) — translate a waypoint name in JA via the `wpt` table.
- **`trSeason(s)`** (`app.js:123`) — in JA, rewrite `"Apr – Nov"` → `"4月～11月"` via the
  `months` table and a dash→`～` swap.
- **Unit formatters** — `fmtDist(mi)` / `fmtGain(ft)` (`app.js:195-196`), `fmtTime(s)`
  (`app.js:328`), and `fmtElevRange(loM,hiM)` (`app.js:584`) emit **km / m / 時間・分**
  in JA and **mi / ft** in EN, converting from the stored imperial values on the fly. Several
  more single-value formatters follow the same JA-metric / EN-imperial rule: `fmtElev` /
  `fmtDistAlong` (the scrub readout, §9), `fmtDur` / `fmtPlanDate` (the YAMAP plan card), and
  `fmtElapsed` (the tracking HUD, §10a).

### Applying & switching language

- **`applyStaticI18n()`** (`app.js:139`) sets `document.documentElement.lang`, fills every
  `[data-i18n]` / `[data-i18n-aria]` node, sets `document.title` to `t('appName')`, and calls
  **`updateDlBtn()`** so the global download button's label tracks the language (§12). It runs
  on boot (`app.js:166`) and again on every language switch.
- **`setLang(next)`** (`app.js:170`) — sets `lang`, persists it to `localStorage.lang`,
  re-runs `applyStaticI18n()`, **live-re-renders the list** (`renderList()`) and the list
  resume banner (`updateListResume()`), and if a detail view is open re-renders it
  (`#detail-title`, `renderPeek()`, `renderSheetBody()`), then calls **`setSheet(sheetState)`** so
  the peek height / FAB offsets / map padding re-fit to the JA↔EN content-height difference, calls
  **`redrawTrailLabels()`** to re-bind the Leaflet marker popups **without rebuilding the
  map**, re-localizes the tracking FAB/HUD (`updateTrackUI()`/`updateHUD()`) and any open resume
  prompt (`renderResumePrompt()`), and re-draws the GPS profile cursor (`syncGpsCursor()`). It is
  wired to `#lang-toggle` in `bindGlobal()` (`app.js:300`).

---

## 2. File / module layout

Everything the browser loads is a flat set of static files. The table lists each **deployed**
artifact and its responsibility. (Source-only material is noted at the bottom.)

| Path | Type | Responsibility |
|---|---|---|
| `index.html` | HTML | **App shell.** Declares the `#list` and `#detail` screens, the `.head-actions` wrapper holding the global download button (`#dl-all`) and language toggle (`#lang-toggle`), PWA `<meta>` tags, manifest/icon links, `data-i18n`/`data-i18n-aria` hooks, and the five `<script>` tags. |
| `app.js` | JS | **All application logic** — routing, i18n helpers (§1a), list/detail rendering, Leaflet map, GPX parsing & geometry, elevation profile, GPS, bottom-sheet drag, the global + per-trail tile download, SW registration. Single `'use strict'` script, no exports. |
| `app.css` | CSS | **All styles** — design tokens (CSS custom properties), both screens, cards, the language-toggle button, the global download button (`.dl-all-btn`, incl. its `--p` progress gradient) and the per-trail card button (`.card-dl`, incl. its conic progress ring), bottom sheet, the GPS-dot pulse animation, Leaflet overrides, and the landscape media query. |
| `trails.js` | JS data | **Data model (English base).** Defines `window.TRAILS`, the array of 10 trail objects — 8 Washington + 2 Japan (see §3). |
| `i18n.js` | JS data | **i18n tables.** Defines `window.I18N` — UI strings, dynamic-string functions, enum/season/waypoint tables, and per-trail Japanese content (see §1a). Loads before `trails.js`/`app.js`. |
| `sw.js` | JS (SW) | **Service worker.** Precaches the shell + bundled trail assets on `install` (each fetched with `{cache:'reload'}` so a new version never stores a stale shell file); on `fetch` serves map tiles **IndexedDB-first** (via `tiles-db.js`) and the shell **cache-first, scoped to `APP_V`**; on `activate` deletes **every** cache except `APP_V`. |
| `tiles-db.js` | JS (shared) | **IndexedDB tile store.** Defines `window.TileStore` (`get`/`has`/`put`) over DB `wa-trails-tiles` / store `tiles` (out-of-line key = full tile URL). Loaded by **both** the page (`<script src>`, before `app.js`) and the SW (`importScripts`), so they share one store: the SW reads tiles to serve them; the page writes/probes them. Saved tiles live here, **not** in Cache Storage. |
| `manifest.json` | JSON | **Web App Manifest** — name (`梅ちゃんのトレイル`), `start_url`/`scope` (`./`), `display:standalone`, theme/background colors, the PNG icons. |
| `icon-180.png` / `icon-192.png` / `icon-512.png` | PNG | **App icon** — a square center-crop of the Enchantments (Colchuck Lake) hero photo. `icon-180.png` is the iOS `apple-touch-icon`; the 192/512 sizes are the manifest icons (`purpose:"any"`). |
| `.nojekyll` | marker | Empty file that disables GitHub Pages' Jekyll processing so files (and any leading-underscore paths) are served verbatim. |
| `gpx/` | dir | **10 GPX tracks**, one per trail (e.g. `gpx/Lake_22_Trail.gpx`, `gpx/Mt_Fuji_Yoshida.gpx`). GPX 1.1 from AllTrails, containing `<trkpt>` track points (with `<ele>`) and (on the WA trails) `<wpt>` named waypoints; the Japan trails carry no `<wpt>` waypoints. |
| `images/` | dir | **10 WebP hero photos**, one per trail (e.g. `images/lake-22.webp`), shown on the list cards. |
| `README.md` | docs | Project readme (not loaded by the app). |
| `docs/ARCHITECTURE.md` | docs | This document. |

**Source-only / not deployed:** the `alltrails/` directory holds the original AllTrails
`.html` saved pages and the raw `.gpx` exports used to derive `trails.js` and the
`gpx/` tracks. It is kept in the repo for provenance but is **not loaded by the app** (nothing
references it at runtime). The `.html` + `.gpx` files **are committed/tracked in git** as of
2026-06 (~8 MB); the large `.webarchive` captures stay **git-ignored** because they embed
third-party secret tokens (a Mapbox access token) that GitHub's secret-scanning push protection
rejects. So `.gitignore` excludes `.DS_Store`, `*.webarchive`, and `*.log`. (Earlier revisions
git-ignored `alltrails/` entirely; that rule was dropped this session so the source pages
travel with the repo.)

> Note: the load order in `index.html` matters — Leaflet (`L`) loads first, then `i18n.js`
> defines `window.I18N`, then `trails.js` defines `window.TRAILS`, then `tiles-db.js` defines
> `window.TileStore`, all **before** `app.js` runs.

---

## 3. The data model — `window.TRAILS`

`trails.js` assigns a single global array, `window.TRAILS` (`trails.js:4`), of **10 trail
objects** — the 8 Washington State trails followed by 2 Japan trails. It holds the **English
base** content plus all language-neutral data; the Japanese translations live separately in
`I18N.trails[slug].ja` and are merged in at render time via `loc()` (see §1a). `app.js` reads
`TRAILS` everywhere as the bare global. Each object is a flat record with the following
fields:

| Field | Type | Meaning | Example (`lake-22`) |
|---|---|---|---|
| `slug` | string | Stable URL id; used in the hash route `#/trail/<slug>` and as the key into `I18N.trails`. | `"lake-22"` |
| `name` | string | English display name (card title, detail header, peek title). Translated in JA via `loc()`. | `"Lake 22 Trail"` |
| `area` | string | English region / nearest town; shown under the card title and in the details table as "Location". Translated in JA via `loc()`. | `"Granite Falls, WA"` |
| `img` | string | Relative path to the WebP hero photo. | `"images/lake-22.webp"` |
| `gpx` | string | Relative path to the GPX track, fetched by `loadTrail()`. | `"gpx/Lake_22_Trail.gpx"` |
| `tiles` | string? | **Optional** basemap selector read by `trailSource()` (§7): **omitted** ⇒ USGS topo (the US trails); `"gsi"` ⇒ GSI 地理院タイル (the Japan trails). | (absent) / `"gsi"` |
| `lengthMi` | number | Trail length in **miles** (data stays imperial); also the **distance** sort key. Displayed via `fmtDist()` — mi in EN, km in JA. | `6.1` |
| `gainFt` | number | Elevation gain in **feet** (data stays imperial); also the **elevation** sort key. Displayed via `fmtGain()` — ft in EN, m in JA. | `1456` |
| `diff` | string | Difficulty token, one of **`"Easy"` / `"Moderate"` / `"Hard"` / `"Very Hard"`** (the data uses only Moderate/Hard/Very Hard). Drives the badge color (`diffClass`) and the filter (`diffKey`) off the raw token; displayed via `trDiff()` (JA: 初級/中級/上級/超上級). | `"Moderate"` |
| `route` | string | Route-type token — `"Out & back"`, `"Loop"`, or `"Point to point"`. Shown on the card (`⟳`), used in **loop detection** (§8), and translated for display via `trRoute()`. | `"Out & back"` |
| `time` | string | English estimated time; formatted via `fmtTime()` — spaces stripped in EN, rewritten to `時間/分` in JA. | `"3 h 17 min"` |
| `season` | string | English best-season range; reformatted via `trSeason()` (`"Apr – Nov"` → `"4月～11月"` in JA). | `"Apr – Nov"` |
| `dogs` | string | Dog-policy token; translated via `trDogs()`. | `"Leashed"` |
| `permit` | string | Permit / pass requirement. | `"NW Forest Pass or day-use fee …"` |
| `center` | `[lat, lon]` | Map center for `initMap()` and the sample point in `refreshCacheStatus()` (and the fallback box in `gpxBox()` if a GPX has no track points). | `[48.0700, -121.7555]` |
| `summary` | string | Short lead paragraph under "Overview". | `"A beautiful hike to an alpine lake…"` |
| `description` | string | Long paragraph under "The hike". | (multi-sentence) |
| `tips` | string[] | Bullet list under "Tips & need-to-know"; rendered as `<li>` items. | `["Rocky trail — sturdy boots…", …]` |
| `plan` | object? | **Optional** baked-in upcoming-hike plan shared from a **YAMAP** plan (URL, date, party size, the plan's own dist/gain, pace, and an hour-by-hour `itinerary`). Locale-neutral data with a few `{en,ja}` text bits; rendered as a tappable card on the detail sheet by `renderPlanCard()`/`renderTimeline()`. Present on `kinpu-odarumi` only. | (present on `kinpu-odarumi`) |

The 10 trails are, in array order: the **8 Washington** trails `lake-22`, `snow-lake`,
`lake-valhalla`, `talapus-lake`, `mount-pilchuck`, `bridal-veil`, `skyline-loop`,
`enchantments`, followed by the **2 Japan** trails `fuji-yoshida` (Mt. Fuji: Yoshida Trail) and
`kinpu-odarumi` (Mount Kinpu via Odarumi Pass). Both Japan trails set `tiles: "gsi"` and have
**no GPX waypoints**. Across the set, one is `route: "Loop"` (`skyline-loop`), two are
`"Point to point"` (`enchantments`, `fuji-yoshida`), and the rest are `"Out & back"`. The
header has no subtitle and no trail count: aside from the `<h1 data-i18n="appName">`, the only
header text node is the eyebrow `<span data-i18n="tagline">` (`index.html:36`), reading
"山と渓谷の道しるべ" / "Field guide".

> **Update (2026-06):** the trail set was trimmed from 12 to **10** this session — the
> Mt. Fuji Gotemba Trail (`fuji-gotemba`), the Mount Daibosatsu Loop (`daibosatsu`), and the
> Kanayama-route Mount Kinpu (`kinpu`) were removed. The Odarumi-Pass Mount Kinpu
> (`kinpu-odarumi`) is a **different** trail and remains. The Fuji Yoshida GPX was also
> replaced with a new 2,438-point track that has its AllTrails POI waypoints stripped (0
> `<wpt>`).

---

## 4. Screen & routing model

### Two screens, one `hidden` toggle

`index.html` declares both screens up front: `#list` (visible by default) and `#detail`
(starts with the `hidden` attribute, `index.html:65`). Switching screens is just flipping
`.hidden`:

- `showList()` sets `#detail.hidden = true`, `#list.hidden = false`, stops GPS if running, and
  clears `curTrail` (`app.js:251`).
- `openDetail(t)` does the inverse: `#list.hidden = true`, `#detail.hidden = false`, sets the
  (localized) title, primes the sheet, renders the peek + body, builds the map, and loads the
  track (`app.js:263`).

CSS hides the inactive screen entirely (`.screen[hidden]{display:none}`, `app.css:25`), and
`#detail` is given `z-index:10` so it stacks above the list (`app.css:105`).

### Hash-based routing

Navigation is driven entirely by `location.hash`:

- **`routeFromHash()`** (`app.js:200`) matches the hash against
  `^#\/trail\/([\w-]+)`. If it matches and a trail with that `slug` exists, it calls
  `openDetail(t)`; otherwise it falls back to `showList()`.
- It runs **on boot** — though indirectly: the `load` handler calls **`bootRoute()`** (§10a),
  which (after optionally seeding the hash for a mid-hike resume) calls `routeFromHash()` once —
  and **on every hash change** (`window.addEventListener('hashchange', routeFromHash)`,
  `app.js:198`).
- Each card **is an `<a href="#/trail/<slug>">` anchor** (`renderList`), so tapping it drives
  the hash directly — there is no JS click handler that assigns the hash. Only the back button
  sets `location.hash = ''` (`bindGlobal`). Either way the single `hashchange` listener
  re-routes; there is no direct screen-swapping from the click handlers.

### Why hash routing

Hash routing needs **no server cooperation**: the browser never requests
`/trail/lake-22` from GitHub Pages (which would 404 without rewrite rules), because everything
after `#` stays client-side. The same property makes routes **survive offline** — the service
worker only ever has to serve `index.html`, and the hash selects the view in-page. Deep links
and the browser back/forward buttons work for free.

---

## 5. List screen subsystem

### Markup & rendering

The list screen (`#list`) contains a header (`#list-header`) whose top row is a `.head-top`
holding the eyebrow `<span data-i18n="tagline">` and a `.head-actions` wrapper
with the global **"download all maps" button `#dl-all`** (§12) and the **language toggle
button `#lang-toggle`** (§1a); the `<h1 data-i18n="appName">梅ちゃんのトレイル</h1>` is a
sibling below `.head-top`. Below the header is a
horizontally-scrolling `#filter-bar` of `.chip` buttons, and an empty `#trail-list` container
that JS fills (`index.html:23-61`). The filter chips are **All / Moderate / Hard / Very Hard**
plus two sort chips (**↕ Distance**, **↕ Elevation**) — there is **no "Easy" chip** because no
trail is Easy-rated (`index.html:46-59`); each chip label carries a `data-i18n` key.

**`renderList()`** (`app.js:198`) is the single render function:

1. Copies `TRAILS` (`.slice()`), applies the active **filter** and **sort** (below).
2. Maps each trail to an **`<a class="card" href="#/trail/<slug>">`** anchor built via template
   literal (the `href` is what drives the hash route, §4).
   It first computes `const tr = loc(trail)` so localized fields (name, area) come from the
   merged object (§1a). The card markup is:
   - `.card-img-wrap` holding the lazy-loaded `<img class="card-img">`,
   - a difficulty badge `<span class="card-badge <diffClass>">` whose label is
     `trDiff(diff)`,
   - a `.card-titlebar` overlay with `.card-title` (`tr.name`) and `.card-area` (`tr.area`),
   - a `.card-stats` row of **three** `.s` chips — distance (`fmtDist(lengthMi)`), gain
     (`fmtGain(gainFt)`), and the estimated hike **time** (`fmtTime(time)`, in a `.s.time` span);
     there is **no route chip**. Each stat's leading glyph is an **inline SVG** from the `icon()`
     helper (`dist` / `gain` / `clock`), not a text glyph.
3. Joins the HTML and writes it into `#trail-list`. Navigation is via each card's `href`
   (no per-card click handler).

`renderList()` is intentionally idempotent and is called several times: once on boot, after
each filter/sort change, and after a **language switch** (from `setLang()`). Each card now carries
a per-trail download button (`.card-dl`) whose state is re-read from the `cardDl` map on every
render (ADR-15); there is still no separate per-card offline *badge* — the button's own done state
is the status.

### Difficulty badge classes

Two small lookup helpers map the human-readable English `diff` token (note: they key off the
**raw** token, not the translated label):

- **`diffClass(d)`** → CSS class: `Easy→d-easy`, `Moderate→d-moderate`, `Hard→d-hard`,
  `Very Hard→d-veryhard` (default `d-moderate`) (`app.js:192`, off the `DIFF` table at
  `app.js:191`). Those classes set the badge's tinted text color (`app.css:156-159`).
- **`diffKey(d)`** → filter token: `Easy→easy`, … `Very Hard→veryhard` (`app.js:193`),
  matching the chips' `data-filter` values.

### Filter & sort state

Module-level state holds the current view config: **`listFilter`** (default `'all'`) and
**`listSort`** (default `null`) (`app.js:188`). `bindGlobal()` wires the `#filter-bar` chips
(`app.js:227-238`):

- A chip with `data-filter` sets `listFilter` and toggles the `.active` class among the filter
  chips.
- A chip with `data-sort` **toggles** that sort on/off (clicking the active one clears it back
  to `null`) and toggles `.active` accordingly.
- Either way it calls `renderList()`. Filtering uses `diffKey(t.diff) === listFilter`; sorting
  is ascending by `lengthMi` (`'dist'`) or `gainFt` (`'gain'`) (`app.js:201-203`).

`bindGlobal()` also wires the language toggle (`#lang-toggle` → `setLang`, `app.js:240`), the
global download button (`#dl-all` → `downloadAll`, `app.js:245`), the back button, the GPS
FAB, and the sheet drag.

### Offline state on the download buttons (`dlState` + `cardDl`)

The global **`#dl-all`** button is driven by the module-level **`dlState`** string
(`'idle' | 'busy' | 'done'`, `app.js:88`). **`updateDlBtn()`** reflects it:
in `idle` the label is `t('dlAll')` ("⬇ Save maps" / "⬇ 地図を保存"); in `busy` the label is a
live `"NN%"` percentage with a CSS gradient fill driven by a `--p` custom property
(`.dl-all-btn.busy`, `app.css:89-92`); in `done` the label is `t('dlAllDone')` ("✓ Maps saved")
and the button turns green (`.dl-all-btn.done`, `app.css:93`).

**Per-trail status (ADR-15) is also shown**, on each list card's `.card-dl` button. State lives in a
`cardDl` slug→state `Map` (so it survives `renderList` re-renders), and the busy **percentage** lives
in a parallel `cardDlPct` slug→number `Map` so `renderList` can restore the busy ring's `--p` after a
filter/sort/language re-render mid-download. Both are painted by **`setCardDl()`**:
idle (download arrow), busy (a determinate conic ring driven by `--p`, `.card-dl.busy`), done (pine-soft
+ check, `.card-dl.done`). On boot, `refreshCacheStatus()` (§12) checks each trail via `trailSaved()` —
which consults the **completion manifest** plus a **multi-zoom probe** of IndexedDB, *not* a single
center tile — and sets BOTH each card's state AND `dlState` to `'done'` only if **every** trail is
verified saved. The full download/progress machinery is documented in §12.

---

## 6. Detail screen subsystem

### `openDetail()` flow

`openDetail(t)` (`app.js:263`) is the detail-screen entry point, invoked only by the
router:

1. `curTrail = t` and swap screens (`#list` hidden, `#detail` shown).
2. Set `#detail-title` text to the **localized** trail name (`loc(trail).name`).
3. **Populate the peek header** via `renderPeek(t)` (below).
4. `renderSheetBody(t)` builds the scrollable body (below).
5. **Reset the sheet to peek** via `setSheet('peek')` (§11) — run **after** the body so
   `computePeekH()` can size the peek to the rendered elevation chart (`app.js:271-272`).
6. `initMap()` constructs the Leaflet map (§7).
7. `await loadTrail(t)` fetches/parses the GPX and draws the track + profile (§8–§9).

This split — `renderPeek()` for the header and `renderSheetBody()` for the body — exists so a
**language switch** can re-render both in place (from `setLang()`, §1a) without rebuilding the
map.

### The peek / meta header — `renderPeek()`

The bottom sheet's always-visible "peek" region is `#sheet-peek`, containing `#pk-title` and
`#pk-meta` (`index.html:96-99`). Tapping it toggles the sheet open/closed; it is hidden in
landscape (§11, §14).

**`renderPeek(trail)`** (`app.js:277`) fills it: `#pk-title` = `loc(trail).name`; `#pk-meta`
= `<span>` chips for `fmtDist(lengthMi)`, `▲ fmtGain(gainFt)`, a difficulty span (the label is
`trDiff(diff)`, colored via `diffClass` but with `background:none;padding:0` so it reads as
colored text, not a pill), and the estimated **time** (`⏱ fmtTime(time)`). There is no longer a
rating chip in the peek.

### `renderSheetBody()`

`renderSheetBody(t)` (`app.js:287`) writes the entire scrollable sheet body (`#sheet-body`)
in one `innerHTML` assignment. It first computes `const tr = loc(trail)` for the localized prose
fields. All section headings and labels come from `t(...)`:

- **No stat grid here.** The four headline stats — **Distance**, **Gain**, **Difficulty**, and
  **Time** — are rendered once in the peek bar's `#pk-meta` (`renderPeek`, above) and are **not**
  repeated in the sheet body. The body's first element is the elevation card below.
- **Elevation card** — `#elev-card` with a header (`t('elevation')` + `#elev-range` span), an
  empty `<svg id="elev-svg" preserveAspectRatio="none" role="img" aria-label="…">` that
  `drawProfile()` fills (§9), and a `<div id="scrub-tip" hidden>` (the scrub readout pill, §9).
- **Plan card** (optional) — for a trail with a `plan`, `renderPlanCard()` is inserted
  immediately **after** `#elev-card` (`app.js:296`/`:338`).
- **Prose sections** (`.section`): **Overview** (`tr.summary`), **The hike** (`tr.description`),
  **Tips & need-to-know** (`tr.tips` → `<ul class="tips">`), and **Details** — section titles
  via `t('secOverview'/'secHike'/'secTips'/'secDetails')`.
- **Details table** — a `<dl class="facts">` with rows: Route type (`trRoute(route)`), Best
  season (`trSeason(season)`), Dogs (`trDogs(dogs)`), Permit (`tr.permit`), Location (`tr.area`)
  (`app.js:313-317`); the `<dt>` labels come from `t('factRoute')` … `t('factLocation')`.
- A small attribution footer crediting AllTrails (info/photo) **plus the trail's basemap
  source**: `${t('attribTrail')} ／ ${t(trailSource(trail).creditKey)}` (`app.js:321`), so a US
  trail credits USGS (`attribUsgs`) and a Japan trail credits GSI (`attribGsi`, §7).

There is **no download button in the sheet** — downloading happens from the header (global
`#dl-all`) or each list card's per-trail button (§5, §12), not the sheet.

---

## 7. Map subsystem

**`initMap()`** (`app.js:414`) (re)builds the Leaflet map each time a detail screen opens:

1. If a map already exists, `map.remove()` it and null it out — every detail view gets a fresh
   map instance bound to the `#map` div. It also **clears stale layer references**
   (`trackLayer`/`walkedLayer`/`scrubMk`/`gpsMk`/`gpsAcc` → `null`) and resets `endMarker._all`
   to `[]` (`app.js:417`), since `map.remove()` drops the old layers.
2. Resolve the trail's basemap with `const src = trailSource(curTrail)` (below).
3. `L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center,
   zoom:13, tap:true })` — the default zoom control is suppressed so it can be re-added in a
   custom position; `tap:true` enables Leaflet's tap handler for touch.
4. Create a dedicated **`gpsPane`** at `z-index 650` (`map.createPane('gpsPane')`) — the GPS dot +
   accuracy circle are placed on it (§10) so the blue dot sits **above** the green walked overlay,
   which lives on Leaflet's `overlayPane` (z400).
5. Add a **zoom control at `topright`** (`L.control.zoom({ position:'topright' })`,
   `app.js:513`).
6. Add the **tile layer for that source** (below).
7. `map.on('dragstart', …)` disables GPS follow mode and clears the FAB's `.on` highlight when
   the user pans (`app.js:517`) — see §10.
8. `map.on('zoomend', applyMaxBounds)` — re-clamp the pannable area to the cached box at the new
   zoom (the offline-cache padding `padFor(z)` tightens as you zoom in; see "Per-zoom max bounds"
   below).
9. Nudge the zoom control down so it clears the floating header:
   `marginTop = calc(54px + env(safe-area-inset-top,0px))` (`app.js:519`).

### Per-zoom max bounds — `applyMaxBounds()`

**`applyMaxBounds()`** (`app.js:526`) clamps the map's pannable area (`map.setMaxBounds`) to the
track's bounds expanded by **`padFor(currentZoom)`** — the *same* zoom-aware padding the offline
download uses to decide which tiles to cache (§12). It is recomputed on every `zoomend` and after
`fitTrack()`. Because `padFor` tightens as you zoom in, the pannable box at each zoom matches the
cached box at that zoom, so **offline you can't pan onto a never-cached (blank) tile**: wide roaming
at overview zooms, held to the saved frame at max detail. The clamp is **soft** (default Leaflet
viscosity — a gentle bounce at the edge, not a hard wall).

### Per-trail tile sources — `TILE_SOURCES` / `trailSource()`

The base map is **per trail**. The single old `TILE_URL` constant is gone; instead `app.js`
defines a **`TILE_SOURCES`** table (`app.js:66-75`) with two entries, and a tiny resolver
**`trailSource(trail) = TILE_SOURCES[trail.tiles] || TILE_SOURCES.usgs`** (`app.js:76`) — so a
trail's optional `tiles` field (§3) picks the basemap (absent ⇒ `usgs`, `"gsi"` ⇒ GSI).
`initMap()` then builds the layer from the resolved source's fields:
`L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:DL_MIN_Z, attribution:src.leaflet,
crossOrigin:true })` (`app.js`, in `initMap`). `minZoom:DL_MIN_Z` (=10) matches the offline
pre-cache floor, so zooming out offline never hits an un-cached z8–9 band. `crossOrigin:true` is what lets the SW read a
fetched tile's bytes back out to store them in IndexedDB (the body must be CORS-readable), and
the **attribution is now dynamic per source**.

The two sources:

| Key | Service | URL template | `maxZoom` | Leaflet attribution / credit key |
|---|---|---|---|---|
| `usgs` | USGS National Map "USGSTopo" (US trails) | `…/USGSTopo/MapServer/tile/{z}/{y}/{x}` | 16 | `© USGS` / `attribUsgs` |
| `gsi` | GSI 地理院タイル (Geospatial Information Authority of Japan; Japan trails) | `https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png` | 18 | `地理院タイル © 国土地理院` / `attribGsi` |

**Key token-order detail:** the USGS template is **`{z}/{y}/{x}`** (row/y **before** column/x,
the ArcGIS convention), while the GSI template is **`{z}/{x}/{y}`** (x before y). Both are
ordinary 256-px Web-Mercator (EPSG:3857) XYZ tiles, and the download/probe code substitutes
tokens **by name** (`.replace('{z}',z).replace('{y}',y).replace('{x}',x)`, §12), so the *same*
slippy-map tile math works unchanged for both despite the differing URL order. **The two sources
top out at different native zooms, and each `maxZoom` matches its source's real ceiling:** the
USGSTopo cache serves only through **z16** (z17+ return HTTP 404), whereas GSI's `std` layer
serves to **z18**. Because the map layer is rebuilt per trail with `maxZoom: src.maxZoom`, US
trails cap display at z16 and Japan trails zoom in to z18; downloads follow the same per-source
ceiling (z10–16 for USGS, z10–18 for GSI). GSI tiles serve CORS-open
(`Access-Control-Allow-Origin: *`); its `std` layer labels are in Japanese.

### IndexedDB-first behavior

Tiles are **not** loaded by the page directly from the network when already saved. The service
worker intercepts any tile request — i.e. any URL whose host is `nationalmap.gov` **or**
`cyberjapandata.gsi.go.jp` — and serves **IndexedDB-first** from the `TileStore` (`tiles-db.js`):
on a hit it replays the stored bytes as a fresh `Response`; only on a miss does it hit the
network, and it then stores the fetched tile back into IndexedDB (§12, §15; `sw.js`, tile branch
of `fetch`). So a previously-visited or pre-downloaded trail renders its map from IndexedDB with
no connectivity.

---

## 8. GPX & geometry subsystem

### `loadTrail()` — fetch & parse

`loadTrail(t)` (`app.js:426`) turns a GPX file into in-memory geometry:

1. Reset `trackPts`, `trackWpts`, `totalDist`, and the tracking state (`renderPts`,
   `walkedDist`, `progIdx`, `reacqMiss`, and the out-and-back `turnedAround` latch) (`app.js:534-535`).
2. **Fetch** the GPX text: `await (await fetch(t.gpx)).text()`, wrapped in try/catch that logs
   and bails on failure (`app.js:537-538`). Immediately after the await, a
   **`if (curTrail !== trail) return`** guard (`app.js:539`) drops the result if a newer navigation
   superseded this one mid-fetch, so trail A's track / far-end can never be drawn onto trail B's map.
   (When offline, the SW serves the GPX from the precached `APP_V` shell — see §15.)
3. **Parse** with `new DOMParser().parseFromString(text, 'text/xml')` (`app.js:432`).
4. **Waypoints** — for each `<wpt>`, read `lat`/`lon` attributes and the child `<name>` (CDATA,
   whitespace-collapsed), pushing `{ lat, lon, name, d:null }` into `trackWpts`
   (`app.js:434-438`). The stored `name` is the **English** name; it is translated for display
   via `trWpt()` (§1a).
5. **Track points** — iterate `<trkpt>`; read `lat`/`lon` and the child `<ele>` (defaulting to
   `0` when missing). Maintain a running cumulative distance `d` by adding the haversine
   distance from the previous point, and push `{ lat, lon, ele, d }` into `trackPts`. Set
   `totalDist = d` (`app.js:441-448`).
6. **Smooth** elevations for display via `smoothEle()` (below).
7. **Precompute** the profile bounds and far end via `precomputeProfileAndFarEnd()`
   (`app.js:451`/`:466`) — a one-pass step (run right after `smoothEle()`) that caches the
   smoothed elevation bounds (`eleLo`/`eleHi`/`eleRange`, for the profile Y scale) and the
   **far-end (turnaround) index/distance** (`turnIdx`/`turnDist`) plus `isOutAndBack`, used by
   live-tracking progress (§10a).
8. **Snap waypoints** to the track: for each waypoint, scan all track points for the nearest
   one (by haversine) and copy that point's cumulative distance into `w.d` (`app.js:453-456`).
   This is what lets a waypoint be drawn at the right x-position on the elevation profile.
9. Call `drawTrack()` then `drawProfile()`.

> The sample GPX files are GPX 1.1 exports from AllTrails — e.g. `Lake_22_Trail.gpx` has 1558
> `<trkpt>` elements and 5 `<wpt>` elements, with names like "Bridge", "Waterfall", "Vista".

### `hav()` — haversine distance

`hav(la1,lo1,la2,lo2)` (`app.js:989`) returns the great-circle distance **in meters**
between two lat/lon pairs, using Earth radius `R = 6_371_000`. It is the geometry workhorse:
cumulative track distance, waypoint snapping, loop detection, and nearest-point-to-GPS all call
it.

### `smoothEle()` — elevation smoothing

`smoothEle()` (`app.js:482`) computes a **centered moving average** of raw `ele` over a
**window of 15** points (`w = 15`), writing the smoothed value to each point's `.se`
("smoothed elevation"). It clamps the window at the array ends (`lo`/`hi`). The profile and the
ft-range label both read `.se`, not raw `.ele`, so the displayed curve is denoised.

### `drawTrack()` — rendering the route

`drawTrack()` (`app.js:492`) renders all map geometry:

1. **Subsample** to **≤ 1200 points**: `step = max(1, floor(trackPts.length/1200))`, keeping
   every `step`-th point plus always the last one (`app.js:493-496`). This bounds the polyline's
   vertex count for performance on long tracks (the Enchantments GPX is ~626 KB).
2. **Halo + line pattern** — two stacked polylines over the same coords:
   - a **white halo**: `color:'#fff', weight:7.5, opacity:0.85` (`app.js:500`),
   - the **red trail line** on top: `color:C.red` (`#d4442e`), `weight:4, opacity:0.98`, saved as
     `trackLayer` (`app.js:501`).
   The white halo gives the red line contrast against busy topo tiles.
3. **Endpoints** (colors come from the `C` palette):
   - **Trailhead** — a **green** dot at `trackPts[0]` via
     `endMarker(p, C.green, 'markerTrailhead')` (C.green = `#1f9d63`; note: the **third argument
     is an i18n key**, not a literal label).
   - **Loop detection** — `isLoop` is true when **either** `curTrail.route === 'Loop'`
     **or** the straight-line distance between the first and last track point is **< 120 m**
     (`hav(first,last) < 120`) (`app.js:506`). The **End** marker (a **red** dot,
     `endMarker(last, C.red, 'markerEnd')`, C.red = `#d4442e`) is drawn **only when `!isLoop`**
     (`app.js:507`)
     — on a loop the start and end coincide, so a separate endpoint would be redundant.
4. **Waypoints** — each `trackWpts` entry becomes an **amber** dot (`dotIcon(C.amber, 11)`,
   C.amber = `#d6861c`)
   with a bound popup showing the localized waypoint name (`trWpt(w.name)`). The marker is
   **retained on `w._marker`** so its popup can be re-localized on a language switch
   (`app.js:509-513`).
5. **Fit bounds** — via the `fitTrack()` helper (`app.js:519`) that `drawTrack` calls:
   `map.fitBounds(trackLayer.getBounds(), …)` with **sheet-aware padding**:
   top-left `[30,70]` (clears the header) and bottom-right `[30, sheetPeekHeight()+30]` so the
   route isn't hidden behind the peeking bottom sheet (`app.js:520`).

Markers are built by two small helpers:

- **`endMarker(p, color, key)`** (`app.js:524`) — a size-15 dot with a popup whose content
  is `t(key)`. It **stores the i18n key on the marker** (`mk._i18nKey = key`) and pushes the
  marker onto the static list **`endMarker._all`**, so the endpoint popups can be re-bound when
  the language changes.
- **`dotIcon(color, size)`** (`app.js:539`) — returns an `L.divIcon` whose HTML is a
  colored, white-bordered circle with a drop shadow.

### `redrawTrailLabels()` — live label re-localization

**`redrawTrailLabels()`** (`app.js:532`), called from `setLang()` (§1a), re-binds all marker
popups in the active language **without rebuilding the map**: it walks `endMarker._all` and calls
`setPopupContent(t(mk._i18nKey))` on each endpoint marker, and walks `trackWpts` calling
`setPopupContent(trWpt(w.name))` on each `w._marker`.

> The track's red polyline is retained as **`trackLayer`** (used for `fitBounds`), declared as
> module state (`app.js:79`); the green `walkedLayer` (§10a) is likewise retained. The **halo
> polyline** is added to the map without any reference, and the
> end/waypoint markers are reachable via `endMarker._all` and `trackWpts[i]._marker`
> respectively. Everything is
> recreated on each `loadTrail`/`drawTrack` because `initMap()` discards the whole map first.

---

## 9. Elevation profile subsystem

### `drawProfile()` — SVG generation

`drawProfile()` (`app.js:661`) renders the elevation chart into `#elev-svg`. It bails early
if the SVG is missing, there are `< 2` track points, or `totalDist <= 0` (a latent
NaN-in-SVG guard — `X(d) = (d/totalDist)*W` would otherwise divide by zero;
`drawProfileCursor()` carries the same `totalDist <= 0` guard).

1. Sizing: `W = svg.clientWidth || 340`, fixed `H = PROF_H` (96); sets the `viewBox` to `0 0 W H`
   (the SVG uses `preserveAspectRatio="none"` so it stretches to the card width).
2. Range: `eleLo`/`eleHi`/`eleRange` from the **smoothed** elevations (`p.se`) — precomputed once
   in `loadTrail` (§8), with `eleRange` floored at 1 to avoid divide-by-zero.
3. **Subsample to ~500 points** (`step = max(1, floor(len/500))`) for the path (`app.js:556-557`).
4. Coordinate mappers: `X(d) = (d/totalDist)*W` (distance → x) and the shared
   `profY(se) = PROF_H - PROF_PAD_B - ((se-eleLo)/eleRange)*(PROF_H - PROF_PAD_B - PROF_PAD_T)`
   arrow const (`app.js:550`) — elevation → y, leaving `PROF_PAD_B` (14px) bottom and
   `PROF_PAD_T` (12px) top padding (module constants at `app.js:22`). The cursor uses the same
   `profY` so the GPS/scrub dot never drifts off the area.
5. Build three pieces of SVG:
   - **Filled area** `path` — from `M0,H` along the curve and back down to `L W,H Z`, painted
     with a vertical **linear gradient** `#eg` of **pine green** (`C.pine` = `#1f6f5c`, opacity
     0.28 → 0.03) (`app.js:560-562`, `app.js:572-575`).
   - **Line** `path` — the curve only, stroked `C.pine`, width 1.75 (`app.js:563-564`, `:578`).
   - **Waypoint verticals** — for each waypoint with a snapped distance (`w.d != null`), a
     **dashed amber vertical line** (`stroke=C.amber stroke-dasharray="3,3" opacity="0.6"`,
     C.amber = `#d6861c`)
     at that x (`app.js:566-569`).
6. Inject `<defs>`(gradient) + waypoint lines + area + line + an empty `<g id="epos">` (the live
   position layer) into the SVG (`app.js:571-579`).
7. Update the **elevation-range label** `#elev-range` via `fmtElevRange(eleLo, eleHi)`
   (`app.js:580`):
   **feet** in EN (`"<lo>–<hi> ft"`, converting smoothed meters with `FT = 3.28084`) and
   **meters** in JA (`"<lo>～<hi> m"`).

### `drawProfileCursor()` — live position / scrub marker

`drawProfileCursor(p, scrub)` (`app.js:617`) draws a cursor on the profile for a point
`p = {d, se}`. It recomputes the same `X`/`profY` mapping and writes into the `#epos` group:

- a **dashed vertical line** (`stroke=C.ink stroke-opacity="0.5" stroke-dasharray="4,3"`) at
  the current x, and
- a **dot** (r 4.5, white-bordered) that is **violet** (`C.violet`) when `scrub` is true and
  **blue** (`C.blue`, the GPS color) otherwise.

It is **shared by GPS and scrubbing**: the GPS handler (§10) calls `drawProfileCursor(trackPts[i],
false)` to track the hiker (`app.js:724`), while scrubbing passes `scrub=true` and also fills the
floating readout pill `#scrub-tip` with elevation + distance-along (below). The group is
cleared (`#epos` emptied) when GPS stops (`stopGPS`, `app.js:709`).

### Elevation scrubbing — `initProfileScrub()`

Dragging a finger along the elevation profile inspects any point on the trail.
**`initProfileScrub()`** (`app.js:646`) is bound **once** from `bindGlobal()` (`app.js:248`) via
**delegation** — a document-level `pointerdown` filtered to `#elev-svg` — because the profile SVG
is rebuilt on every language switch / sheet re-render, so a directly-bound listener wouldn't
survive. `touch-action:none` on `#elev-svg` keeps the drag from scrolling the sheet.

- **`applyScrub(clientX)`** (`app.js:661`) maps the finger's x within the SVG to a fraction
  `0..1`, converts it to a distance, and resolves the exact point via
  **`pointAtDistance(D)`** (`app.js:592`) — a binary-search-plus-lerp over the monotonic
  `trackPts[].d` returning `{lat,lon,se,d,idx}`. It then calls `drawProfileCursor(p, true)` (a
  **violet** cursor + the `#scrub-tip` readout pill showing `fmtElev`/`fmtDistAlong`) and drops a
  synced **violet `scrub-dot` marker** on the trail (created/moved on `map`).
- **`onScrubMove`** (`app.js:660`) is rAF-throttled; window-level `pointermove`/`pointerup`/
  `pointercancel` listeners (added on `pointerdown`) track the finger past the SVG edge.
- **`endScrub()`** (`app.js:671`) tears down those listeners + the rAF and calls
  **`clearScrub()`** (`app.js:680`), which removes the scrub marker and readout and restores the
  blue GPS cursor (via `syncGpsCursor()`, `app.js:637`) if a fix is present.

---

## 10. GPS subsystem

A single floating action button, `#btn-gps` (`.map-fab recenter`, `index.html:78`), drives live
location; its click is bound to `toggleGPS` (`app.js`, in `bindGlobal`).

### Toggle / start / stop

- **`toggleGPS()`** (`app.js:690`) is tri-state:
  - **Not watching** → `startGPS()`.
  - **Watching but not following** (and we have a `curPos`) → re-enable follow, re-highlight the
    FAB, and recenter the map on the user at `max(currentZoom, 15)`.
  - **Watching and following** → `stopGPS()`.
- **`startGPS()`** (`app.js:807`): if `navigator.geolocation` is missing, `alert(t('alertNoGeo'))`
  and bail; otherwise request a wake lock (below), set `gpsFollow = true`, highlight the FAB
  (`.on`), show the **"Locating…" pill** (`setLocating(true)`), and start
  `navigator.geolocation.watchPosition(onPos, onPosErr,
  {enableHighAccuracy:true, maximumAge:4000, timeout:30000})`, storing the watch id in `gpsWatch`.
- **`stopGPS()`** (`app.js:814`): `clearWatch`, release the wake lock, reset
  `gpsFollow`/`curPos`, hide the "Locating…" pill, remove the GPS marker and accuracy circle, drop
  the FAB highlight, and clear the profile position layer (`#epos`).

### Position updates — `onPos()`

`onPos(pos)` (`app.js:821`):

1. Read `latitude`/`longitude`/`accuracy`; store `curPos = {lat,lon}` and hide the "Locating…" pill.
2. **Pulsing dot + accuracy circle.** On the first fix it creates:
   - `gpsMk` — an `L.marker` **on `gpsPane`** (z650, created in `initMap`, §7) whose icon is a
     `<div class="gps-dot">` (the blue dot with the CSS `gpspulse` keyframe ring), at
     `zIndexOffset:1000`. The pane is what keeps the dot **above the green walked overlay** (on
     `overlayPane`, z400) — without it the dot could be painted under a walked line that mirrors the
     track right under the user.
   - `gpsAcc` — an `L.circle` (also on `gpsPane`) of `radius:accuracy`, faint blue fill (`C.blue`),
     used as the accuracy halo.
   On subsequent fixes it just repositions both and updates the circle's radius (`app.js:824-827`).
3. **Follow mode.** If `gpsFollow`, recenter the map to the new position at `max(currentZoom,15)`
   with animation (`app.js:828`).
4. **Feed live tracking.** If a tracking session is active (`tracking && !paused`), pass the fix
   to `updateProgress` (§10a) (`app.js:829`).
5. **Profile cursor.** Draw the blue GPS cursor with `drawProfileCursor(trackPts[i], false)`
   (§9), where `i` **reuses the tracking snap index** (`progIdx`) when a session is active (so it
   can't jump to the wrong overlapping leg of an out-and-back), else `nearestIdx(lat,lon).idx`
   (`app.js:830-835`).

`onPosErr(err)` (`app.js:837`) hides the "Locating…" pill, then specifically handles
permission-denied (`code === 1`) with an instructional `alert(t('alertDenied'))` (pointing to iOS
Settings → Privacy → Location Services → Safari) and stops GPS.

### The "Locating…" pill — `setLocating()`

A transient `#gps-locating` pill is shown while a fresh fix is pending (GPS start, or a screen-on
re-acquire) and hidden the moment a fix lands or the attempt errors. **`setLocating(on)`**
(`app.js:841`) toggles it and manages a safety auto-hide timer set to **35 s** — deliberately
**longer** than the 30 s `watchPosition` timeout so the geolocation **error callback** (not this
watchdog) drives the hide. If the watchdog fired first (the old 30 s), the pill could vanish to a
false "located" state while a fix was still genuinely pending.

### How dragging disables follow

`initMap()` registers `map.on('dragstart', …)` which sets `gpsFollow = false` and removes the
FAB's `.on` class (`app.js:517`). So as soon as the user pans the map, the app stops yanking the
view back; tapping the FAB again re-engages follow (the second branch of `toggleGPS`).

### Screen Wake Lock

- **`reqWake()`** (`app.js:850`) requests `navigator.wakeLock.request('screen')` (guarded by a
  feature check, errors swallowed) so the screen stays on while navigating. Reliable on the
  iOS 26+ target. It only helps the phone-in-hand, watch-the-map case; the pocket-and-check
  pattern is handled by GPS-gap recovery (§10a), independent of the lock. It is **re-entrancy
  guarded**: a `wakeReq` flag short-circuits a request that's already in flight, and a second early
  return bails when an `!released` lock is already held — so a double `onWake()` (`pageshow` *and*
  `visibilitychange` both firing) can't orphan a second live lock.
- **`relWake()`** (`app.js:857`) releases it and nulls `wakeLock`.
- **Re-acquire on visibility.** Wake locks are dropped when a tab is backgrounded, so the
  **`onWake()`** handler (`app.js`, wired to **both `pageshow` and `visibilitychange → visible`**)
  re-requests the lock when the page becomes visible again **and** GPS is still active **and** there
  is no *live* lock — the guard is `if(!wakeLock || wakeLock.released)`, testing `.released` as well
  as null because iOS leaves the sentinel **truthy** after auto-releasing it on hide, so a bare
  `!wakeLock` check would never re-lock on the 2nd+ screen-on. `onWake()` also **repaints the elapsed clock immediately**
  (`if (tracking) updateHUD();`): iOS suspends the 1 s `setInterval` while backgrounded, which would
  otherwise leave the displayed time stale by up to ~1 s until the next tick (the elapsed value
  itself is derived from the absolute `trackStartTs`, so it is always correct — only the on-screen
  repaint needed the nudge). See §10a for the rest of the wake-from-background behavior.

---

## 10a. Live trail-progress tracking

A floating action button, `#btn-track` (`.map-fab.track`, `index.html`), **starts** a
**live trail-progress** session: each GPS fix is snapped to the trail, the walked portion fills
green over the red base, and a `#track-hud` banner (`index.html`) shows percent + elapsed time.
The FAB is **start-only** — its click is bound to `onTrackFab` in `bindGlobal()`. Once a session is
live the FAB is **hidden** and the HUD owns the controls: a **pause/resume** button (`#th-pause` →
`togglePause`) and an **end** ✕ (`#th-close` → `endTracking`, which forgets any saved session). This
split is deliberate — see the design note at the end of this section.

### Start / pause / stop

- **`onTrackFab()`** (`app.js`): the FAB handler. If a session is live it does **nothing** (the FAB
  is hidden then anyway — a defensive guard against a stray map tap). If a resume is being offered
  it **continues** that session; otherwise it `startTracking()`. It can **never** pause or reset an
  active hike — that was the old `toggleTrack` footgun (a single stray tap mid-hike paused or, while
  a resume was offered, started over and wiped progress).
- **`togglePause()`** (`app.js:950`): the HUD pause/resume button — the **only** way to pause, so
  pausing is always deliberate. On pause it banks elapsed time (`trackElapsedMs += max(0, now -
  trackStartTs)` — the `max(0,…)` guards a backward device-clock step, see "Elapsed-time clamp"
  below) and freezes the clock. On resume it re-stamps `trackStartTs = now` and **revives GPS**: if
  the watch was closed it `startGPS()`s; if the watch *survived* a long pocket-pause it calls
  `refreshGpsAfterGap()` (the watch may have gone silently dead and `progIdx` is stale, so re-acquire
  rather than trust it). Persists either way.
- **`startTracking()`** (`app.js:969`): resets progress (`walkedDist=0`, `progIdx=-1`,
  `reacqMiss=0`, `turnedAround=false`), removes any old `walkedLayer`, shows the HUD, starts GPS if
  it isn't already running (tracking needs live fixes), starts the HUD timer (`startHudTimer()` — a
  1 s clock that **also re-persists every ~30 s — even while paused** — so `savedAt` stays fresh and
  a long summit-pause's session doesn't age toward staleness and get dropped), and writes the first
  `persistSession()`.
- **`stopTracking()`** (`app.js`): resets the **in-memory** session — hides the HUD, removes
  the green overlay, zeroes progress/elapsed — but **leaves GPS as-is** (the location dot can stay
  on) **and leaves the saved session in `localStorage` intact**, so reopening the trail can still
  offer a resume. It's called by `showList()`/`openDetail()` to reset per-trail.
- **`endTracking()`** (`app.js`) = `clearSession()` + `stopTracking()`: the **explicit** end
  (HUD ✕), which also forgets the saved session.
- **`updateTrackUI()`** (`app.js`) reflects state across both controls: it **hides the start FAB**
  whenever a session is live/paused **or** a resume is being offered (`tracking || pendingResume`),
  and swaps the HUD pause button between pause (live) and resume (paused) glyph + aria-label. The
  HUD also gets a `.paused` class (dims the bar) and a localized **"Paused"** message (`trackPaused`)
  so a frozen clock always reads as intentional.

### Snapping a fix to the trail — `updateProgress()`

`updateProgress(lat,lon,accuracy)` (`app.js`), fed from `onPos` (§10), snaps each fix to a
track vertex and advances the walked distance:

- **Off-trail gate.** `offTrailGate(acc)` (`app.js`) = `max(25, min(60, 2.5*acc))` m — fixes
  whose nearest vertex is farther than the gate are rejected (progress holds), scaled to GPS
  accuracy (looser under tree cover).
- **First fix / re-acquire** uses `acquireIdx(lat, lon, gate, near, lo, hi)` (`app.js:1022`): among
  in-gate vertices **in the scan range `[lo..hi]`** (default = whole track) it takes the one whose
  distance-along is **closest to `near`** — the progress already reached (`walkedDist`). On the
  **first** fix `near` is 0, so it picks the smallest-distance-along
  vertex, and an out-and-back's trailhead/return overlap can't be mistaken for near-complete
  progress; **mid-hike** `near = walkedDist`, so a re-acquire on the return leg snaps to the return
  vertex (≈`walkedDist`) instead of jumping backward onto the overlapping outbound leg.
- **Out-and-back descent latch — `turnedAround` + `turnIdx`.** On an out-and-back the outbound and
  return legs overlap *geographically*, so the "closest distance-along to `walkedDist`" tie-break
  alone could still re-snap onto the **outbound** leg during the descent — making the elevation
  cursor / progress leap back up the climb on every screen-wake. To prevent this, `updateProgress`
  sets a module-level **`turnedAround`** latch once `progIdx >= turnIdx` **or** `walkedDist >=
  turnDist - SNAP_BACK_M` (`turnIdx` is the far-end vertex index, cached alongside `turnDist` in
  `precomputeProfileAndFarEnd`, §8; the small `SNAP_BACK_M` slack is a safety net for a screen-off
  gap right at the summit that leaves `walkedDist` just short of `turnDist`). While latched, a
  re-acquire restricts its scan to the **return half** `[turnIdx..end]`, so every descent re-acquire
  stays on the return leg. The latch is reset in `start`/`stopTracking` and `loadTrail`, and
  **re-derived from the restored progress** in `resumeSession` (so a relaunch on the descent keeps
  re-acquiring onto the return leg).
- **Subsequent fixes** use `nearestIdx()` over a **forward window** only —
  `[progIdx - SNAP_BACK_M, progIdx + SNAP_FWD_M]` (constants `SNAP_BACK_M=80`, `SNAP_FWD_M=250` m,
  `app.js:57-58`) — so the return leg of an out-and-back (which overlaps the outbound) can't match
  the wrong leg.
- **Stale-window re-acquire.** A frozen window can never reach a far-off fix — pocket the phone at
  the trailhead, pull it out at the summit, and every fix lands kilometres past the window and is
  rejected, stranding progress near the last snap. After **`REACQUIRE_AFTER` = 3** (`app.js:63`)
  consecutive out-of-window rejections (counted in `reacqMiss`), `updateProgress` falls back to
  `acquireIdx()` for that fix (whole-track, or — once `turnedAround` — the return half only),
  re-snapping from scratch so progress jumps to where you actually are.
  Since `walkedDist` is monotonic and `acquireIdx(…, walkedDist)` snaps to the vertex nearest the
  progress already reached, this only ever fills *forward* on a curated route — it never un-colors.
- **Monotonic advance.** `walkedDist` only ever grows; it recolors via `recolorProgress()`
  (`app.js`) — an `L.layerGroup` of a white halo (`walkedHalo`, weight 7.5) under a green line
  (`walkedLine`, `C.green`, weight 4), mirroring the red base track so the walked overlay fully
  hides it, built from `renderPts` with `.d ≤ walkedDist` plus an exact split vertex from
  `pointAtDistance(D)` — only when the high-water mark actually advances.

### The HUD — `updateHUD()`

`updateHUD()` (`app.js:1091`) fills the `#track-hud` percent (`.th-pct`), progress bar (`.th-fill`),
and elapsed time (`.th-num`, from `fmtElapsed(elapsedMs())`). **Out-and-back progress** is measured
against the **far end** (`turnDist`, §8) so reaching the turnaround reads 100%; loops and
point-to-point measure against the full `totalDist`. At 100% it shows a localized message
(`trackTurnaround` for out-and-back, else `trackComplete`). It is also called immediately on
`visibilitychange → visible` (§10) so the displayed clock repaints the moment the phone wakes.

> **Known limitation — Mt. Fuji (`fuji-yoshida`).** Its GPX is a full round trip, but the trail is
> declared **`route: "Point to point"`**, so progress is measured against the whole `totalDist` and
> the summit (the geographic midpoint of the round trip) reads **~50%**, with no End marker at the
> trailhead-coincident finish. This is **left as-is by product choice**, not a bug to fix — the
> out-and-back turnaround handling above does not apply to it.

### Surviving a reload — session persistence & resume

iOS suspends and may **evict** a backgrounded PWA, so a long screen-off stretch (the phone
pocketed on a climb) can reload the page mid-hike and lose the in-memory session. The session is
therefore mirrored to `localStorage` under **`SESSION_KEY`** (`app.js`):

- **`persistSession()`** (`app.js`) writes `{slug, walkedDist, progIdx, trackStartTs,
  trackElapsedMs, paused, savedAt}` on **every accepted fix** (end of `updateProgress`), on
  pause/resume, on `startTracking`, on a ~30 s heartbeat in the HUD timer, and on **`visibilitychange
  → hidden` AND `pagehide`** (both, idempotent — whichever fires before iOS suspends us). Persisting
  on every accepted fix while *visible* is the real durability backstop: a hard background-kill on
  iOS may fire **no** lifecycle event, so the last on-disk snapshot must already be current.
  `localStorage` is chosen deliberately — its writes are **synchronous**, so they survive a freeze
  better than IndexedDB (whose transactions complete on a later turn the frozen app may never reach).
  `trackStartTs` is an **absolute** `Date.now()`, so a restored running clock keeps counting *through*
  the gap; `savedAt` records last activity (used for the freshness window).
- **`freshResumable(s)`** (`app.js`) is the **single shared predicate** for every resume path
  (boot, wake, open-trail, list banner): the session's `slug` is a real trail **and** `savedAt` is
  within `SESSION_MAX_AGE_MS` (18 h) **and** it is either **paused** (a deliberate pause is honored
  however short) **or** clears the short-session floor (`savedElapsedMs ≥ RESUME_MIN_MS`, 20 s — which
  filters accidental tap-and-leave starts).
- **Elapsed-time clamp.** Every elapsed computation — `elapsedMs()`, `savedElapsedMs(s)`, and
  `togglePause()`'s banking — uses `Math.max(0, Date.now() - trackStartTs)`. This guards a
  **backward device-clock step** (an iOS NTP correction after hours off-grid): without the clamp,
  elapsed could go negative and make `freshResumable` silently discard a genuine multi-hour hike as
  "trivially short".
- **`maybeOfferResume(trail)`** (`app.js`), called at the end of `openDetail()` after the track
  loads (when **not** auto-resuming), offers the **`#track-resume`** prompt for this trail's saved
  session and **hides the start FAB** while the prompt owns the choice. Rendered by
  `renderResumePrompt()` with the saved percent + elapsed, re-localized live by `setLang()`.
- **`resumeSession(s)`** (`app.js`) restores `walkedDist`/`progIdx`/`paused`, re-derives the
  out-and-back `turnedAround` latch from that restored progress, redraws the green overlay, and (if
  not paused) revives GPS — `startGPS()` if the watch was closed, else `refreshGpsAfterGap()` — while
  **arming an immediate re-acquire** (`reacqMiss = REACQUIRE_AFTER`) so the first post-resume fix
  re-snaps from scratch (the saved position is known-stale) rather than crawling through 3 rejected
  windowed fixes. It then restarts the HUD timer and re-stamps the session. Bound to the prompt's
  **Resume**; **Dismiss** calls `clearSession()` (and the start FAB returns).

`RESUME_MIN_MS` (20 s, `app.js`) is the short-session floor inside `freshResumable`, shared by every
resume path. A **paused** session bypasses it (pausing is intentional, so it's always resumable).

### Auto-resume on cold relaunch — `bootRoute()`

When iOS evicts the PWA mid-hike, a relaunch loads a fresh document → the `load` handler. An
installed iOS standalone PWA relaunches **inconsistently**: sometimes at the manifest `start_url`
(`"./"`, no hash), sometimes **restoring the last URL including the fragment** (`#/trail/<slug>`) —
and OS memory-eviction (the pocket-the-phone case) skews toward the URL-restore path. **`bootRoute()`**
(`app.js`) — called once from `load` **instead of** `routeFromHash()` — therefore decides
**independently of the hash**: if `freshResumable(readSession())`, it sets `resumeOnOpen = true` and
`history.replaceState(null, '', '#/trail/' + slug)` (overriding an empty **or** restored/foreign
hash so the active hike always wins), then calls `routeFromHash()`. Net effect: a cold relaunch
mid-hike lands **straight on the trail screen and auto-resumes** — *deterministically*, no matter
which way iOS restored the URL. (Keying this off `!location.hash`, as it once did, made auto-resume
fire only on the bare-`start_url` relaunches and silently fall through to a passive prompt on the
URL-restore ones — the original "sometimes it resumes, sometimes it doesn't" bug.)

- **`replaceState`** (not assigning `location.hash`) sets the route without firing a second
  `hashchange`, and — because it *replaces* rather than pushes — the **Back button** (hash → `''`)
  still returns to the list, so navigation is never trapped.
- **`resumeOnOpen`** is captured + consumed **synchronously at the top of `openDetail()`** (before
  its `await loadTrail`), and the post-await `if (curTrail !== trail) return` guard drops a resume
  whose navigation was superseded mid-load — so a fast second navigation can't misroute the resume
  or write stale state onto a torn-down map.
- The list **"resume hike" banner** (`#list-resume` / `updateListResume()`) is the **fallback**,
  surfaced on the list for cases auto-resume doesn't cover.

**Resident-process wake — `onWake()`.** The *most common* "just checking" case isn't a relaunch at
all: iOS keeps the page **resident** and foregrounds it with **no `load` event**, so `bootRoute`
never runs. The lifecycle layer handles this. iOS fires wake events inconsistently, so we hook
**both `pageshow` and `visibilitychange → visible`** through one idempotent **`onWake()`** (and
**both `pagehide` and `visibilitychange → hidden`** through `onHide()`, which persists the session
and clears `gpsWakePending` + its `gpsWakeGuard` timer — a self-heal: iOS can abandon a wake-time
`getCurrentPosition` mid-flight when the phone is re-pocketed, firing neither callback, which would
otherwise leave the flag stuck and make every later `refreshGpsAfterGap()` bail). `onWake()`:
**(1)** refreshes the list `#list-resume` banner so a resident wake onto the list still surfaces the
hike; **(2)** on a trail screen with a resumable session but no prompt yet, re-surfaces the offer
(**stood down while `booting` or `openingDetail`** is set — see below); **(3)** if tracking, repaints
the clock at once (the 1 s interval is suspended while hidden); and
**(4)** if GPS was live, runs `refreshGpsAfterGap()` — **but only when not paused**
(`!(tracking && paused)`): a paused wake skips the re-acquire so it can't taint the eventual un-pause
with a spurious wrong-leg re-snap (the wake-lock re-acquire above still runs so the screen stays on
if the user un-pauses). `refreshGpsAfterGap()` itself **arms an immediate re-acquire**
(`reacqMiss = REACQUIRE_AFTER`), **kicks one fresh fix** (`getCurrentPosition({maximumAge:0})`), and
**`restartWatch()`s** the position watch. The watch restart matters: iOS can leave `watchPosition`
**silently dead** after a screen-off gap (no fixes, no error), so a one-shot alone would paint one
fix and then nothing — re-issuing the watch (no permission re-prompt within a granted session)
restores continuity. `refreshGpsAfterGap()` is deduped by **`gpsWakePending`** so a rapid lock/unlock
or a `pageshow`+`visibilitychange` double-fire can't stack overlapping requests; a **`gpsWakeGuard`**
timer (32 s) **always** clears that flag afterward, even if iOS fires neither GPS callback, so GPS
can never get permanently wedged. A `#gps-locating`
"Locating…" pill (`setLocating()`) covers the brief GPS cold-start.

> **Two boot/open guards stand `onWake`'s resume-surfacing down so it can't race the owner of that
> decision:** **`booting`** (true until just after the first `load`) defers to `bootRoute`, which owns
> the initial-load resume; and **`openingDetail`** (set true at the top of `openDetail` and cleared in
> its `finally`) defers to `openDetail`'s own post-`loadTrail` resume — without it a resident wake
> firing during a cold relaunch's `openDetail` could flash a resume prompt that `openDetail` then
> replaces. `onWake` re-surfaces a resume only when `!booting && !openingDetail`.

This does **not** add background tracking (impossible on iOS web — see `IOS-PWA-GUIDE.md`): no GPS
fixes are captured while the screen is off, and no breadcrumb path is recorded. It makes the
*session* — the progress high-water mark and the elapsed clock — survive the gap, so reopening at
the summit shows the right elapsed time and (after the re-acquire) progress to where you stand,
measured against the known GPX rather than a recorded track.

---

## 11. Bottom sheet subsystem

The detail screen's `#sheet` (`index.html:94-101`) is a draggable bottom sheet with a grip
(`#grip`), a tappable peek region (`#sheet-peek`), and a scrollable body (`#sheet-body`). It has
two states tracked by `sheetState` (`app.js:83`): **`'peek'`** and **`'full'`**.

### Heights & `setSheet()`

- **Peek height** is computed by **`computePeekH()`** (`app.js:850`) from the rendered sheet
  geometry — `#elev-card`'s `offsetTop + offsetHeight + 14` (so the peek reveals the whole
  elevation chart for scrubbing) — clamped to **[16vh, 62vh]**. **16vh**
  (`round(innerHeight*0.16)`) is only the **fallback** (used in landscape or before the body
  renders); `sheetPeekHeight()` (`app.js:857`) returns the cached `peekH` or that fallback.
- **Full height** is **`90dvh`** (dynamic viewport height) (`app.js:869`); CSS caps the sheet at
  `max-height:92dvh` (`app.css:240`).
- **`setSheet(state)`** (`app.js:858`) first re-measures via `computePeekH()`, then:
  - In landscape (`(orientation:landscape) and (max-height:560px)`) the sheet is docked to the
    side, so it clears the inline height and just parks the FABs at
    `calc(20px + var(--safe-b))` (`app.js:864-866`).
  - Otherwise it sets the sheet's inline `height` to the peek px or `90dvh`, and positions the
    **GPS FAB just above the peek sheet**: `bottom = calc(<peekPx>px + 14px)` (`app.js:870`). So
    in peek the FAB floats over the map above the sheet; when the sheet expands to full, the FAB
    ends up behind it.
  - Either way it **also parks the track FAB 58px above the GPS FAB** (`app.js:873`).

The sheet's smooth open/close is a CSS height transition
(`transition:height .32s cubic-bezier(...)`, `app.css:239`), with `touch-action:none` so the
drag gesture isn't hijacked by the browser.

### Drag gesture — `initSheetDrag()`

`initSheetDrag()` (`app.js:875`) implements a unified pointer drag:

- **Start** (`touchstart` passive / `mousedown` on **both** `#grip` and `#sheet-peek`) records
  the start Y and the sheet's current height, and disables the CSS transition for 1:1 dragging.
- **Move** (window-level `touchmove`/`mousemove`) sets the sheet height to
  `clamp(peekHeight … innerHeight*0.9)` based on drag delta (`startH + (startY - y)`).
- **End** (`touchend`/`mouseup`) re-enables the transition and **snaps**: if the released height
  is above `innerHeight*0.45` → `setSheet('full')`, else `setSheet('peek')` (`app.js:880`).

### Tap to toggle

Tapping the peek (when not mid-drag) toggles between peek and full:
`peek.addEventListener('click', () => setSheet(sheetState==='peek'?'full':'peek'))`
(`app.js:889`).

### FAB position tracks the sheet

As described above, every `setSheet()` recomputes the FABs' `bottom`. On resize/rotation the
debounced handler also re-runs `setSheet(sheetState)` so the FABs and sheet height stay correct
(`app.js:998-1000`).

---

## 12. Offline tile download subsystem

Two coexisting buttons pre-cache map tiles (across both tile sources) so maps work with no
connectivity. **Saved tiles go into IndexedDB** (`tiles-db.js` → `TileStore`), not the Cache API.
The **global** `#dl-all` button (`.dl-all-btn`, `index.html:38`, bound to `downloadAll` in
`bindGlobal()`) saves **all** trails in one tap; a **per-trail** `.card-dl` button on each list
card (rendered by `renderList`, wired via one delegated `#trail-list` listener to `downloadOne`)
saves just that trail. Both share the same engine — `saveTiles(urls, onProgress)` →
`downloadTrail(trail, urls, onProgress)`, fed by `trailTileURLs(trail)` — and the same
`trailSaved(trail)` probe. The old download **modal** is
gone (each button's own idle/percent/done state is its status); iOS has no background fetch, so
every download is a foreground, user-initiated action with inline progress on the button itself.

### The completion manifest — why "saved" is gated on a record, not a tile probe

A trail counts as **saved** only when **both** are true: a **completion-manifest record** exists for
it in `localStorage`, **and** that record's multi-zoom **probe tiles are all still in IndexedDB**.
The manifest (`MANIFEST_KEY = 'tileManifest'`) maps `slug → { savedAt, probes }`, where `probes` is a
handful (~8) of tile URLs spread evenly across the trail's zoom-ordered tile set (`sampleProbes(urls,
k=8)`). Helpers: `readManifest` / `writeManifest` / `markSaved(slug, urls)` (writes a record) /
`clearSaved(slug)` (forgets one).

**Why it exists (the reported bug):** the *old* `trailSaved` probed **one z14 center tile**, and the
button's "done" was gated on `ok > 0`. But the service worker caches **every tile it serves while you
browse online** (the §15 tile branch, `e.waitUntil(TileStore.put(...))`), so merely *viewing* a map
online planted that one probe tile and **faked a green ✓ while most tiles were missing** → a blank map
offline. A partial/interrupted download likewise flipped to ✓. The manifest gate fixes both: a
manifest record is written **only** by a download that committed its *whole* expected set with **zero
hard failures**, so incidentally-cached SW tiles (which write no record) and partial downloads (which
clear the record) can never masquerade as a complete offline download.

### Button state — `dlState` / `updateDlBtn()` / `updateDlProgress()`

The global button's appearance is driven by the module-level **`dlState`** (`'idle' | 'busy' |
'done'`, `app.js:88`):

- **`updateDlBtn()`** (`app.js:1399`) toggles the `.busy` / `.done` classes and sets the
  static label — `t('dlAll')` in `idle`, `t('dlAllDone')` in `done`. `applyStaticI18n()` calls
  it so the label tracks the language (§1a).
- **`updateDlProgress(done,total)`** (`app.js:1408`) computes a percentage, writes it to the
  button's **`--p` CSS custom property** (which drives the gradient fill of `.dl-all-btn.busy`,
  `app.css:89-92`), and — while `busy` — sets the button text to the live `"NN%"`.

The per-trail card buttons are painted by **`setCardDl(slug, state, pct)`** (`app.js:1418`) off the
`cardDl` slug→state map; the busy **percentage** is mirrored into a `cardDlPct` slug→number map so
`renderList` can restore the busy ring's `--p` after a filter/sort/language re-render *mid-download*
(item 7 — the running download holds its slug in a closure and keeps painting on its next tick).

### Web Mercator tile math

The download converts a lat/lon box to **XYZ tile ranges** at each zoom:

- **`ll2t(lat, lon, z)`** (`app.js:1258`) is the standard slippy-map projection:
  `n = 2^z`, `x = floor(n*(lon+180)/360)`, and
  `y = floor(n*(1 - ln(tan(φ) + sec(φ))/π)/2)` with `φ = lat·π/180`. Returns `{x, y}`.
- **`tRange(b, z)`** (`app.js:1256`) projects the SW and NE corners and returns the inclusive
  `{x0,x1,y0,y1}` tile range (min/max-ed so corner order doesn't matter).
- **`DL_MIN_Z = 10`** (`app.js:11`) — the overview floor for downloads. Each trail caches from
  z10 up to **its source's `maxZoom`**: **z10–16** for USGS, **z10–18** for GSI. The upper bound
  is the source's real native ceiling, so no 404-ing tiles are requested. (The *same* `padFor(z)`
  padding that bounds the download also clamps panning per zoom, §7's `applyMaxBounds`.)

### Per-trail bounding box — `gpxBox()`

**`gpxBox(trail)`** (`app.js:1265`) is **async**: it fetches the trail's GPX (served from the
SW precache, so it works offline too), parses it, and computes the min/max lat/lon over all
`<trkpt>` elements. If parsing yields no track points it **falls back** to `trail.center ±
0.02°`. It returns the **raw** box; the surrounding context buffer is added later, per zoom,
by `tileURLsFor()` via **`padFor(z)`** (`app.js:16`) — **0.05°** at z≤12, **0.03°** at z13–14,
**0.015°** at z15–16, **0.008°** at z17, **0.004°** at z18. Padding is heaviest at overview
zooms (where you pan to see surrounding terrain) and progressively tighter toward max detail,
since each extra zoom quadruples the tile count and you rarely pan far while reading z17–18
detail right at your position. This replaces
the old `trailBox()`/`countTiles()`/`tileURLs()` trio, which depended on the *currently open*
trail's live `trackPts`; `gpxBox()` works for any trail without it being open.

### Expanding a box to URLs — `tileURLsFor()` / `trailTileURLs()`

**`tileURLsFor(box, src)`** (`app.js:1282`) expands a box into every concrete tile URL
across **z10 up to `src.maxZoom`**, **expanding the box by `padFor(z)` for each zoom**, then
substituting tokens **by name** into that source's template
(`src.url.replace('{z}',z).replace('{y}',y).replace('{x}',x)`). Because it substitutes by name,
the same routine builds both the USGS `{z}/{y}/{x}` and the GSI `{z}/{x}/{y}` URLs correctly
(§7), each to its own zoom ceiling. **`trailTileURLs(trail)`** (`app.js:1347`) is the one-liner that
wraps `tileURLsFor(await gpxBox(trail), trailSource(trail))` for one trail.

### Batched fetch into IndexedDB — `saveTiles()` / `downloadTrail()` / `downloadAll()`

**`saveTiles(urls, onProgress)`** (`app.js:1301`) is the shared fetch-and-commit engine. It dedupes
the list with a `Set` and walks it in **batches of 8** (`BATCH = 8`, `Promise.allSettled` so one bad
tile can't abort a batch). For each tile it **classifies** the outcome rather than just counting
successes:

- **`ok`** — already present (`TileStore.has`) **or** fetched `ok` and **committed to IndexedDB on
  the page** (`TileStore.put(u, {body: await r.arrayBuffer(), type})`). Committing **on the page**
  (rather than leaning on the SW's deferred `e.waitUntil` write, which iOS can cut off when it
  suspends the backgrounded SW) is what makes "saved" mean *stored*, not merely *fetched*. On the
  SW-controlled path the SW also caches the same key — an idempotent duplicate, not a second fetch.
- **`absent`** — the host returned **404**: there is legitimately no tile there, so it **counts as
  covered, not a failure**.
- **`fail`** — a network error, the SW's offline **503**, a **5xx**, or an IndexedDB **quota abort** —
  *retryable*, and what blocks a trail from being recorded complete. A `QuotaExceededError` also sets
  the module flag **`dlQuotaHit`** so the caller can warn.

It returns **`{ok, absent, fail}`** and reports progress via `onProgress(done, total)`.

**`downloadTrail(trail, urls, onProgress)`** (`app.js:1351`) is the per-trail core both buttons share:
it runs `saveTiles`, then **writes the completion-manifest record iff `fail === 0`** (`markSaved`),
else **clears any record** (`clearSaved`) — so a partial/interrupted download can never claim saved.

**`downloadAll()`** (`app.js:1361`) is the global flow:

1. Bail if already `busy` **or** IndexedDB is unavailable; if `!navigator.onLine`, bail with the
   `dlOffline` alert (don't animate to a false ✓ offline). Reset `dlQuotaHit`, set `dlState='busy'`,
   `updateDlBtn()`, seed the bar.
2. Build **each trail's URL list up front** (`trailTileURLs`), mark every card `busy`, and sum the
   grand total so the **single combined progress bar** reflects true overall progress.
3. **Iterate trails one-by-one** — a per-trail loop over `downloadTrail`, *not* one big deduped list.
   Trails are geographically disjoint, so there's no cross-trail tile overlap to dedupe, and running
   per-trail lets **each card earn its own honest completion record** and paint live (busy→done/idle).
   Progress is offset by the running `base` so the global bar advances smoothly across trails.
4. Drop `dlState` to `'idle'`, then **reconcile the global state via `await refreshCacheStatus()`**
   (which sets `done` only if *every* trail is verified saved) and `updateDlBtn()`.
5. Finally, alert **`dlQuota`** if storage ran out, else **`dlPartial`** if any trail had `fail > 0`.

**`downloadOne(slug)`** (`app.js:1385`) is the per-trail card button: same guards (busy / IndexedDB /
`navigator.onLine`) and the same `downloadTrail` core, scoped to one trail and painted via
`setCardDl`. On success it runs `refreshCacheStatus().then(updateDlBtn)` (this trail completing may
flip the global button to ✓); otherwise it alerts `dlQuota` / `dlPartial`.

> Because the page and the SW share the **same IndexedDB store** (`tiles-db.js` →
> `wa-trails-tiles`), every pre-downloaded trail — US or Japan — is later served **IndexedDB-first**
> by the SW with zero further network use (see §15).

> **Scale.** A full "Save maps" is now **~5,200 tiles** (≈2,830 USGS across the 8 WA trails +
> ≈2,480 GSI across the 2 Japan trails — the GSI z17–18 levels roughly doubled the old GSI count),
> about **~100 MB** at ~20 KB/tile. (The earlier "~3,200 tiles / ~50–80 MB" figures predate the
> z17–18 GSI levels.) iOS's 7-day eviction applies to the IndexedDB store just as it did to the old
> tile cache.

### Status verification — `trailSaved()` / `refreshCacheStatus()`

**`trailSaved(trail)`** (`app.js:1432`) is the truth source for "is this trail saved?". It reads the
trail's **completion-manifest record**; with no record it returns `false`. Otherwise it verifies that
**all** of the record's probe tiles (the ~8 spread across zoom levels by `sampleProbes`) are still in
IndexedDB via `TileStore.has`. If **any** probe is missing — i.e. iOS evicted the set under the 7-day
rule — it `clearSaved(slug)`s the now-stale record and returns `false` (so the trail is demoted *and*
its record forgotten).

**`refreshCacheStatus()`** (`app.js:1443`) decides the buttons' startup state from that truth. It
bails if IndexedDB is unavailable or a download is `busy`; otherwise, for **each** trail, it calls
`trailSaved(trail)` and `setCardDl(slug, saved ? 'done' : 'idle')` (leaving a `busy` card alone). It
sets `dlState='done'` **only if every** trail is verified saved, else `'idle'`. It runs **off the boot
critical path**: boot calls `refreshCacheStatus().then(updateDlBtn)` **without awaiting it before
routing** (ADR-12 — awaiting an IndexedDB open here is what used to stall launch once many tiles were
saved).

> This is the fix for the false-✓ caveat the previous revision flagged as "still open". The old probe
> sampled a **single z14 center tile** and gated "done" on `ok > 0`, so a tile the SW had cached
> incidentally while you browsed online faked a complete download. The manifest + multi-zoom probe
> closes both holes: only a complete download writes a record, and a partial eviction trips a probe.

---

## 13. State management

All runtime state lives as **module-level `let`/`const` bindings** at the top of `app.js`
(plus a couple declared inline). There is no store, no reactive system — functions read/write
these directly and re-render by rewriting `innerHTML`.

| Variable | Decl | Holds |
|---|---|---|
| `map` | `app.js:83` | The current Leaflet map instance (or `null`). |
| `curTrail` | `app.js:83` | The trail object currently open in detail (or `null`). |
| `trackLayer` | `app.js:83` | The red track polyline `L.polyline` (used for `fitBounds`). |
| `trackPts` | `app.js:84` | Parsed track points: `{lat, lon, ele, d, se}` with cumulative distance `d` and smoothed elevation `se`. |
| `trackWpts` | `app.js:84` | Parsed waypoints: `{lat, lon, name, d, _marker}` with snapped along-track distance `d` and the retained Leaflet marker. |
| `totalDist` | `app.js:85` | Total track length in meters (for profile x-scaling). |
| `gpsWatch` | `app.js:85` | `watchPosition` id while GPS is active (`null` when off). |
| `gpsMk` | `app.js:85` | The pulsing GPS-position marker (or `null`). |
| `gpsAcc` | `app.js:85` | The GPS accuracy circle (or `null`). |
| `gpsFollow` | `app.js:85` | Whether the map auto-recenters on the user. |
| `curPos` | `app.js:86` | Last known `{lat, lon}` fix (or `null`). |
| `wakeLock` | `app.js:86` | The active Screen Wake Lock sentinel (or `null`); `wakeReq` is the re-entrancy flag (a `reqWake()` is in flight). |
| `sheetState` | `app.js:87` | Bottom-sheet state: `'peek' | 'full'`. |
| `dlState` | `app.js:88` | Global offline-maps download state: `'idle' | 'busy' | 'done'` — drives the `#dl-all` button (§12). |
| `cardDl` / `cardDlPct` | `app.js:89-90` | Per-trail download state by slug (`'idle'|'busy'|'done'`) and the busy progress % by slug — survive `renderList` re-renders so a card button (and its busy ring) repaint correctly mid-download (§5, §12). |
| `dlQuotaHit` | `app.js:1300` | Set by `saveTiles` when an IndexedDB `QuotaExceededError` was hit, so `downloadAll`/`downloadOne` alert `dlQuota` (§12). |
| `eleLo` / `eleHi` / `eleRange` | `app.js:91` | Cached smoothed-elevation bounds for the profile Y scale (set in `loadTrail`, §8). |
| `renderPts` | `app.js:94` | Downsampled track points (with cumulative `.d`) for the polyline, reused by the green walked overlay (§10a). |
| `turnDist` / `turnIdx` / `isOutAndBack` | `app.js:99` | Far-end (turnaround) distance + vertex index and the out-and-back flag, used by live-tracking progress and the `turnedAround` re-acquire latch (§8, §10a). |
| scrub state | `app.js:102` | `scrubbing`, `scrubMk`, `scrubRAF`, `scrubX`, `scrubRect`, `scrubCardRect` — elevation-scrub gesture state (§9). |
| tracking state | `app.js:104-118` | `tracking`/`paused`, `trackStartTs`/`trackElapsedMs`/`hudTimer`/`hudTicks` (heartbeat-persist counter), `walkedDist`/`progIdx`, `turnedAround` (out-and-back descent latch → re-acquire on the return leg only), `walkedLayer`/`walkedHalo`/`walkedLine`, `reacqMiss` (consecutive off-window fixes → re-acquire), `pendingResume` (saved session offered for resume), `resumeOnOpen` (a list-banner / cold-relaunch resume that auto-resumes on open), `gpsWasHidden` (GPS was live when last backgrounded → refresh on return), `gpsWakePending` (a wake-time one-shot fix is in flight → dedupes rapid visibility flips) + `gpsWakeGuard` (the 32 s timer that always clears it), `booting` (true until just after first load → `onWake` defers the resume to `bootRoute`), `openingDetail` (true while `openDetail` awaits → `onWake` stands its resume down), `locatingTimer` (safety auto-hide for the "Locating…" pill), plus `SESSION_KEY`/`SESSION_MAX_AGE_MS` (18 h)/`RESUME_MIN_MS` (20 s) — the live trail-progress session, mirrored to `localStorage` so it survives a reload (§10a). |
| `lang` | `app.js:126` | Active language: `'ja'` (default) or `'en'`, seeded from `localStorage.lang` (§1a). |
| `listFilter` | `app.js:227` | Active difficulty filter (`'all'` or a `diffKey`). |
| `listSort` | `app.js:227` | Active sort (`'dist'`, `'gain'`, or `null`). |
| `peekH` | `app.js` | Cached bottom-sheet peek height in px (computed by `computePeekH()`, §11). |
| `rzT` | `app.js` | Debounce timer handle for the resize handler. |

Two trivial DOM helpers are also defined globally: **`$`** (`querySelector`) and **`$$`**
(`querySelectorAll` → array) (`app.js:120-121`). The i18n helpers `t` / `tf` / `loc` / `trDiff` /
`trRoute` / `trDogs` / `trWpt` / `trSeason` and the unit formatters `fmtDist` / `fmtGain` /
`fmtTime` / `fmtElevRange` are documented in §1a.

Module-level **constants** (`app.js`): `DL_MIN_Z` (10), the zoom-aware padding helper `padFor(z)`
(0.05° / 0.03° / 0.015° / 0.008° / 0.004°), `FT` (3.28084), `MI_PER_KM` (1.609344), the
profile-geometry constants `PROF_H` (96) / `PROF_PAD_B` (14) / `PROF_PAD_T` (12), the `C` colour
palette (track/marker hex, mirroring app.css), the live-tracking snap window `SNAP_FWD_M` (250) /
`SNAP_BACK_M` (80) and `REACQUIRE_AFTER` (3), the session-resume constants `SESSION_MAX_AGE_MS`
(18 h) / `RESUME_MIN_MS` (20 s), the inline-SVG icon set (`ICON_PATHS` + `ICON_PLAY`/`ICON_PAUSE`),
the difficulty `DIFF` table, and the per-trail basemap table **`TILE_SOURCES`** with its resolver
**`trailSource()`** (§7). There is **no `TILE_CACHE` constant** anymore — saved tiles live in
IndexedDB, in the **`wa-trails-tiles`** store defined by `tiles-db.js` (`window.TileStore`), which
`app.js` calls (`TileStore.has`/`put`) rather than opening a Cache. The **completion manifest** lives
in `localStorage` under `MANIFEST_KEY = 'tileManifest'` (slug → `{savedAt, probes}`), the truth source
for the download buttons' "saved" state (§12).

---

## 14. Responsive design

### Portrait (default)

The default layout is a single-column, full-height mobile UI: the list is a vertical
flex column of cards (`#trail-list`, `app.css:115`); the detail screen layers a full-bleed
`#map`, a floating translucent header, the GPS FAB, and the bottom sheet.

### Landscape phones — `@media (orientation:landscape) and (max-height:560px)`

A single media query (`app.css:402-422`) reflows the app for landscape phones (short viewports):

- **List → 2-column grid.** `#trail-list` becomes
  `display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:min-content` (`app.css:405`).
- **Detail → map left, sheet docked right.** `#sheet` is repositioned to the **right edge**
  (`top:0; bottom:0; left:auto; right:0; width:min(360px,42%)`), with `height:auto !important`,
  no rounded corners, and a left-side shadow; its top padding clears the header
  (`app.css:411-415`). The grip and peek are **hidden** (`display:none`) since the sheet is
  always open, and `#map` is shrunk to make room: `right:min(360px,42%)`.
- **FAB repositioning.** `setSheet()` detects this same media query at runtime and parks the
  FABs at `calc(20px + var(--safe-b))` instead of above the (now side-docked) sheet
  (`app.js:864-866`).

### Safe-area-inset handling (notch / home indicator)

Four design tokens capture the device safe areas:
`--safe-t/-b/-l/-r = env(safe-area-inset-*)` (`app.css:26-29`), enabled by
`viewport-fit=cover` in the viewport meta (`index.html:5`) and the
`apple-mobile-web-app-status-bar-style: default` meta (`index.html:8`). (The head
also declares **both** the standard `mobile-web-app-capable` and the legacy
`apple-mobile-web-app-capable` meta tags for standalone display, `index.html:6-7`.) They're
applied throughout so content avoids the notch and home indicator: the list header padding
(`app.css:56`), the list's bottom scroll padding (`app.css:117`), the detail header height/padding
(`app.css:165`), the map FAB's left offset (`app.css:189`), and the sheet body's bottom padding
(`app.css:254`).
The Leaflet zoom control is likewise nudged by `env(safe-area-inset-top)` in JS (`app.js:423`).
`#app` is **`position:fixed; inset:0; overflow:hidden`**
(`app.css:44`), pinning it to the visual-viewport edges (including the safe areas under
`viewport-fit=cover`). It was previously sized with `height:100dvh` (with a `100vh` fallback),
but in an installed iOS standalone PWA `100dvh` could resolve ~34px short of the physical screen
and leave a gap at the bottom; the fixed-inset approach fills the true screen.

---

## 15. Caching layers

Saved data lives in **two stores with different roles**: a **single Service-Worker cache** for the
app shell, and a **separate IndexedDB store** for map tiles. (Tiles moved out of Cache Storage in
ADR-12 — see the rationale below and in `docs/DECISIONS-AND-LESSONS.md`.)

| Store | Name / constant | Contents | Written by |
|---|---|---|---|
| Cache Storage | `wa-trails-app-v20` = `APP_V` (`sw.js:1`) | **App shell + bundled assets** — HTML/CSS/JS (incl. `i18n.js` and **`tiles-db.js`**), manifest, icons, Leaflet CSS+JS, and **all 10 GPX files + 10 hero images**. ~20 files. | SW `install` (precache SHELL + best-effort `TRAIL_ASSETS`); SW `fetch` fills same-origin/unpkg misses. |
| IndexedDB | `wa-trails-tiles` / store `tiles` (`tiles-db.js`) | **Map tiles** — both **USGS** topo (US trails) and **GSI 地理院タイル** (Japan trails), keyed by full URL → `{body, type}`. | The page's `saveTiles()` (commits each fetched tile's bytes directly, §12) and the SW's tile `fetch` handler (on every network fill while browsing). |

> The store **names** retain the historic `wa-trails-` prefix (an internal identifier — not
> user-facing). The product is "Ume-chan's Trails"; only these internal keys keep the old prefix.

### Shell precache (`install`)

On `install` (`sw.js`, `install` handler), the SW opens `APP_V` and precaches each `SHELL` entry by
**fetching it with `{cache:'reload'}` and `cache.put`-ing the result** (rather than `addAll`).
Bypassing the HTTP cache this way means a freshly-deployed version can never store a **stale** shell
file — e.g. an `index.html` that predates a just-added script. `SHELL` lists `./`, `index.html`,
`app.css`, `app.js`, `trails.js`, **`i18n.js`**, **`tiles-db.js`**, `manifest.json`,
`icon-180.png`, `icon-192.png`, `icon-512.png`, and the two Leaflet CDN URLs (`sw.js:5-10`); these
**must all succeed** (a failed shell fetch throws and fails the install). It then **best-effort**
caches `TRAIL_ASSETS` (the **10 GPX + 10 webp** — 8 Washington + 2 Japan, `sw.js:13-25`), also with
`{cache:'reload'}`, wrapped in `Promise.allSettled` so a single failed asset doesn't break install.
It calls `skipWaiting()`. Bundling the GPX and images means a trail's track and photo are available
with **zero network**, even one the user has never opened.

### Activation / cleanup (`activate`)

On `activate` (`sw.js`, `activate` handler), the SW deletes **every** cache whose name is **not**
`APP_V` (`keys.filter(k => k !== APP_V)`), then `clients.claim()`. Because the shell cache is now
the **only** Cache Storage cache, this both performs the normal version migration (bumping `APP_V`
on a deploy evicts the previous shell cache) **and drops the old `wa-trails-tiles-v1` tile cache**
left over from pre-ADR-12 builds. That deliberate drop is safe — tiles now live in IndexedDB — and
is in fact what restores fast launch for a user upgrading from a tiles-in-Cache build (freeing that
large cache). Users simply re-download tiles once into IndexedDB.

> **Note:** the old version of this doc claimed `activate` *preserves* the tile cache so downloads
> survive shell upgrades. That is no longer true (and is the **opposite** of current behavior): the
> tile cache is dropped on activate; tile durability now comes from IndexedDB, which `activate`
> never touches.

### Fetch strategy (`fetch`)

`fetch` (`sw.js`, `fetch` handler) has two branches:

1. **Tiles (IndexedDB-first).** Any URL whose host is `nationalmap.gov` **or**
   `cyberjapandata.gsi.go.jp` is served from the `TileStore`: `await TileStore.get(url)` and, on a
   hit, replay the stored bytes as `new Response(rec.body, {headers:{'Content-Type':rec.type}})`.
   On a miss it `fetch`es; if the response is `ok` it keeps the SW alive
   (`e.waitUntil(res.clone().arrayBuffer() → TileStore.put(url, {body, type}))`) to store the tile,
   and returns the network response. On network failure it returns an empty `503`. This single
   branch covers both basemap providers and is what makes saved tiles render offline.
2. **Shell + bundled assets (cache-first, scoped to `APP_V`).** Everything else opens **`APP_V`
   specifically** and tries `cache.match(req)` — **not** a global `caches.match()`. (A global match
   can make WebKit open/scan unrelated stores; scoping keeps shell serving off any large store and
   was part of the ADR-12 fast-launch fix.) On a miss it fetches, and if `ok` **and** the request is
   same-origin or an `unpkg.com` host, stores the clone in `APP_V`. On a network failure it falls
   back to the cached `./index.html` for **navigations** (so the app still launches offline), or an
   empty `503` otherwise.

### How the page-level download ties in

The page and the SW share **one IndexedDB store** (`tiles-db.js` is loaded by both — the page via
`<script src>`, the SW via `importScripts`), so they no longer need to agree on a cache name. During
a download (§12) the page **commits each fetched tile's bytes itself** (`saveTiles` →
`TileStore.put`), so reaching "saved" means the bytes are actually stored — it does **not** rely on
the SW's deferred `e.waitUntil` write, which iOS can cut off when it suspends the backgrounded SW. On
the SW-controlled path the SW also caches the same key (an idempotent duplicate), and merely browsing
a map online still warms the store via that branch. Afterward the SW serves every saved tile
**IndexedDB-first**. The `activate` cleanup touches only Cache Storage, so IndexedDB tiles persist
across app updates (subject only to iOS's 7-day eviction).

---

## Appendix — runtime sequence (open a trail, go offline)

```
boot
   └─► load ─► applyStaticI18n() (fill [data-i18n], <title>, <html lang>; updateDlBtn())
            ─► renderList() ─► bindGlobal()
            ─► bootRoute()  (fresh session, hash-independent? replaceState '#/trail/<slug>'
            │                + resumeOnOpen=true) ─► routeFromHash()
            ─► register sw.js
            ─► refreshCacheStatus().then(updateDlBtn)   (#dl-all idle|done; OFF the
            │                                            critical path — not awaited)
            └─► if localStorage.perf==='1': console.info('[perf] sw-served shell ~Nms · …')

user taps card
   └─► location.hash = "#/trail/<slug>"
         └─► hashchange ─► routeFromHash() ─► openDetail(t)
               ├─ swap screens (#list hidden, #detail shown)
               ├─ #detail-title = loc(t).name
               ├─ setSheet('peek')
               ├─ renderPeek(t)       (fill #pk-title/#pk-meta, localized + units)
               ├─ renderSheetBody(t)  (stats, empty <svg>, prose, facts,
               │                       attribution = AllTrails ／ trailSource(t).creditKey)
               ├─ initMap()
               │     ├─ src = trailSource(t)   (usgs | gsi)
               │     ├─ L.map(center=t.center, zoom=13)
               │     ├─ zoom control @ topright
               │     └─ src tileLayer (USGS or GSI) ──► requests intercepted by sw.js
               │                              └─ TileStore (IndexedDB) first
               └─ await loadTrail(t)
                     ├─ fetch(t.gpx) ──► sw.js serves from APP_V (works offline)
                     ├─ DOMParser ─► trackPts[] (d via hav), trackWpts[] (none on JP trails)
                     ├─ smoothEle()  (window 15 ─► .se)
                     ├─ snap wpts to nearest track-point distance
                     ├─ drawTrack()    (subsample ≤1200; halo+red line;
                     │                   green trailhead (markerTrailhead);
                     │                   red end (markerEnd) if !isLoop;
                     │                   amber wpts on w._marker; fitBounds w/ sheet padding)
                     └─ drawProfile()  (SVG area+line gradient, wpt verticals, elev range)

user taps EN / 日本語 (#lang-toggle)
   └─► setLang(next) ─► persist localStorage.lang
         ─► applyStaticI18n() (also updateDlBtn() ─► relabels #dl-all) ─► renderList()
         ─► if curTrail: #detail-title, renderPeek(), renderSheetBody(),
                         redrawTrailLabels()  (re-bind marker popups, no map rebuild)

user taps ◎ (GPS)
   └─► toggleGPS() ─► startGPS() ─► reqWake() + watchPosition()
         └─► onPos() ─► move gps-dot + accuracy circle
                       ─► if follow: recenter
                       ─► if tracking: updateProgress()
                       ─► nearest trackPt ─► drawProfileCursor(trackPts[i], false)

user taps "⬇ Save maps" (#dl-all, downloads ALL trails)
   └─► downloadAll()  ─► (navigator.onLine? else alert dlOffline) ─► dlState='busy' ─► updateDlBtn()
         └─► for each trail, one by one: downloadTrail(t, trailTileURLs(t), onProgress)
             ─► saveTiles: batched fetch(8); skip if TileStore.has(u); else fetch + TileStore.put
             │     (commits bytes on the PAGE; classifies ok / absent[404] / fail[net·503·5xx·quota])
             ─► fail===0 ? markSaved(slug, probes) + card 'done' : clearSaved(slug) + card 'idle'
             ─► updateDlProgress(base+done, grand) (combined NN% + --p fill)
             ─► dlState='idle' ─► await refreshCacheStatus() (verify manifest+probes per trail)
             ─► updateDlBtn() (green "✓ Maps saved" iff EVERY trail verified)
             ─► alert dlQuota (storage full) / dlPartial (any fail>0)

user reopens app mid-hike (iOS evicted the PWA; bare start_url OR a restored #/trail/<slug>)
   └─► load ─► bootRoute(): fresh session? ─► replaceState '#/trail/<slug>' (hash-independent)
                            + resumeOnOpen=true ─► routeFromHash() ─► openDetail(t)
         └─► after loadTrail: resumeSession(s)  (restore progress + green overlay;
                              elapsed clock counted through the gap; Back ─► list)

user "just checks" mid-hike (iOS kept the PWA resident — NO load event)
   └─► pageshow / visibilitychange→visible ─► onWake(): refresh #list-resume banner;
                re-surface resume offer on the trail; updateHUD(); refreshGpsAfterGap()
                (arm re-acquire + getCurrentPosition + restartWatch — revive a dead watch)
```
