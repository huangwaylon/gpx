# Ume-chan's Trails — Architecture

> Canonical architecture reference for the **Ume-chan's Trails** (梅ちゃんのトレイル)
> Progressive Web App.
> Every claim below is grounded in the source as of this writing; `file:line` references
> point at the exact code.

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

A single **"download all maps"** button in the list header pre-caches the map tiles for
**every** trail (across both tile sources) in one tap (§12).

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
while fully offline (see §4). This keeps the mental model tiny: open `index.html`, four
script tags load in order (`leaflet.js` → `i18n.js` → `trails.js` → `app.js`), and the app
boots on `window load`.

```
                          ┌───────────────────────────────────────────────┐
                          │                  index.html                    │
                          │     (app shell: #list + #detail sections)      │
                          └───────────────┬───────────────────────────────┘
                                          │ <script> tags, in order
        ┌──────────────────┬──────────────┼──────────────┬───────────────┐
        ▼                  ▼              ▼               ▼               ▼
 leaflet@1.9.4 (unpkg)  i18n.js       trails.js        app.js
   map engine + CSS    window.I18N  window.TRAILS[10] ALL app logic
                      (UI + JA text)                       │
        ┌───────────────────────────────────────────────────────────┼───────────────┐
        ▼                  ▼                ▼              ▼          ▼                ▼
   renderList()       openDetail()      initMap()     loadTrail()  GPS subsystem   downloadAll()
   (list screen)     (detail screen)   (Leaflet)     (GPX parse)  (watchPosition) (Cache API)
        │                  │                │              │                            │
        ▼                  ▼                ▼              ▼                            ▼
   #trail-list        #sheet + #map    USGS / GSI      drawTrack()                 caches.open(
   cards              bottom sheet     tiles  ───────►    drawProfile()                'wa-trails-
                                            ▲                                        tiles-v1')
                                            │                                            │
                                            └──────────────┬─────────────────────────────┘
                                                           ▼
                                                  ┌──────────────────┐
                                                  │     sw.js        │  cache-first fetch
                                                  │  APP_V  (shell)  │  ◄── HTML/CSS/JS/GPX/img
                                                  │  TILE_V (tiles)  │  ◄── USGS + GSI tiles
                                                  └──────────────────┘
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
  section headings, the download-button labels `dlAll`/`dlAllDone`, the attribution credits
  `attribTrail`/`attribUsgs`/`attribGsi`, marker labels, alerts, …) (`i18n.js:9-83`).
- **`fn.{en,ja}`** — functions producing locale-aware **dynamic** strings, called via `tf()`.
  Currently one entry, `planParty(n)` (EN `"<n> hikers"` / JA `"<n>人"`), used by the YAMAP
  plan card (`i18n.js:118-120`).
- **Enum tables** `diff` / `route` / `dogs` — map the English data tokens (`"Moderate"`,
  `"Out & back"`, `"Leashed"`, …) to their JA equivalents (`i18n.js:95-106`).
- **`months`** — English month abbreviation → JA (`"Apr"`→`"4月"`) for season strings
  (`i18n.js:107-110`).
- **`wpt`** — GPX waypoint name → JA (`"Bridge"`→`"橋"`, …) (`i18n.js:112-119`).
- **`trails.<slug>.ja`** — per-trail Japanese content (`name`, `area`, `summary`,
  `description`, `permit`, `tips`) that **overrides** the English base from `trails.js`
  (`i18n.js:122-279`). All 10 trails (including the 2 Japan trails) have a Japanese block.

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
- **`setLang(next)`** (`app.js:147`) — sets `lang`, persists it to `localStorage.lang`,
  re-runs `applyStaticI18n()`, **live-re-renders the list** (`renderList()`), and if a detail
  view is open re-renders it (`#detail-title`, `renderPeek()`, `renderSheetBody()`), calls
  **`redrawTrailLabels()`** to re-bind the Leaflet marker popups **without rebuilding the
  map**, and re-localizes the tracking FAB/HUD (`updateTrackBtn()`/`updateHUD()`) and re-draws
  the GPS profile cursor (`syncGpsCursor()`). It is wired to `#lang-toggle` in `bindGlobal()`
  (`app.js:240`).

---

## 2. File / module layout

Everything the browser loads is a flat set of static files. The table lists each **deployed**
artifact and its responsibility. (Source-only material is noted at the bottom.)

| Path | Type | Responsibility |
|---|---|---|
| `index.html` | HTML | **App shell.** Declares the `#list` and `#detail` screens, the `.head-actions` wrapper holding the global download button (`#dl-all`) and language toggle (`#lang-toggle`), PWA `<meta>` tags, manifest/icon links, `data-i18n`/`data-i18n-aria` hooks, and the four `<script>` tags. |
| `app.js` | JS | **All application logic** — routing, i18n helpers (§1a), list/detail rendering, Leaflet map, GPX parsing & geometry, elevation profile, GPS, bottom-sheet drag, the global tile-download, SW registration. Single `'use strict'` script, no exports. |
| `app.css` | CSS | **All styles** — design tokens (CSS custom properties), both screens, cards, the language-toggle button, the global download button (`.dl-all-btn`, incl. its `--p` progress gradient), bottom sheet, the GPS-dot pulse animation, Leaflet overrides, and the landscape media query. |
| `trails.js` | JS data | **Data model (English base).** Defines `window.TRAILS`, the array of 10 trail objects — 8 Washington + 2 Japan (see §3). |
| `i18n.js` | JS data | **i18n tables.** Defines `window.I18N` — UI strings, dynamic-string functions, enum/season/waypoint tables, and per-trail Japanese content (see §1a). Loads before `trails.js`/`app.js`. |
| `sw.js` | JS (SW) | **Service worker.** Precaches the shell + bundled trail assets on `install`; serves cache-first for tiles and shell on `fetch`; prunes old caches on `activate`. |
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
> defines `window.I18N`, then `trails.js` defines `window.TRAILS`, all **before** `app.js`
> runs.

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

- **`routeFromHash()`** (`app.js:176`) matches the hash against
  `^#\/trail\/([\w-]+)`. If it matches and a trail with that `slug` exists, it calls
  `openDetail(t)`; otherwise it falls back to `showList()`.
- It runs **on boot** (called at the end of the `load` handler, `app.js:171`) and **on every
  hash change** (`window.addEventListener('hashchange', routeFromHash)`, `app.js:174`).
- Each card **is an `<a href="#/trail/<slug>">` anchor** (`app.js:208`), so tapping it drives
  the hash directly — there is no JS click handler that assigns the hash. Only the back button
  sets `location.hash = ''` (`app.js:241`). Either way the single `hashchange` listener
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
each filter/sort change, and after a **language switch** (from `setLang()`). It no longer
renders any per-card offline badge — offline state is now surfaced by the single global
download button (§12), not per card.

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

### Offline state on the global download button (`dlState`)

Offline status is no longer shown per card. It lives entirely on the single global
**`#dl-all`** button in the header, driven by the module-level **`dlState`** string
(`'idle' | 'busy' | 'done'`, `app.js:84`). **`updateDlBtn()`** (`app.js:954`) reflects it:
in `idle` the label is `t('dlAll')` ("⬇ Save maps" / "⬇ 地図を保存"); in `busy` the label is a
live `"NN%"` percentage with a CSS gradient fill driven by a `--p` custom property
(`.dl-all-btn.busy`, `app.css:89-92`); in `done` the label is `t('dlAllDone')` ("✓ Maps saved")
and the button turns green (`.dl-all-btn.done`, `app.css:93`). On boot,
`refreshCacheStatus()` (§12) probes one sample tile per trail and sets `dlState` to `'done'`
only if **every** trail's sample is already cached, else `'idle'`. The full download/progress
machinery is documented in §12.

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

There is **no longer a download button in the sheet** — downloading is a single global action
in the header (§12).

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
4. Add a **zoom control at `topright`** (`L.control.zoom({ position:'topright' })`,
   `app.js:420`).
5. Add the **tile layer for that source** (below).
6. `map.on('dragstart', …)` disables GPS follow mode and clears the FAB's `.on` highlight when
   the user pans (`app.js:422`) — see §10.
7. Nudge the zoom control down so it clears the floating header:
   `marginTop = calc(54px + env(safe-area-inset-top,0px))` (`app.js:423`).

### Per-trail tile sources — `TILE_SOURCES` / `trailSource()`

The base map is **per trail**. The single old `TILE_URL` constant is gone; instead `app.js`
defines a **`TILE_SOURCES`** table (`app.js:66-75`) with two entries, and a tiny resolver
**`trailSource(trail) = TILE_SOURCES[trail.tiles] || TILE_SOURCES.usgs`** (`app.js:76`) — so a
trail's optional `tiles` field (§3) picks the basemap (absent ⇒ `usgs`, `"gsi"` ⇒ GSI).
`initMap()` then builds the layer from the resolved source's fields:
`L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:8, attribution:src.leaflet,
crossOrigin:true })` (`app.js:421`). `crossOrigin:true` is what lets the offline download read
the tiles back out of the Cache API, and the **attribution is now dynamic per source**.

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

### Cache-first behavior

Tiles are **not** loaded by the page directly from the network when cached. The service worker
intercepts any tile request — i.e. any URL whose host is `nationalmap.gov` **or**
`cyberjapandata.gsi.go.jp` — and serves **cache-first** from the `TILE_V` cache, only hitting
the network on a miss and storing the response (§12, §15; `sw.js:50-57`). So a previously-visited
or pre-downloaded trail renders its map from cache with no connectivity.

---

## 8. GPX & geometry subsystem

### `loadTrail()` — fetch & parse

`loadTrail(t)` (`app.js:426`) turns a GPX file into in-memory geometry:

1. Reset `trackPts`, `trackWpts`, `totalDist`, and the tracking state (`renderPts`,
   `walkedDist`, `progIdx`) (`app.js:427-428`).
2. **Fetch** the GPX text: `await (await fetch(t.gpx)).text()`, wrapped in try/catch that logs
   and bails on failure (`app.js:430-431`). (When offline, the SW serves the GPX from the
   precached `APP_V` shell — see §15.)
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

`drawProfile()` (`app.js:552`) renders the elevation chart into `#elev-svg`. It bails early
if the SVG is missing or there are `< 2` track points.

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

A single floating action button, `#btn-gps` (`.map-fab`, `index.html:73`), drives live
location; its click is bound to `toggleGPS` (`app.js:242`).

### Toggle / start / stop

- **`toggleGPS()`** (`app.js:690`) is tri-state:
  - **Not watching** → `startGPS()`.
  - **Watching but not following** (and we have a `curPos`) → re-enable follow, re-highlight the
    FAB, and recenter the map on the user at `max(currentZoom, 15)`.
  - **Watching and following** → `stopGPS()`.
- **`startGPS()`** (`app.js:698`): if `navigator.geolocation` is missing, `alert(t('alertNoGeo'))`
  and bail; otherwise request a wake lock (below), set `gpsFollow = true`, highlight the FAB
  (`.on`), and start `navigator.geolocation.watchPosition(onPos, onPosErr,
  {enableHighAccuracy:true, maximumAge:4000, timeout:30000})`, storing the watch id in `gpsWatch`.
- **`stopGPS()`** (`app.js:704`): `clearWatch`, release the wake lock, reset
  `gpsFollow`/`curPos`, remove the GPS marker and accuracy circle, drop the FAB highlight, and
  clear the profile position layer (`#epos`).

### Position updates — `onPos()`

`onPos(pos)` (`app.js:711`):

1. Read `latitude`/`longitude`/`accuracy`; store `curPos = {lat,lon}`.
2. **Pulsing dot + accuracy circle.** On the first fix it creates:
   - `gpsMk` — an `L.marker` whose icon is a `<div class="gps-dot">` (the blue dot with the CSS
     `gpspulse` keyframe ring, `app.css:361-363`), at `zIndexOffset:1000` so it sits above the
     track.
   - `gpsAcc` — an `L.circle` of `radius:accuracy`, faint blue fill (`C.blue`), used as the
     accuracy halo.
   On subsequent fixes it just repositions both and updates the circle's radius (`app.js:714-717`).
3. **Follow mode.** If `gpsFollow`, recenter the map to the new position at `max(currentZoom,15)`
   with animation (`app.js:718`).
4. **Feed live tracking.** If a tracking session is active (`tracking && !paused`), pass the fix
   to `updateProgress` (§10a) (`app.js:719`).
5. **Profile cursor.** Draw the blue GPS cursor with `drawProfileCursor(trackPts[i], false)`
   (§9), where `i` **reuses the tracking snap index** (`progIdx`) when a session is active (so it
   can't jump to the wrong overlapping leg of an out-and-back), else `nearestIdx(lat,lon).idx`
   (`app.js:720-725`).

`onPosErr(err)` (`app.js:727`) specifically handles permission-denied (`code === 1`) with an
instructional `alert(t('alertDenied'))` (pointing to iOS Settings → Privacy → Location Services →
Safari) and stops GPS.

### How dragging disables follow

`initMap()` registers `map.on('dragstart', …)` which sets `gpsFollow = false` and removes the
FAB's `.on` class (`app.js:422`). So as soon as the user pans the map, the app stops yanking the
view back; tapping the FAB again re-engages follow (the second branch of `toggleGPS`).

### Screen Wake Lock

- **`reqWake()`** (`app.js:729`) requests `navigator.wakeLock.request('screen')` (guarded by a
  feature check, errors swallowed) so the screen stays on while navigating.
- **`relWake()`** (`app.js:730`) releases it and nulls `wakeLock`.
- **Re-acquire on visibility.** Wake locks are dropped when a tab is backgrounded, so a
  `visibilitychange` listener (`app.js:731`) re-requests the lock when the page becomes visible
  again **and** GPS is still active **and** no lock is currently held.

---

## 10a. Live trail-progress tracking

A second floating action button, `#btn-track` (`.map-fab.track`, `index.html:76`), starts a
**live trail-progress** session: each GPS fix is snapped to the trail, the walked portion fills
green over the red base, and a `#track-hud` banner (`index.html:79`) shows percent + elapsed time.
Its click is bound to `toggleTrack` in `bindGlobal()` (`app.js:257`); the HUD's ✕ button
(`#th-close`) is bound to `endTracking` (`app.js:258`), which forgets any saved session (below)
before stopping.

### Start / pause / stop

- **`toggleTrack()`** (`app.js:761`): if not tracking, `startTracking()`; otherwise it toggles
  **pause/resume**, banking elapsed time on pause (`trackElapsedMs += now - trackStartTs`) and
  resuming the clock from now (reopening GPS if it had been closed). Persists the session either way.
- **`startTracking()`** (`app.js:769`): resets progress (`walkedDist=0`, `progIdx=-1`,
  `reacqMiss=0`), removes any old `walkedLayer`, shows the HUD, starts GPS if it isn't already
  running (tracking needs live fixes), starts a 1 s `hudTimer` so the elapsed clock ticks even
  without new fixes, and writes the first `persistSession()` snapshot.
- **`stopTracking()`** (`app.js:784`): resets the **in-memory** session — hides the HUD, removes
  the green overlay, zeroes progress/elapsed — but **leaves GPS as-is** (the location dot can stay
  on) **and leaves the saved session in `localStorage` intact**, so reopening the trail can still
  offer a resume. It's called by `showList()`/`openDetail()` to reset per-trail.
- **`endTracking()`** (`app.js:793`) = `clearSession()` + `stopTracking()`: the **explicit** end
  (HUD ✕), which also forgets the saved session.
- **`updateTrackBtn()`** (`app.js:794`) toggles the `.tracking` class and swaps the PLAY/PAUSE
  icon + aria-label.

### Snapping a fix to the trail — `updateProgress()`

`updateProgress(lat,lon,accuracy)` (`app.js:816`), fed from `onPos` (§10), snaps each fix to a
track vertex and advances the walked distance:

- **Off-trail gate.** `offTrailGate(acc)` (`app.js:778`) = `max(25, min(60, 2.5*acc))` m — fixes
  whose nearest vertex is farther than the gate are rejected (progress holds), scaled to GPS
  accuracy (looser under tree cover).
- **First fix** uses `acquireIdx()` (`app.js:782`): among in-gate vertices it takes the one with
  the **smallest distance-along**, so an out-and-back's trailhead/return overlap can't be mistaken
  for near-complete progress.
- **Subsequent fixes** use `nearestIdx()` over a **forward window** only —
  `[progIdx - SNAP_BACK_M, progIdx + SNAP_FWD_M]` (constants `SNAP_BACK_M=80`, `SNAP_FWD_M=250` m,
  `app.js:58-59`) — so the return leg of an out-and-back (which overlaps the outbound) can't match
  the wrong leg.
- **Stale-window re-acquire.** A frozen window can never reach a far-off fix — pocket the phone at
  the trailhead, pull it out at the summit, and every fix lands kilometres past the window and is
  rejected, stranding progress near the last snap. After **`REACQUIRE_AFTER` = 3** (`app.js:64`)
  consecutive out-of-window rejections (counted in `reacqMiss`), `updateProgress` falls back to
  `acquireIdx()` for that fix, re-snapping from scratch so progress jumps to where you actually are.
  Since `walkedDist` is monotonic and `acquireIdx` is smallest-distance-along, this only ever fills
  *forward* on a curated route — it never un-colors.
- **Monotonic advance.** `walkedDist` only ever grows; it recolors via `recolorProgress()`
  (`app.js:813`) — a green polyline (`C.green`) over the red base, built from `renderPts` with
  `.d ≤ walkedDist` plus an exact split vertex from `pointAtDistance(D)` — only when the
  high-water mark actually advances.

### The HUD — `updateHUD()`

`updateHUD()` (`app.js:829`) fills the `#track-hud` percent (`.th-pct`), progress bar (`.th-fill`),
and elapsed time (`.th-num`, from `fmtElapsed(elapsedMs())`). **Out-and-back progress** is measured
against the **far end** (`turnDist`, §8) so reaching the turnaround reads 100%; loops and
point-to-point measure against the full `totalDist`. At 100% it shows a localized message
(`trackTurnaround` for out-and-back, else `trackComplete`).

### Surviving a reload — session persistence & resume

iOS suspends and may **evict** a backgrounded PWA, so a long screen-off stretch (the phone
pocketed on a climb) can reload the page mid-hike and lose the in-memory session. The session is
therefore mirrored to `localStorage` under **`SESSION_KEY`** (`app.js:114`):

- **`persistSession()`** (`app.js:876`) writes `{slug, walkedDist, progIdx, trackStartTs,
  trackElapsedMs, paused, savedAt}` on **every accepted fix** (end of `updateProgress`), on
  pause/resume, on `startTracking`, and on **`visibilitychange → hidden`** (the last capturing
  state just before iOS suspends us). `trackStartTs` is an **absolute** `Date.now()`, so a restored
  running clock keeps counting *through* the gap.
- **`maybeOfferResume(trail)`** (`app.js:893`), called at the end of `openDetail()` after the track
  loads, reads the saved record and — if it's **this** trail's, **fresh** (`savedAt` within
  `SESSION_MAX_AGE_MS` = 18 h, `app.js:115`), and **non-trivial** (`savedElapsedMs ≥ 60 s`) — shows
  the **`#track-resume`** prompt (a sibling banner of the HUD in `index.html`), rendered by
  `renderResumePrompt()` (`app.js:902`) with the saved percent + elapsed and re-localized live by
  `setLang()`.
- **`resumeSession(s)`** (`app.js:915`) restores `walkedDist`/`progIdx`/`paused`, redraws the green
  overlay, reopens GPS, restarts the HUD timer, and re-stamps the session. Bound to the prompt's
  **Resume**; **Dismiss** calls `clearSession()`. Because the windowed snap resumes from the
  restored `progIdx`, the **stale-window re-acquire** (above) snaps you to your real position within
  a few fixes.

**Faster checks (screen-on refresh).** The common case for a "check the screen" hiker is a *short*
lock where the page survives (no reload → no resume prompt). For that, the `visibilitychange`
handler does more than re-acquire the wake lock: when the page returns to visible and GPS was live,
it **arms an immediate re-acquire** (`reacqMiss = REACQUIRE_AFTER`) and **kicks a fresh fix** via
`getCurrentPosition({maximumAge:0})`, so the dot and progress refresh within ~a second of looking
rather than after several windowed misses — and regardless of whether iOS resumed the frozen watch.
A `#gps-locating` "Locating…" pill (`setLocating()`) covers the brief GPS cold-start, and a
`#list-resume` banner (`updateListResume()`, bound in `bindGlobal`) surfaces a fresh saved session on
the **list** screen after a full relaunch (where `start_url: "./"` drops the trail hash) as a one-tap
way back in — `resumeOnOpen` makes that tap resume directly instead of re-showing the prompt.

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

A single global button **pre-caches the map tiles for *all* trails** (across both tile
sources) so every map works with no connectivity. It is driven from one button in the list
header — **`#dl-all`** (`.dl-all-btn`, `index.html:38`) — bound to `downloadAll` in
`bindGlobal()` (`app.js:245`). There is **no per-trail download button and no download modal**
anymore; iOS has no background fetch, so this is a single foreground, user-initiated action
with inline progress on the button itself.

### Button state — `dlState` / `updateDlBtn()` / `updateDlProgress()`

The button's appearance is driven by the module-level **`dlState`** (`'idle' | 'busy' |
'done'`, `app.js:84`):

- **`updateDlBtn()`** (`app.js:954`) toggles the `.busy` / `.done` classes and sets the
  static label — `t('dlAll')` in `idle`, `t('dlAllDone')` in `done`. `applyStaticI18n()` calls
  it so the label tracks the language (§1a).
- **`updateDlProgress(done,total)`** (`app.js:963`) computes a percentage, writes it to the
  button's **`--p` CSS custom property** (which drives the gradient fill of `.dl-all-btn.busy`,
  `app.css:89-92`), and — while `busy` — sets the button text to the live `"NN%"`.

### Web Mercator tile math

The download converts a lat/lon box to **XYZ tile ranges** at each zoom:

- **`ll2t(lat, lon, z)`** (`app.js:899`) is the standard slippy-map projection:
  `n = 2^z`, `x = floor(n*(lon+180)/360)`, and
  `y = floor(n*(1 - ln(tan(φ) + sec(φ))/π)/2)` with `φ = lat·π/180`. Returns `{x, y}`.
- **`tRange(b, z)`** (`app.js:897`) projects the SW and NE corners and returns the inclusive
  `{x0,x1,y0,y1}` tile range (min/max-ed so corner order doesn't matter).
- **`DL_MIN_Z = 10`** (`app.js`) — the overview floor for downloads. Each trail caches from
  z10 up to **its source's `maxZoom`**: **z10–16** for USGS, **z10–18** for GSI. The upper bound
  is the source's real native ceiling, so no 404-ing tiles are requested.

### Per-trail bounding box — `gpxBox()`

**`gpxBox(trail)`** (`app.js`) is **async**: it fetches the trail's GPX (served from the
SW precache, so it works offline too), parses it, and computes the min/max lat/lon over all
`<trkpt>` elements. If parsing yields no track points it **falls back** to `trail.center ±
0.02°`. It returns the **raw** box; the surrounding context buffer is added later, per zoom,
by `tileURLsFor()` via **`padFor(z)`** (`app.js`) — **0.05°** at z≤12, **0.03°** at z13–14,
**0.015°** at z15–16, **0.008°** at z17, **0.004°** at z18. Padding is heaviest at overview
zooms (where you pan to see surrounding terrain) and progressively tighter toward max detail,
since each extra zoom quadruples the tile count and you rarely pan far while reading z17–18
detail right at your position. This replaces
the old `trailBox()`/`countTiles()`/`tileURLs()` trio, which depended on the *currently open*
trail's live `trackPts`; `gpxBox()` works for any trail without it being open.

### Expanding a box to URLs — `tileURLsFor()`

**`tileURLsFor(box, src)`** (`app.js`) expands a box into every concrete tile URL
across **z10 up to `src.maxZoom`**, **expanding the box by `padFor(z)` for each zoom**, then
substituting tokens **by name** into that source's template
(`src.url.replace('{z}',z).replace('{y}',y).replace('{x}',x)`). Because it substitutes by name,
the same routine builds both the USGS `{z}/{y}/{x}` and the GSI `{z}/{x}/{y}` URLs correctly
(§7), each to its own zoom ceiling.

### Batched fetch into the Cache API — `downloadAll()`

**`downloadAll()`** (`app.js:932`) is the whole flow:

1. Bail if already `busy` or `caches` is unavailable; set `dlState='busy'`, `updateDlBtn()`,
   and seed the progress bar (`updateDlProgress(0,1)`).
2. **Gather every tile URL across all trails.** For each `trail` of `TRAILS`, `await
   gpxBox(trail)` and push `tileURLsFor(box, trailSource(trail))` — i.e. each trail
   contributes tiles from **its own** source (USGS to z16 or GSI to z18). The combined list is then
   **deduped** with a `Set` (`app.js:941`), so tiles shared by overlapping trails are fetched
   once.
3. Open the **`TILE_CACHE`** cache (`'wa-trails-tiles-v1'`, `app.js:7` / `app.js:943`) and
   iterate the URLs in **batches of 8** (`BATCH = 8`). For each URL it skips ones already cached
   (`cache.match`), otherwise `fetch(u, {mode:'cors'})` and `cache.put` it if the response is
   `ok` **or** `opaque`. Each settled request bumps `done` and calls `updateDlProgress(done,
   total)`. `Promise.allSettled` ensures one failed tile doesn't abort the batch.
4. On completion set `dlState='done'` and `updateDlBtn()` (green "✓ Maps saved" label).

> Because the page writes into the **same cache name** (`wa-trails-tiles-v1`) the service worker
> reads from, every pre-downloaded trail — US or Japan — is served cache-first by the SW with
> zero further network use (see §15).

### Status sampling — `refreshCacheStatus()`

**`refreshCacheStatus()`** (`app.js:972`) decides the button's startup state. It opens
`TILE_CACHE` and, for **each** trail, computes the **z14 center tile** (`ll2t(center, 14)`),
builds that tile's URL **from that trail's own source** (so the GSI trails are probed against
the GSI URL), and checks `cache.match`. It sets `dlState='done'` **only if every trail's sample
tile is present**, otherwise `'idle'`. It runs once on boot (awaited, then `updateDlBtn()`
reflects the result), and skips while a download is `busy`. (It samples a single representative
tile per trail rather than verifying the whole set — so a partially-downloaded set can still
read as `done`; see the open caveats in `CLAUDE.md`.)

---

## 13. State management

All runtime state lives as **module-level `let`/`const` bindings** at the top of `app.js`
(plus a couple declared inline). There is no store, no reactive system — functions read/write
these directly and re-render by rewriting `innerHTML`.

| Variable | Decl | Holds |
|---|---|---|
| `map` | `app.js:79` | The current Leaflet map instance (or `null`). |
| `curTrail` | `app.js:79` | The trail object currently open in detail (or `null`). |
| `trackLayer` | `app.js:79` | The red track polyline `L.polyline` (used for `fitBounds`). |
| `trackPts` | `app.js:80` | Parsed track points: `{lat, lon, ele, d, se}` with cumulative distance `d` and smoothed elevation `se`. |
| `trackWpts` | `app.js:80` | Parsed waypoints: `{lat, lon, name, d, _marker}` with snapped along-track distance `d` and the retained Leaflet marker. |
| `totalDist` | `app.js:81` | Total track length in meters (for profile x-scaling). |
| `gpsWatch` | `app.js:81` | `watchPosition` id while GPS is active (`null` when off). |
| `gpsMk` | `app.js:81` | The pulsing GPS-position marker (or `null`). |
| `gpsAcc` | `app.js:81` | The GPS accuracy circle (or `null`). |
| `gpsFollow` | `app.js:81` | Whether the map auto-recenters on the user. |
| `curPos` | `app.js:82` | Last known `{lat, lon}` fix (or `null`). |
| `wakeLock` | `app.js:82` | The active Screen Wake Lock sentinel (or `null`). |
| `sheetState` | `app.js:83` | Bottom-sheet state: `'peek' | 'full'`. |
| `dlState` | `app.js:84` | Global offline-maps download state: `'idle' | 'busy' | 'done'` — drives the `#dl-all` button (§12). |
| `eleLo` / `eleHi` / `eleRange` | `app.js:87` | Cached smoothed-elevation bounds for the profile Y scale (set in `loadTrail`, §8). |
| `renderPts` | `app.js:90` | Downsampled track points (with cumulative `.d`) for the polyline, reused by the green walked overlay (§10a). |
| `turnIdx` / `turnDist` / `isOutAndBack` | `app.js:93` | Far-end (turnaround) index/distance and out-and-back flag, used by live-tracking progress (§8, §10a). |
| scrub state | `app.js:96` | `scrubbing`, `scrubMk`, `scrubRAF`, `scrubX`, `scrubRect`, `scrubCardRect` — elevation-scrub gesture state (§9). |
| tracking state | `app.js:104-115` | `tracking`/`paused`, `trackStartTs`/`trackElapsedMs`/`hudTimer`, `walkedDist`/`progIdx`, `walkedLayer`, `reacqMiss` (consecutive off-window fixes → re-acquire), `pendingResume` (saved session offered for resume), plus `SESSION_KEY`/`SESSION_MAX_AGE_MS` — the live trail-progress session, mirrored to `localStorage` so it survives a reload (§10a). |
| `lang` | `app.js:123` | Active language: `'ja'` (default) or `'en'`, seeded from `localStorage.lang` (§1a). |
| `listFilter` | `app.js:188` | Active difficulty filter (`'all'` or a `diffKey`). |
| `listSort` | `app.js:188` | Active sort (`'dist'`, `'gain'`, or `null`). |
| `peekH` | `app.js:849` | Cached bottom-sheet peek height in px (computed by `computePeekH()`, §11). |
| `rzT` | `app.js:997` | Debounce timer handle for the resize handler. |

Two trivial DOM helpers are also defined globally: **`$`** (`querySelector`) and **`$$`**
(`querySelectorAll` → array) (`app.js:104-105`). The i18n helpers `t` / `tf` / `loc` / `trDiff` /
`trRoute` / `trDogs` / `trWpt` / `trSeason` and the unit formatters `fmtDist` / `fmtGain` /
`fmtTime` / `fmtElevRange` are documented in §1a.

Module-level **constants** (`app.js`): `TILE_CACHE` (`'wa-trails-tiles-v1'`), `DL_MIN_Z` (10),
the zoom-aware padding helper `padFor(z)` (0.05° / 0.03° / 0.015° / 0.008° / 0.004°), `FT`
(3.28084), `MI_PER_KM` (1.609344), the profile-geometry constants `PROF_H` (96) / `PROF_PAD_B`
(14) / `PROF_PAD_T` (12), the `C` colour palette (track/marker hex, mirroring app.css), the
live-tracking snap window `SNAP_FWD_M` (250) / `SNAP_BACK_M` (80), the inline-SVG icon set
(`ICON_PATHS` + `ICON_PLAY`/`ICON_PAUSE`), the difficulty `DIFF` table, and the per-trail
basemap table **`TILE_SOURCES`** with its resolver **`trailSource()`** (§7) — these replace the
old single `TILE_URL` constant.

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

The app has **two distinct Service-Worker caches**, declared at the top of `sw.js`:

| Cache name | Constant | Contents | Written by |
|---|---|---|---|
| `wa-trails-app-v11` | `APP_V` (`sw.js:1`) | **App shell + bundled assets** — HTML/CSS/JS (incl. `i18n.js`), manifest, icon, Leaflet CSS+JS, and **all 10 GPX files + 10 hero images**. | SW `install` (`addAll(SHELL)` + best-effort `TRAIL_ASSETS`); SW `fetch` fills same-origin/unpkg misses. |
| `wa-trails-tiles-v1` | `TILE_V` (`sw.js:2`) | **Map tiles** — both **USGS** topo (US trails) and **GSI 地理院タイル** (Japan trails), keyed by full URL. | SW `fetch` (cache-first fill on miss) **and** the page's `downloadAll()` pre-cache. |

> The cache **names** retain the historic `wa-trails-` prefix (an internal identifier — it is
> not user-facing and is intentionally left unchanged so a deploy doesn't needlessly evict the
> existing tile cache). The product is "Ume-chan's Trails"; only this internal cache key keeps
> the old prefix.

### Shell precache (`install`)

On `install` (`sw.js:28-36`), the SW opens `APP_V`, **`addAll(SHELL)`** (which must all succeed —
`SHELL` lists `./`, `index.html`, `app.css`, `app.js`, `trails.js`, **`i18n.js`**,
`manifest.json`, `icon-180.png`, `icon-192.png`, `icon-512.png`, and the two Leaflet CDN URLs, `sw.js:4-9`), then **best-effort**
caches `TRAIL_ASSETS` (the **10 GPX + 10 webp** — 8 Washington + 2 Japan, `sw.js:12-24`) with
`Promise.allSettled` so a single failed asset doesn't break install. It calls `skipWaiting()`.
Bundling the GPX and images means a trail's track and photo are available with **zero network**,
even one the user has never opened.

### Activation / cleanup (`activate`)

On `activate` (`sw.js:38-44`), the SW deletes any cache whose name is **neither** `APP_V`
**nor** `TILE_V`, then `clients.claim()`. This is the version-migration mechanism: bumping
`APP_V` (now `…-v11`) on a deploy evicts the previous shell cache automatically,
while the tile cache (`TILE_V`) is deliberately preserved across shell upgrades so users don't
lose downloaded maps.

### Fetch strategy (`fetch`)

`fetch` (`sw.js:46-69`) has two branches:

1. **Tiles (cache-first).** Any URL whose host is `nationalmap.gov` **or**
   `cyberjapandata.gsi.go.jp` is served from `TILE_V`: return the cached hit, else fetch, store
   the clone if `ok` **or** `opaque`, and on network failure return an empty `503`
   (`sw.js:50-57`). This single branch covers both basemap providers, and is what makes
   downloaded tiles render offline.
2. **Shell + bundled assets (cache-first, fill on miss).** Everything else tries
   `caches.match` first; on a miss it fetches, and if `ok` **and** the request is same-origin or
   an `unpkg.com` host, stores the clone in `APP_V`. On a network failure it falls back to the
   cached `./index.html` for **navigations** (so the app still launches offline), or an empty
   `503` otherwise (`sw.js:61-68`).

### How the page-level download ties in

The crucial coupling: `app.js`'s `TILE_CACHE` (`app.js:7`) and `sw.js`'s `TILE_V` (`sw.js:2`)
are the **same string**, `'wa-trails-tiles-v1'`. So when `downloadAll()` writes tiles into the
cache (§12), the service worker's tile branch later finds and serves them — the page is the
**writer**, the SW is the **reader**, sharing one named cache. The `activate` cleanup explicitly
spares `TILE_V`, so those downloads persist across app updates.

---

## Appendix — runtime sequence (open a trail, go offline)

```
boot
   └─► load ─► applyStaticI18n() (fill [data-i18n], <title>, <html lang>; updateDlBtn())
            ─► renderList() ─► bindGlobal()
            ─► await refreshCacheStatus() ─► updateDlBtn()  (#dl-all = idle | done)
            ─► routeFromHash() ─► register sw.js

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
               │                              └─ TILE_V cache-first
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
   └─► downloadAll()  ─► dlState='busy' ─► updateDlBtn()
         └─► for each trail: gpxBox(t) ─► tileURLsFor(box, trailSource(t))
             ─► dedupe (Set) over all trails/both sources, z10..src.maxZoom (USGS 16, GSI 18)
             ─► batched fetch(8) ─► caches.open('wa-trails-tiles-v1').put()
             ─► updateDlProgress(done,total) (NN% + --p fill)
             ─► dlState='done' ─► updateDlBtn() (green "✓ Maps saved")
```
