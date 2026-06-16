# Ume-chan's Trails — Architecture

> Canonical architecture reference for the **Ume-chan's Trails** (梅ちゃんのトレイル)
> Progressive Web App.
> Every claim below is grounded in the source as of this writing; `file:line` references
> point at the exact code.

---

## 1. High-level overview

**Ume-chan's Trails** (Japanese: 梅ちゃんのトレイル) is an **offline-capable hiking PWA** built
for the iPhone (Safari / "Add to Home Screen"). It presents **12 trails — 8 in Washington
State (USA) and 4 in Japan** — and is **bilingual** — **Japanese by default**, with a
one-tap toggle to English (see §1a). A user browses a scrollable list of trail cards, taps
one, and lands on a full-screen trail-detail view with:

- a **topographic** base map (Leaflet) — **USGS** topo for the US trails, **GSI 地理院タイル**
  (Geospatial Information Authority of Japan) for the Japan trails, chosen per trail (§7),
- the trail's **GPX track** overlaid as a red polyline with a black halo,
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
| Mapping | **Leaflet 1.9.4** loaded from the **unpkg CDN** (`index.html:14`, `index.html:75`) |
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
   map engine + CSS    window.I18N  window.TRAILS[12] ALL app logic
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

`i18n.js` loads **before** `trails.js` and `app.js` (`index.html:76`) and assigns a single
global, `window.I18N` (`i18n.js:6`), holding all UI strings and the Japanese overrides:

- **`ui.{en,ja}`** — static UI strings keyed by name (`appName`, `subtitle`, filter labels,
  section headings, the download-button labels `dlAll`/`dlAllDone`, the attribution credits
  `attribTrail`/`attribUsgs`/`attribGsi`, marker labels, alerts, …) (`i18n.js:9-83`).
- **`fn.{en,ja}`** — reserved for functions producing locale-aware **dynamic** strings, called
  via `tf()`. **Both are currently empty `{}`** (`i18n.js:89-92`): the offline-download UI now
  shows a bare percentage on the global button, so no dynamic-string entries are needed today.
- **Enum tables** `diff` / `route` / `dogs` — map the English data tokens (`"Moderate"`,
  `"Out & back"`, `"Leashed"`, …) to their JA equivalents (`i18n.js:95-106`).
- **`months`** — English month abbreviation → JA (`"Apr"`→`"4月"`) for season strings
  (`i18n.js:107-110`).
- **`wpt`** — GPX waypoint name → JA (`"Bridge"`→`"橋"`, …) (`i18n.js:112-119`).
- **`trails.<slug>.ja`** — per-trail Japanese content (`name`, `area`, `summary`,
  `description`, `permit`, `tips`) that **overrides** the English base from `trails.js`
  (`i18n.js:122-279`). All 12 trails (including the 4 Japan trails) have a Japanese block.

`trails.js` remains the **English base**; the Japanese for each trail lives in
`I18N.trails[slug].ja` and is merged over the base at render time (see `loc()` below).

### Static markup hooks (`index.html`)

The document is now **`<html lang="ja">`** (`index.html:2`). Static text nodes carry
**`data-i18n`** (textContent) or **`data-i18n-aria`** (aria-label) attributes naming a `ui`
key, e.g. the `<h1 data-i18n="appName">`, the filter chips, and the back button
(`data-i18n-aria="back"`). The list header's top row is a **`.head-row`** containing the
`<h1>` and a **`.head-actions`** wrapper that holds the global **"download all maps" button
`#dl-all`** (`data-i18n-aria="dlAllAria"`) and the **language toggle button `#lang-toggle`**
(`index.html:23-29`).

### The i18n helpers (`app.js`)

A module-level **`lang`** holds the active language: it reads `localStorage.lang` and
defaults to **`'ja'`** (`app.js:43-44`). The helpers:

- **`t(key)`** (`app.js:46`) — look up a **static** `ui` string for `lang`, falling back to
  English then to the raw key.
- **`tf(key)`** (`app.js:47`) — look up a **dynamic-string function** from `fn` (then called
  with arguments). `fn` is currently empty for both languages (§1a above), so `tf` is defined
  but unused.
- **`loc(trail)`** (`app.js:63-69`) — when `lang==='ja'`, returns `{ ...trail,
  ...I18N.trails[slug].ja }` (Japanese fields override the English base); otherwise returns
  the trail unchanged. Render code reads localized fields off `loc(trail)` and
  language-neutral fields (slug, stats, paths) off the raw trail. (It is named `loc`, **not**
  `L`, to avoid shadowing Leaflet's global `L`.)
- **`trDiff` / `trRoute` / `trDogs`** (`app.js:50-52`) — translate the enum tokens via the
  `diff`/`route`/`dogs` tables (used for display only; `diffClass`/`diffKey` still key off
  the raw English token).
- **`trWpt(name)`** (`app.js:53`) — translate a waypoint name in JA via the `wpt` table.
- **`trSeason(s)`** (`app.js:56-60`) — in JA, rewrite `"Apr – Nov"` → `"4月～11月"` via the
  `months` table and a dash→`～` swap.
- **Unit formatters** — `fmtDist(mi)` / `fmtGain(ft)` (`app.js:128-129`), `fmtTime(s)`
  (`app.js:267-271`), and `fmtElevRange(loM,hiM)` (`app.js:408-411`) emit **km / m / 時間・分**
  in JA and **mi / ft** in EN, converting from the stored imperial values on the fly.

### Applying & switching language

- **`applyStaticI18n()`** (`app.js:72-78`) sets `document.documentElement.lang`, fills every
  `[data-i18n]` / `[data-i18n-aria]` node, sets `document.title` to `t('appName')`, and calls
  **`updateDlBtn()`** so the global download button's label tracks the language (§12). It runs
  on boot (`app.js:97`) and again on every language switch.
- **`setLang(next)`** (`app.js:80-91`) — sets `lang`, persists it to `localStorage.lang`,
  re-runs `applyStaticI18n()`, **live-re-renders the list** (`renderList()`), and if a detail
  view is open re-renders it (`#detail-title`, `renderPeek()`, `renderSheetBody()`) and calls
  **`redrawTrailLabels()`** to re-bind the Leaflet marker popups **without rebuilding the
  map**. It is wired to `#lang-toggle` in `bindGlobal()` (`app.js:177`).

---

## 2. File / module layout

Everything the browser loads is a flat set of static files. The table lists each **deployed**
artifact and its responsibility. (Source-only material is noted at the bottom.)

| Path | Type | Responsibility |
|---|---|---|
| `index.html` | HTML | **App shell.** Declares the `#list` and `#detail` screens, the `.head-actions` wrapper holding the global download button (`#dl-all`) and language toggle (`#lang-toggle`), PWA `<meta>` tags, manifest/icon links, `data-i18n`/`data-i18n-aria` hooks, and the four `<script>` tags. |
| `app.js` | JS | **All application logic** — routing, i18n helpers (§1a), list/detail rendering, Leaflet map, GPX parsing & geometry, elevation profile, GPS, bottom-sheet drag, the global tile-download, SW registration. Single `'use strict'` script, no exports. |
| `app.css` | CSS | **All styles** — design tokens (CSS custom properties), both screens, cards, the language-toggle button, the global download button (`.dl-all-btn`, incl. its `--p` progress gradient), bottom sheet, the GPS-dot pulse animation, Leaflet overrides, and the landscape media query. |
| `trails.js` | JS data | **Data model (English base).** Defines `window.TRAILS`, the array of 12 trail objects — 8 Washington + 4 Japan (see §3). |
| `i18n.js` | JS data | **i18n tables.** Defines `window.I18N` — UI strings, dynamic-string functions, enum/season/waypoint tables, and per-trail Japanese content (see §1a). Loads before `trails.js`/`app.js`. |
| `sw.js` | JS (SW) | **Service worker.** Precaches the shell + bundled trail assets on `install`; serves cache-first for tiles and shell on `fetch`; prunes old caches on `activate`. |
| `manifest.json` | JSON | **Web App Manifest** — name (`梅ちゃんのトレイル`), `start_url`/`scope` (`./`), `display:standalone`, theme/background colors, the SVG icon. |
| `icon.svg` | SVG | **App icon** — a stylized mountain + red GPX line + blue GPS dot, declared `"purpose": "any maskable"`. Also used as the `apple-touch-icon`. |
| `.nojekyll` | marker | Empty file that disables GitHub Pages' Jekyll processing so files (and any leading-underscore paths) are served verbatim. |
| `gpx/` | dir | **12 GPX tracks**, one per trail (e.g. `gpx/Lake_22_Trail.gpx`, `gpx/Mt_Fuji_Yoshida.gpx`). GPX 1.1 from AllTrails, containing `<trkpt>` track points (with `<ele>`) and (on the WA trails) `<wpt>` named waypoints. |
| `images/` | dir | **12 WebP hero photos**, one per trail (e.g. `images/lake-22.webp`), shown on the list cards. |
| `README.md` | docs | Project readme (not loaded by the app). |
| `docs/ARCHITECTURE.md` | docs | This document. |

**Source-only / not deployed:** the `alltrails/` directory holds the original AllTrails
`.html` / `.webarchive` saved pages and the raw GPX exports used to derive `trails.js` and the
`gpx/` tracks. It is **git-ignored** (`.gitignore` excludes `alltrails/`, `*.webarchive`,
`.DS_Store`, `*.log`) and never ships to production.

> Note: the load order in `index.html` matters — Leaflet (`L`) loads first, then `i18n.js`
> defines `window.I18N`, then `trails.js` defines `window.TRAILS`, all **before** `app.js`
> runs.

---

## 3. The data model — `window.TRAILS`

`trails.js` assigns a single global array, `window.TRAILS` (`trails.js:4`), of **12 trail
objects** — the 8 Washington State trails followed by 4 Japan trails. It holds the **English
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
| `rating` | number | AllTrails star rating (shown as `★ <rating>`). | `4.7` |
| `reviews` | number | Review count; rendered with `.toLocaleString()`. | `18454` |
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

The 12 trails are, in array order: the **8 Washington** trails `lake-22`, `snow-lake`,
`lake-valhalla`, `talapus-lake`, `mount-pilchuck`, `bridal-veil`, `skyline-loop`,
`enchantments`, followed by the **4 Japan** trails `fuji-yoshida`, `fuji-gotemba`,
`daibosatsu`, `kinpu`. The four Japan trails all set `tiles: "gsi"` and have **no GPX
waypoints**. Across the set, two are `route: "Loop"` (`skyline-loop`, `daibosatsu`), two are
`"Point to point"` (`enchantments`, `fuji-yoshida`), and the rest are `"Out & back"`. The
header subtitle's "12 trails" copy (the `#list-sub` node, `data-i18n="subtitle"`,
`index.html:30`) matches the array length.

---

## 4. Screen & routing model

### Two screens, one `hidden` toggle

`index.html` declares both screens up front: `#list` (visible by default) and `#detail`
(starts with the `hidden` attribute, `index.html:41`). Switching screens is just flipping
`.hidden`:

- `showList()` sets `#detail.hidden = true`, `#list.hidden = false`, stops GPS if running, and
  clears `curTrail` (`app.js:173-178`).
- `openDetail(t)` does the inverse: `#list.hidden = true`, `#detail.hidden = false`, sets the
  (localized) title, primes the sheet, renders the peek + body, builds the map, and loads the
  track (`app.js:183-194`).

CSS hides the inactive screen entirely (`.screen[hidden]{display:none}`, `app.css:25`), and
`#detail` is given `z-index:10` so it stacks above the list (`app.css:105`).

### Hash-based routing

Navigation is driven entirely by `location.hash`:

- **`routeFromHash()`** (`app.js:90-97`) matches the hash against
  `^#\/trail\/([\w-]+)`. If it matches and a trail with that `slug` exists, it calls
  `openDetail(t)`; otherwise it falls back to `showList()`.
- It runs **on boot** (called at the end of the `load` handler, `app.js:85`) and **on every
  hash change** (`window.addEventListener('hashchange', routeFromHash)`, `app.js:88`).
- Tapping a card sets `location.hash = '#/trail/<slug>'` (`app.js:146`); the back button and
  `showList`'s callers set `location.hash = ''` (`app.js:164`). Both mutate the hash and let
  the single `hashchange` listener re-route — there is no direct screen-swapping from the
  click handlers.

### Why hash routing

Hash routing needs **no server cooperation**: the browser never requests
`/trail/lake-22` from GitHub Pages (which would 404 without rewrite rules), because everything
after `#` stays client-side. The same property makes routes **survive offline** — the service
worker only ever has to serve `index.html`, and the hash selects the view in-page. Deep links
and the browser back/forward buttons work for free.

---

## 5. List screen subsystem

### Markup & rendering

The list screen (`#list`) contains a header (`#list-header`) whose top row is a `.head-row`
holding the `<h1 data-i18n="appName">梅ちゃんのトレイル</h1>` and the **language toggle button
`#lang-toggle`** (§1a), followed by the `#list-sub` subtitle. Below the header is a
horizontally-scrolling `#filter-bar` of `.chip` buttons, and an empty `#trail-list` container
that JS fills (`index.html:21-37`). The filter chips are **All / Moderate / Hard / Very Hard**
plus two sort chips (**↕ Distance**, **↕ Elevation**) — there is **no "Easy" chip** because no
trail is Easy-rated (`index.html:29-36`); each chip label carries a `data-i18n` key.

**`renderList()`** (`app.js:114-147`) is the single render function:

1. Copies `TRAILS` (`.slice()`), applies the active **filter** and **sort** (below).
2. Maps each trail to a **`<article class="card" data-slug="…">`** built via template literal.
   It first computes `const tr = loc(trail)` so localized fields (name, area) come from the
   merged object (§1a). The card markup is:
   - `.card-img-wrap` holding the lazy-loaded `<img class="card-img">`,
   - a difficulty badge `<span class="card-badge-diff <diffClass>">` whose label is
     `trDiff(diff)`,
   - an optional offline check (`offIcon`, below),
   - a `.card-titlebar` overlay with `.card-title` (`tr.name`) and `.card-area` (`tr.area`),
   - a `.card-stats` row: distance (`↔ fmtDist(lengthMi)`), gain (`▲ fmtGain(gainFt)`), route
     (`⟳ trRoute(route)`), and a right-aligned `.star` rating.
3. Joins the HTML, writes it into `#trail-list`, then wires each `.card`'s click to set
   `location.hash = '#/trail/' + slug` (`app.js:145-146`).

`renderList()` is intentionally idempotent and is called several times: once on boot, again
after `refreshCacheStatus()` so offline badges appear (`app.js:81,84`), after each filter/sort
change, after a **language switch** (from `setLang()`), and after a successful tile download
(`app.js:159`, `app.js:556`).

### Difficulty badge classes

Two small lookup helpers map the human-readable English `diff` token (note: they key off the
**raw** token, not the translated label):

- **`diffClass(d)`** → CSS class: `Easy→d-easy`, `Moderate→d-moderate`, `Hard→d-hard`,
  `Very Hard→d-veryhard` (default `d-moderate`) (`app.js:104-106`). Those classes set the
  badge's tinted background + text color (`app.css:99-102`).
- **`diffKey(d)`** → filter token: `Easy→easy`, … `Very Hard→veryhard` (`app.js:107-109`),
  matching the chips' `data-filter` values.

### Filter & sort state

Module-level state holds the current view config: **`listFilter`** (default `'all'`) and
**`listSort`** (default `null`) (`app.js:102`). `bindGlobal()` wires the `#filter-bar` chips
(`app.js:150-161`):

- A chip with `data-filter` sets `listFilter` and toggles the `.active` class among the filter
  chips.
- A chip with `data-sort` **toggles** that sort on/off (clicking the active one clears it back
  to `null`) and toggles `.active` accordingly.
- Either way it calls `renderList()`. Filtering uses `diffKey(t.diff) === listFilter`; sorting
  is ascending by `lengthMi` (`'dist'`) or `gainFt` (`'gain'`) (`app.js:117-119`).

`bindGlobal()` also wires the language toggle (`#lang-toggle` → `setLang`, `app.js:163`), the
back button, the GPS FAB, the sheet drag, and the download-modal buttons.

### Offline badge driven by `cacheStatus`

`cacheStatus` is a module-level map of `slug → bool` (`app.js:19`). In `renderList()`, a trail
whose tiles are cached renders `offIcon` =
`<div class="card-offline ready" title="…">✓</div>` (a green check, top-right of the card;
the `title` uses the localized `t('dlSaved')`); otherwise nothing (`app.js:123-124`, styled at
`app.css:80-86`). `cacheStatus` is populated by `refreshCacheStatus()` on boot and flipped to
`true` after a download (`app.js:554`).

---

## 6. Detail screen subsystem

### `openDetail()` flow

`openDetail(t)` (`app.js:183-194`) is the detail-screen entry point, invoked only by the
router:

1. `curTrail = t` and swap screens (`#list` hidden, `#detail` shown).
2. Set `#detail-title` text to the **localized** trail name (`loc(trail).name`).
3. **Reset the sheet to peek** via `setSheet('peek')` (§11).
4. **Populate the peek header** via `renderPeek(t)` (below).
5. `renderSheetBody(t)` builds the scrollable body (below).
6. `initMap()` constructs the Leaflet map (§7).
7. `await loadTrail(t)` fetches/parses the GPX and draws the track + profile (§8–§9).

This split — `renderPeek()` for the header and `renderSheetBody()` for the body — exists so a
**language switch** can re-render both in place (from `setLang()`, §1a) without rebuilding the
map.

### The peek / meta header — `renderPeek()`

The bottom sheet's always-visible "peek" region is `#sheet-peek`, containing `#pk-title` and
`#pk-meta` (`index.html:51-54`). Tapping it toggles the sheet open/closed; it is hidden in
landscape (§11, §14).

**`renderPeek(trail)`** (`app.js:196-203`) fills it: `#pk-title` = `loc(trail).name`; `#pk-meta`
= `<span>` chips for `fmtDist(lengthMi)`, `▲ fmtGain(gainFt)`, a difficulty span (the label is
`trDiff(diff)`, colored via `diffClass` but with `background:none;padding:0` so it reads as
colored text, not a pill), and a `.star` rating with review count.

### `renderSheetBody()`

`renderSheetBody(t)` (`app.js:205-259`) writes the entire scrollable sheet body (`#sheet-body`)
in one `innerHTML` assignment. It first computes `const tr = loc(trail)` for the localized prose
fields. All section headings and labels come from `t(...)`:

- **Stat chips** — a `.stat-grid` of four `.stat-box`es: **Distance** (`fmtDist` value: miles in
  EN, km in JA, with the unit baked into the label), **Gain** (feet abbreviated to `…k` in EN,
  e.g. `1.5k`; meters in JA), **Difficulty** (`trDiff(diff)`), and **Time** (`fmtTime(time)`).
  The last two use a smaller inline `font-size:13px`.
- **Elevation card** — `#elev-card` with a header (`t('elevation')` + `#elev-range` span) and an
  empty `<svg id="elev-svg" preserveAspectRatio="none">` that `drawProfile()` fills (§9).
- **Download button** — `<button class="dl-btn" id="sheet-dl">` whose label/`ready` class
  depend on `cacheStatus[t.slug]` (`t('dlDownload')` vs `t('dlSaved')`), plus a `.dl-prog` bar
  element. Its click opens the download modal (`openDownloadModal(t)`, `app.js:257`).
- **Prose sections** (`.section`): **Overview** (`tr.summary`), **The hike** (`tr.description`),
  **Tips & need-to-know** (`tr.tips` → `<ul class="tips">`), and **Details** — section titles
  via `t('secOverview'/'secHike'/'secTips'/'secDetails')`.
- **Details table** — a `<dl class="facts">` with rows: Route type (`trRoute(route)`), Best
  season (`trSeason(season)`), Dogs (`trDogs(dogs)`), Permit (`tr.permit`), Location (`tr.area`)
  (`app.js:245-251`); the `<dt>` labels come from `t('factRoute')` … `t('factLocation')`.
- A small attribution footer (`t('attribution')`) crediting AllTrails (info/photo) and USGS
  (map).

---

## 7. Map subsystem

**`initMap()`** (`app.js:269-276`) (re)builds the Leaflet map each time a detail screen opens:

1. If a map already exists, `map.remove()` it and null it out — every detail view gets a fresh
   map instance bound to the `#map` div.
2. `L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center,
   zoom:13, tap:true })` — the default zoom control is suppressed so it can be re-added in a
   custom position; `tap:true` enables Leaflet's tap handler for touch.
3. Add a **zoom control at `topright`** (`L.control.zoom({ position:'topright' })`,
   `app.js:272`).
4. Add the **USGS topo tile layer** (below).
5. `map.on('dragstart', …)` disables GPS follow mode and clears the FAB's `.on` highlight when
   the user pans (`app.js:274`) — see §10.
6. Nudge the zoom control down so it clears the floating header:
   `marginTop = calc(54px + env(safe-area-inset-top,0px))` (`app.js:275`).

### USGS tile layer

The base map is the **USGS National Map "USGSTopo"** service. The template URL
(`TILE_URL`, `app.js:7`) is:

```
https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}
```

Note the **`{z}/{y}/{x}`** (row-before-column) ordering used by this ArcGIS service. The layer
is added with `maxZoom:16, minZoom:8, attribution:'© USGS', crossOrigin:true` (`app.js:273`);
`crossOrigin:true` is what lets the offline download read the tiles back out of the Cache API.

### Cache-first behavior

Tiles are **not** loaded by the page directly from the network when cached. The service worker
intercepts any request whose URL `includes('nationalmap.gov')` and serves **cache-first** from
the `TILE_V` cache, only hitting the network on a miss and storing the response (§12, §15;
`sw.js:44-51`). So a previously-visited or pre-downloaded trail renders its map from cache with
no connectivity.

---

## 8. GPX & geometry subsystem

### `loadTrail()` — fetch & parse

`loadTrail(t)` (`app.js:278-310`) turns a GPX file into in-memory geometry:

1. Reset `trackPts`, `trackWpts`, `totalDist`.
2. **Fetch** the GPX text: `await (await fetch(t.gpx)).text()`, wrapped in try/catch that logs
   and bails on failure (`app.js:281-282`). (When offline, the SW serves the GPX from the
   precached `APP_V` shell — see §15.)
3. **Parse** with `new DOMParser().parseFromString(text, 'text/xml')` (`app.js:283`).
4. **Waypoints** — for each `<wpt>`, read `lat`/`lon` attributes and the child `<name>` (CDATA,
   whitespace-collapsed), pushing `{ lat, lon, name, d:null }` into `trackWpts`
   (`app.js:285-289`). The stored `name` is the **English** name; it is translated for display
   via `trWpt()` (§1a).
5. **Track points** — iterate `<trkpt>`; read `lat`/`lon` and the child `<ele>` (defaulting to
   `0` when missing). Maintain a running cumulative distance `d` by adding the haversine
   distance from the previous point, and push `{ lat, lon, ele, d }` into `trackPts`. Set
   `totalDist = d` (`app.js:291-299`).
6. **Smooth** elevations for display via `smoothEle()` (below).
7. **Snap waypoints** to the track: for each waypoint, scan all track points for the nearest
   one (by haversine) and copy that point's cumulative distance into `w.d` (`app.js:303-306`).
   This is what lets a waypoint be drawn at the right x-position on the elevation profile.
8. Call `drawTrack()` then `drawProfile()`.

> The sample GPX files are GPX 1.1 exports from AllTrails — e.g. `Lake_22_Trail.gpx` has 1558
> `<trkpt>` elements and 5 `<wpt>` elements, with names like "Bridge", "Waterfall", "Vista".

### `hav()` — haversine distance

`hav(la1,lo1,la2,lo2)` (`app.js:575-580`) returns the great-circle distance **in meters**
between two lat/lon pairs, using Earth radius `R = 6_371_000`. It is the geometry workhorse:
cumulative track distance, waypoint snapping, loop detection, and nearest-point-to-GPS all call
it.

### `smoothEle()` — elevation smoothing

`smoothEle()` (`app.js:312-320`) computes a **centered moving average** of raw `ele` over a
**window of 15** points (`w = 15`), writing the smoothed value to each point's `.se`
("smoothed elevation"). It clamps the window at the array ends (`lo`/`hi`). The profile and the
ft-range label both read `.se`, not raw `.ele`, so the displayed curve is denoised.

### `drawTrack()` — rendering the route

`drawTrack()` (`app.js:322-342`) renders all map geometry:

1. **Subsample** to **≤ 1200 points**: `step = max(1, floor(trackPts.length/1200))`, keeping
   every `step`-th point plus always the last one (`app.js:323-324`). This bounds the polyline's
   vertex count for performance on long tracks (the Enchantments GPX is ~626 KB).
2. **Halo + line pattern** — two stacked polylines over the same coords:
   - a **black halo**: `color:'#000', weight:7, opacity:0.25` (`app.js:326`),
   - the **red trail line** on top: `color:'#ef4444', weight:4, opacity:0.95`, saved as
     `trackLayer` (`app.js:327`).
   The halo gives the red line contrast against busy topo tiles.
3. **Endpoints:**
   - **Trailhead** — a **green** dot at `trackPts[0]` via
     `endMarker(p, '#22c55e', 'markerTrailhead')` (note: the **third argument is an i18n key**,
     not a literal label).
   - **Loop detection** — `isLoop` is true when **either** `curTrail.route === 'Loop'`
     **or** the straight-line distance between the first and last track point is **< 120 m**
     (`hav(first,last) < 120`) (`app.js:332`). The **End** marker (a **red** dot,
     `endMarker(last, '#ef4444', 'markerEnd')`) is drawn **only when `!isLoop`** (`app.js:333`)
     — on a loop the start and end coincide, so a separate endpoint would be redundant.
4. **Waypoints** — each `trackWpts` entry becomes an **amber** dot (`dotIcon('#f59e0b', 11)`)
   with a bound popup showing the localized waypoint name (`trWpt(w.name)`). The marker is
   **retained on `w._marker`** so its popup can be re-localized on a language switch
   (`app.js:335-339`).
5. **Fit bounds** — `map.fitBounds(trackLayer.getBounds(), …)` with **sheet-aware padding**:
   top-left `[30,70]` (clears the header) and bottom-right `[30, sheetPeekHeight()+30]` so the
   route isn't hidden behind the peeking bottom sheet (`app.js:341`).

Markers are built by two small helpers:

- **`endMarker(p, color, key)`** (`app.js:345-350`) — a size-15 dot with a popup whose content
  is `t(key)`. It **stores the i18n key on the marker** (`mk._i18nKey = key`) and pushes the
  marker onto the static list **`endMarker._all`**, so the endpoint popups can be re-bound when
  the language changes.
- **`dotIcon(color, size)`** (`app.js:360-365`) — returns an `L.divIcon` whose HTML is a
  colored, white-bordered circle with a drop shadow.

### `redrawTrailLabels()` — live label re-localization

**`redrawTrailLabels()`** (`app.js:353-358`), called from `setLang()` (§1a), re-binds all marker
popups in the active language **without rebuilding the map**: it walks `endMarker._all` and calls
`setPopupContent(t(mk._i18nKey))` on each endpoint marker, and walks `trackWpts` calling
`setPopupContent(trWpt(w.name))` on each `w._marker`.

> The only retained layer reference is **`trackLayer`** (the red polyline, used for
> `fitBounds`); it is declared as module state (`app.js:14`). The halo polyline and the
> end/waypoint markers are added to the map without a top-level reference (waypoint markers are
> reachable via `trackWpts[i]._marker` and endpoint markers via `endMarker._all`). Everything is
> recreated on each `loadTrail`/`drawTrack` because `initMap()` discards the whole map first.

---

## 9. Elevation profile subsystem

### `drawProfile()` — SVG generation

`drawProfile()` (`app.js:368-399`) renders the elevation chart into `#elev-svg`. It bails early
if the SVG is missing or there are `< 2` track points.

1. Sizing: `W = svg.clientWidth || 340`, fixed `H = 96`; sets the `viewBox` to `0 0 W H`
   (the SVG uses `preserveAspectRatio="none"` so it stretches to the card width).
2. Range: `lo`/`hi`/`range` from the **smoothed** elevations (`p.se`), with `range` floored at 1
   to avoid divide-by-zero (`app.js:373`).
3. **Subsample to ~500 points** (`step = max(1, floor(len/500))`) for the path (`app.js:374-375`).
4. Coordinate mappers: `X(d) = (d/totalDist)*W` (distance → x) and
   `Y(e) = H-14 - ((e-lo)/range)*(H-26)` (elevation → y, leaving ~14px bottom and ~12px top
   padding) (`app.js:376`).
5. Build three pieces of SVG:
   - **Filled area** `path` — from `M0,H` along the curve and back down to `L W,H Z`, painted
     with a vertical **linear gradient** `#eg` (blue `#3b82f6`@0.7 → dark blue `#1e3a8a`@0.15)
     (`app.js:378-380`, `app.js:390-393`).
   - **Line** `path` — the curve only, stroked `#60a5fa`, width 1.5 (`app.js:381-382`, `:396`).
   - **Waypoint verticals** — for each waypoint with a snapped distance (`w.d != null`), a
     **dashed amber vertical line** (`stroke="#f59e0b" stroke-dasharray="3,3" opacity="0.6"`)
     at that x (`app.js:384-387`).
6. Inject `<defs>`(gradient) + waypoint lines + area + line + an empty `<g id="epos">` (the live
   position layer) into the SVG (`app.js:389-397`).
7. Update the **elevation-range label** `#elev-range` via `fmtElevRange(lo, hi)` (`app.js:398`):
   **feet** in EN (`"<lo>–<hi> ft"`, converting smoothed meters with `FT = 3.28084`) and
   **meters** in JA (`"<lo>～<hi> m"`).

### `updateProfilePos()` — live position marker

`updateProfilePos(idx)` (`app.js:407-418`) draws the hiker's current spot on the profile. Given
the index of the nearest track point, it recomputes the same `X`/`Y` mapping and writes into the
`#epos` group:

- a **white dashed vertical line** (`stroke="#fff" stroke-dasharray="4,3"`) at the current x, and
- a **blue dot** (`fill="#3b82f6" stroke="#fff"`, r 4.5) at the current `(x,y)`.

It is called from the GPS handler (§10) with the nearest-point index, and cleared when GPS stops
(`#epos` emptied in `stopGPS`, `app.js:442`).

---

## 10. GPS subsystem

A single floating action button, `#btn-gps` (`.map-fab`, `index.html:47`), drives live
location; its click is bound to `toggleGPS` (`app.js:165`).

### Toggle / start / stop

- **`toggleGPS()`** (`app.js:423-430`) is tri-state:
  - **Not watching** → `startGPS()`.
  - **Watching but not following** (and we have a `curPos`) → re-enable follow, re-highlight the
    FAB, and recenter the map on the user at `max(currentZoom, 15)`.
  - **Watching and following** → `stopGPS()`.
- **`startGPS()`** (`app.js:431-436`): if `navigator.geolocation` is missing, `alert(t('alertNoGeo'))`
  and bail; otherwise request a wake lock (below), set `gpsFollow = true`, highlight the FAB
  (`.on`), and start `navigator.geolocation.watchPosition(onPos, onPosErr,
  {enableHighAccuracy:true, maximumAge:4000, timeout:30000})`, storing the watch id in `gpsWatch`.
- **`stopGPS()`** (`app.js:437-443`): `clearWatch`, release the wake lock, reset
  `gpsFollow`/`curPos`, remove the GPS marker and accuracy circle, drop the FAB highlight, and
  clear the profile position layer (`#epos`).

### Position updates — `onPos()`

`onPos(pos)` (`app.js:444-457`):

1. Read `latitude`/`longitude`/`accuracy`; store `curPos = {lat,lon}`.
2. **Pulsing dot + accuracy circle.** On the first fix it creates:
   - `gpsMk` — an `L.marker` whose icon is a `<div class="gps-dot">` (the blue dot with the CSS
     `gpspulse` keyframe ring, `app.css:205-211`), at `zIndexOffset:1000` so it sits above the
     track.
   - `gpsAcc` — an `L.circle` of `radius:accuracy`, faint blue fill, used as the accuracy halo.
   On subsequent fixes it just repositions both and updates the circle's radius (`app.js:447-450`).
3. **Follow mode.** If `gpsFollow`, recenter the map to the new position at `max(currentZoom,15)`
   with animation (`app.js:451`).
4. **Nearest track point → profile.** Scan all `trackPts` for the one nearest the fix (haversine)
   and pass its index to `updateProfilePos(idx)` (`app.js:452-456`), moving the blue marker along
   the elevation profile in sync with the map dot.

`onPosErr(err)` (`app.js:458`) specifically handles permission-denied (`code === 1`) with an
instructional `alert(t('alertDenied'))` (pointing to iOS Settings → Privacy → Location Services →
Safari) and stops GPS.

### How dragging disables follow

`initMap()` registers `map.on('dragstart', …)` which sets `gpsFollow = false` and removes the
FAB's `.on` class (`app.js:274`). So as soon as the user pans the map, the app stops yanking the
view back; tapping the FAB again re-engages follow (the second branch of `toggleGPS`).

### Screen Wake Lock

- **`reqWake()`** (`app.js:460`) requests `navigator.wakeLock.request('screen')` (guarded by a
  feature check, errors swallowed) so the screen stays on while navigating.
- **`relWake()`** (`app.js:461`) releases it and nulls `wakeLock`.
- **Re-acquire on visibility.** Wake locks are dropped when a tab is backgrounded, so a
  `visibilitychange` listener (`app.js:462`) re-requests the lock when the page becomes visible
  again **and** GPS is still active **and** no lock is currently held.

---

## 11. Bottom sheet subsystem

The detail screen's `#sheet` (`index.html:49-56`) is a draggable bottom sheet with a grip
(`#grip`), a tappable peek region (`#sheet-peek`), and a scrollable body (`#sheet-body`). It has
two states tracked by `sheetState` (`app.js:18`): **`'peek'`** and **`'full'`**.

### Heights & `setSheet()`

- **Peek height** is **≈16 % of viewport height**: `sheetPeekHeight() = round(innerHeight*0.16)`
  (`app.js:467`).
- **Full height** is **`90dvh`** (dynamic viewport height) (`app.js:478`); CSS caps the sheet at
  `max-height:92dvh` (`app.css:148`).
- **`setSheet(state)`** (`app.js:468-480`):
  - In landscape (`(orientation:landscape) and (max-height:560px)`) the sheet is docked to the
    side, so it clears the inline height and just parks the FAB at
    `calc(20px + var(--safe-b))` (`app.js:472-476`).
  - Otherwise it sets the sheet's inline `height` to the peek px or `90dvh`, and positions the
    **GPS FAB just above the peek sheet**: `bottom = calc(<peekPx>px + 14px)` (`app.js:479`). So
    in peek the FAB floats over the map above the sheet; when the sheet expands to full, the FAB
    ends up behind it.

The sheet's smooth open/close is a CSS height transition
(`transition:height .32s cubic-bezier(...)`, `app.css:146`), with `touch-action:none` so the
drag gesture isn't hijacked by the browser.

### Drag gesture — `initSheetDrag()`

`initSheetDrag()` (`app.js:481-496`) implements a unified pointer drag:

- **Start** (`touchstart` passive / `mousedown` on **both** `#grip` and `#sheet-peek`) records
  the start Y and the sheet's current height, and disables the CSS transition for 1:1 dragging.
- **Move** (window-level `touchmove`/`mousemove`) sets the sheet height to
  `clamp(peekHeight … innerHeight*0.9)` based on drag delta (`startH + (startY - y)`).
- **End** (`touchend`/`mouseup`) re-enables the transition and **snaps**: if the released height
  is above `innerHeight*0.45` → `setSheet('full')`, else `setSheet('peek')` (`app.js:486`).

### Tap to toggle

Tapping the peek (when not mid-drag) toggles between peek and full:
`peek.addEventListener('click', () => setSheet(sheetState==='peek'?'full':'peek'))`
(`app.js:495`).

### FAB position tracks the sheet

As described above, every `setSheet()` recomputes the FAB's `bottom`. On resize/rotation the
debounced handler also re-runs `setSheet(sheetState)` so the FAB and sheet height stay correct
(`app.js:584-587`).

---

## 12. Offline tile download subsystem

This lets a user **pre-cache a trail's USGS tiles** so the map works with no connectivity. It is
driven from the sheet's download button and the `#dl-modal` dialog (`index.html:60-71`).

### Opening the modal — `openDownloadModal()`

`openDownloadModal(t)` (`app.js:502-509`) stores `dlTrail = t`, computes the estimated tile count
via `countTiles(t)`, writes a localized description (`tf('dlDesc')(loc(t).name, n)`), resets the
progress bar/status (`tf('dlTiles')(n)`), sets the button label to `t('dlGo')`, and unhides the
modal.

### Bounding box — `trailBox()`

`trailBox(t)` (`app.js:510-518`) computes the lat/lon box to cover:

- **Prefer the live track bounds** — if `trackPts` is loaded **and** `t === curTrail`, it takes
  the min/max lat & lon over all track points.
- **Fallback to center ± 0.02°** — otherwise it boxes `t.center` by ±0.02 degrees.
- Either way it pads the result by **`PAD = 0.01`°** on all sides (`app.js:10`, `app.js:517`).

### Web Mercator tile math

The download converts the box to **XYZ tile ranges** at each zoom:

- **`ll2t(lat, lon, z)`** (`app.js:533-535`) is the standard slippy-map projection:
  `n = 2^z`, `x = floor(n*(lon+180)/360)`, and
  `y = floor(n*(1 - ln(tan(φ) + sec(φ))/π)/2)` with `φ = lat·π/180`. Returns `{x, y}`.
- **`tRange(b, z)`** (`app.js:531-532`) projects the SW and NE corners and returns the inclusive
  `{x0,x1,y0,y1}` tile range (min/max-ed so corner order doesn't matter).
- **`DL_ZOOMS = [10,11,12,13,14,15,16]`** (`app.js:9`) — tiles are fetched for **zoom 10
  through 16**.
- **`countTiles(t)`** (`app.js:519-523`) sums `(x1-x0+1)*(y1-y0+1)` over all `DL_ZOOMS`.
- **`tileURLs(t)`** (`app.js:524-530`) expands every `(z,x,y)` into a concrete tile URL by
  substituting into `TILE_URL`.

### Batched fetch into the Cache API — `startDownload()`

`startDownload()` (`app.js:537-558`), bound to `#dl-go` (`app.js:170`):

1. Guards against re-entry (`dlRunning`) and disables the button (`t('dlDownloading')`).
2. Builds the URL list and opens the **`TILE_CACHE`** cache (`'wa-trails-tiles-v1'`,
   `app.js:8` / `app.js:542`).
3. Iterates in **batches of 8** (`BATCH = 8`). For each URL in a batch it skips ones already
   cached (`cache.match`), otherwise `fetch(u, {mode:'cors'})` and `cache.put` it if the response
   is `ok` **or** `opaque`. Each settled request bumps `done` and updates the progress bar width
   and the status text via `tf('dlProgress')(done, total, pct)` (`app.js:543-550`).
   `Promise.allSettled` ensures one failed tile doesn't abort the batch.
4. On completion: set the status to `tf('dlDone')(done)`, mark `cacheStatus[dlTrail.slug] = true`,
   flip the sheet button to its `ready` `t('dlSaved')` state, `renderList()` (so the list badge
   updates), and auto-dismiss the modal after 1.4 s (`app.js:551-557`).

> Because the page writes into the **same cache name** (`wa-trails-tiles-v1`) the service worker
> reads from, a pre-downloaded trail is served cache-first by the SW with zero further network
> use (see §15).

### Status sampling — `refreshCacheStatus()`

`refreshCacheStatus()` (`app.js:560-570`) decides which trails already have offline tiles. For
each trail it computes the **z14 center tile** (`ll2t(center, 14)`), builds that tile's URL, and
sets `cacheStatus[slug]` to whether `cache.match` finds it. It runs once on boot (awaited before
the second `renderList()`), so the green offline checks reflect reality at startup. (It samples a
single representative tile rather than verifying the whole set.)

---

## 13. State management

All runtime state lives as **module-level `let`/`const` bindings** at the top of `app.js`
(plus a couple declared inline). There is no store, no reactive system — functions read/write
these directly and re-render by rewriting `innerHTML`.

| Variable | Decl | Holds |
|---|---|---|
| `map` | `app.js:14` | The current Leaflet map instance (or `null`). |
| `curTrail` | `app.js:14` | The trail object currently open in detail (or `null`). |
| `trackLayer` | `app.js:14` | The red track polyline `L.polyline` (used for `fitBounds`). The **only** retained layer reference. |
| `trackPts` | `app.js:15` | Parsed track points: `{lat, lon, ele, d, se}` with cumulative distance `d` and smoothed elevation `se`. |
| `trackWpts` | `app.js:15` | Parsed waypoints: `{lat, lon, name, d, _marker}` with snapped along-track distance `d` and the retained Leaflet marker. |
| `totalDist` | `app.js:16` | Total track length in meters (for profile x-scaling). |
| `gpsWatch` | `app.js:16` | `watchPosition` id while GPS is active (`null` when off). |
| `gpsMk` | `app.js:16` | The pulsing GPS-position marker (or `null`). |
| `gpsAcc` | `app.js:16` | The GPS accuracy circle (or `null`). |
| `gpsFollow` | `app.js:16` | Whether the map auto-recenters on the user. |
| `curPos` | `app.js:17` | Last known `{lat, lon}` fix (or `null`). |
| `wakeLock` | `app.js:17` | The active Screen Wake Lock sentinel (or `null`). |
| `sheetState` | `app.js:18` | Bottom-sheet state: `'peek' | 'full'`. |
| `cacheStatus` | `app.js:19` | `{ slug: bool }` — whether each trail's tiles are cached. |
| `lang` | `app.js:27` | Active language: `'ja'` (default) or `'en'`, seeded from `localStorage.lang` (§1a). |
| `listFilter` | `app.js:102` | Active difficulty filter (`'all'` or a `diffKey`). |
| `listSort` | `app.js:102` | Active sort (`'dist'`, `'gain'`, or `null`). |
| `dlTrail` | `app.js:501` | Trail targeted by the open download modal. |
| `dlRunning` | `app.js:501` | Re-entry guard for an in-flight download. |
| `rzT` | `app.js:583` | Debounce timer handle for the resize handler. |

Two trivial DOM helpers are also defined globally: **`$`** (`querySelector`) and **`$$`**
(`querySelectorAll` → array) (`app.js:21-22`). The i18n helpers `t` / `tf` / `loc` / `trDiff` /
`trRoute` / `trDogs` / `trWpt` / `trSeason` and the unit formatters `fmtDist` / `fmtGain` /
`fmtTime` / `fmtElevRange` are documented in §1a.

Module-level **constants** (`app.js:7-11`): `TILE_URL`, `TILE_CACHE` (`'wa-trails-tiles-v1'`),
`DL_ZOOMS`, `PAD` (0.01°), `FT` (3.28084).

---

## 14. Responsive design

### Portrait (default)

The default layout is a single-column, full-height mobile UI: the list is a vertical
flex column of cards (`#trail-list`, `app.css:49-53`); the detail screen layers a full-bleed
`#map`, a floating translucent header, the GPS FAB, and the bottom sheet.

### Landscape phones — `@media (orientation:landscape) and (max-height:560px)`

A single media query (`app.css:242-256`) reflows the app for landscape phones (short viewports):

- **List → 2-column grid.** `#trail-list` becomes
  `display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:min-content` (`app.css:244`).
- **Detail → map left, sheet docked right.** `#sheet` is repositioned to the **right edge**
  (`top:0; bottom:0; left:auto; right:0; width:min(360px,42%)`), with `height:auto !important`,
  no rounded corners, and a left-side shadow; its top padding clears the header
  (`app.css:247-252`). The grip and peek are **hidden** (`display:none`) since the sheet is
  always open, and `#map` is shrunk to make room: `right:min(360px,42%)` (`app.css:253-255`).
- **FAB repositioning.** `setSheet()` detects this same media query at runtime and parks the GPS
  FAB at `calc(20px + var(--safe-b))` instead of above the (now side-docked) sheet
  (`app.js:472-476`).

### Safe-area-inset handling (notch / home indicator)

Four design tokens capture the device safe areas:
`--safe-t/-b/-l/-r = env(safe-area-inset-*)` (`app.css:7-10`), enabled by
`viewport-fit=cover` in the viewport meta (`index.html:5`) and the
`apple-mobile-web-app-status-bar-style: black-translucent` meta (`index.html:8`). (The head
also declares **both** the standard `mobile-web-app-capable` and the legacy
`apple-mobile-web-app-capable` meta tags for standalone display, `index.html:6-7`.) They're
applied throughout so content avoids the notch and home indicator: the list header padding
(`app.css:29`), the list's bottom scroll padding (`app.css:59`), the detail header height/padding
(`app.css:107-108`), the map FAB's left offset (`app.css:131`), the sheet body's bottom padding
(`app.css:160`), and the download modal's bottom (`app.css:227`).
The Leaflet zoom control is likewise nudged by `env(safe-area-inset-top)` in JS (`app.js:275`).
`#app` uses `height:100dvh` (with a `100vh` fallback) so it tracks the dynamic viewport as
Safari's chrome shows/hides (`app.css:20`).

---

## 15. Caching layers

The app has **two distinct Service-Worker caches**, declared at the top of `sw.js`:

| Cache name | Constant | Contents | Written by |
|---|---|---|---|
| `wa-trails-app-v3` | `APP_V` (`sw.js:1`) | **App shell + bundled assets** — HTML/CSS/JS (incl. `i18n.js`), manifest, icon, Leaflet CSS+JS, and **all 8 GPX files + 8 hero images**. | SW `install` (`addAll(SHELL)` + best-effort `TRAIL_ASSETS`); SW `fetch` fills same-origin/unpkg misses. |
| `wa-trails-tiles-v1` | `TILE_V` (`sw.js:2`) | **USGS map tiles** only. | SW `fetch` (cache-first fill on miss) **and** the page's `startDownload()` pre-cache. |

> The cache **names** retain the historic `wa-trails-` prefix (an internal identifier — it is
> not user-facing and is intentionally left unchanged so a deploy doesn't needlessly evict the
> existing tile cache). The product is "Ume-chan's Trails"; only this internal cache key keeps
> the old prefix.

### Shell precache (`install`)

On `install` (`sw.js:22-30`), the SW opens `APP_V`, **`addAll(SHELL)`** (which must all succeed —
`SHELL` lists `./`, `index.html`, `app.css`, `app.js`, `trails.js`, **`i18n.js`**,
`manifest.json`, `icon.svg`, and the two Leaflet CDN URLs, `sw.js:4-9`), then **best-effort**
caches `TRAIL_ASSETS` (the 8 GPX + 8 webp) with `Promise.allSettled` so a single failed asset
doesn't break install. It calls `skipWaiting()`. Bundling the GPX and images means a trail's
track and photo are available with **zero network**, even one the user has never opened.

### Activation / cleanup (`activate`)

On `activate` (`sw.js:32-38`), the SW deletes any cache whose name is **neither** `APP_V`
**nor** `TILE_V`, then `clients.claim()`. This is the version-migration mechanism: bumping
`APP_V` (currently `…-v3`) on a deploy evicts the previous shell cache automatically,
while the tile cache (`TILE_V`) is deliberately preserved across shell upgrades so users don't
lose downloaded maps.

### Fetch strategy (`fetch`)

`fetch` (`sw.js:40-63`) has two branches:

1. **Tiles (cache-first).** Any URL containing `nationalmap.gov` is served from `TILE_V`:
   return the cached hit, else fetch, store the clone if `ok` **or** `opaque`, and on network
   failure return an empty `503` (`sw.js:44-51`). This is what makes downloaded tiles render
   offline.
2. **Shell + bundled assets (cache-first, fill on miss).** Everything else tries
   `caches.match` first; on a miss it fetches, and if `ok` **and** the request is same-origin or
   an `unpkg.com` host, stores the clone in `APP_V`. On a network failure it falls back to the
   cached `./index.html` for **navigations** (so the app still launches offline), or an empty
   `503` otherwise (`sw.js:55-62`).

### How the page-level download ties in

The crucial coupling: `app.js`'s `TILE_CACHE` (`app.js:8`) and `sw.js`'s `TILE_V` (`sw.js:2`)
are the **same string**, `'wa-trails-tiles-v1'`. So when `startDownload()` writes tiles into the
cache (§12), the service worker's tile branch later finds and serves them — the page is the
**writer**, the SW is the **reader**, sharing one named cache. The `activate` cleanup explicitly
spares `TILE_V`, so those downloads persist across app updates.

---

## Appendix — runtime sequence (open a trail, go offline)

```
boot
   └─► load ─► applyStaticI18n() (fill [data-i18n], <title>, <html lang>)
            ─► renderList() ─► bindGlobal() ─► refreshCacheStatus() ─► renderList()
            ─► routeFromHash() ─► register sw.js

user taps card
   └─► location.hash = "#/trail/<slug>"
         └─► hashchange ─► routeFromHash() ─► openDetail(t)
               ├─ swap screens (#list hidden, #detail shown)
               ├─ #detail-title = loc(t).name
               ├─ setSheet('peek')
               ├─ renderPeek(t)       (fill #pk-title/#pk-meta, localized + units)
               ├─ renderSheetBody(t)  (stats, empty <svg>, dl button, prose, facts)
               ├─ initMap()
               │     ├─ L.map(center=t.center, zoom=13)
               │     ├─ zoom control @ topright
               │     └─ USGS tileLayer ──► requests intercepted by sw.js
               │                              └─ TILE_V cache-first
               └─ await loadTrail(t)
                     ├─ fetch(t.gpx) ──► sw.js serves from APP_V (works offline)
                     ├─ DOMParser ─► trackPts[] (d via hav), trackWpts[]
                     ├─ smoothEle()  (window 15 ─► .se)
                     ├─ snap wpts to nearest track-point distance
                     ├─ drawTrack()    (subsample ≤1200; halo+red line;
                     │                   green trailhead (markerTrailhead);
                     │                   red end (markerEnd) if !isLoop;
                     │                   amber wpts on w._marker; fitBounds w/ sheet padding)
                     └─ drawProfile()  (SVG area+line gradient, wpt verticals, elev range)

user taps EN / 日本語 (#lang-toggle)
   └─► setLang(next) ─► persist localStorage.lang
         ─► applyStaticI18n() ─► renderList()
         ─► if curTrail: #detail-title, renderPeek(), renderSheetBody(),
                         redrawTrailLabels()  (re-bind marker popups, no map rebuild)

user taps ◎ (GPS)
   └─► toggleGPS() ─► startGPS() ─► reqWake() + watchPosition()
         └─► onPos() ─► move gps-dot + accuracy circle
                       ─► if follow: recenter
                       ─► nearest trackPt ─► updateProfilePos(idx)

user taps "Download map for offline"
   └─► openDownloadModal(t) ─► startDownload()
         └─► tileURLs() over DL_ZOOMS[10..16] from trailBox()
             ─► batched fetch(8) ─► caches.open('wa-trails-tiles-v1').put()
             ─► cacheStatus[slug]=true ─► renderList() (green ✓ badge)
```
