# Development Guide — Ume-chan's Trails (梅ちゃんのトレイル)

Developer guide for **Ume-chan's Trails** (梅ちゃんのトレイル), a static,
offline-capable hiking PWA for iPhone. It shows 10 trails — **8 in Washington
State, USA, and 2 in Japan** — on topographic maps (**USGS** for the US trails,
**GSI 地理院タイル** for the Japan trails) with GPX tracks, live GPS, and
elevation profiles. The UI is **bilingual — Japanese by default, with a one-tap
toggle to English** (all text and units; see [`docs/I18N.md`](./I18N.md)).

- **Live site:** <https://huangwaylon.github.io/gpx/>
- **Repo:** <https://github.com/huangwaylon/gpx>
- **Stack:** plain HTML/CSS/JS + [Leaflet 1.9.4](https://leafletjs.com). **No build step, no framework, no bundler, no server.**

The entire app is the static files in the repo root. You edit a file, serve the
folder over HTTP, and reload. That is the whole loop — there is nothing to
compile or transpile.

> **One thing will trip you up:** a service worker aggressively caches the app.
> After editing, a normal reload often serves the **old** file. See
> [The service-worker gotcha](#3-the-service-worker-gotcha-read-this) before you
> waste an hour debugging a change that "didn't take."

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Running locally](#2-running-locally)
3. [The service-worker gotcha (read this)](#3-the-service-worker-gotcha-read-this)
4. [Project conventions](#4-project-conventions)
5. [Adding a new trail](#5-adding-a-new-trail)
6. [Testing](#6-testing)
7. [Deployment](#7-deployment)
8. [GitHub Pages constraints](#8-github-pages-constraints)
9. [Repository layout & what's ignored](#9-repository-layout--whats-ignored)

---

## 1. Prerequisites

There is no toolchain to install. You need:

| Tool | Why | Notes |
| --- | --- | --- |
| A modern browser | Run and test the app | Chrome/Edge recommended for DevTools + service-worker tooling; Safari for iPhone-accurate testing |
| **Python 3** | Serve the folder over HTTP | Any static file server works (see below). Python 3 ships with macOS and most Linux distros |
| **git** | Version control + deploy | Deployment is a `git push` (see [Deployment](#7-deployment)) |

There is **no `npm`, no `package.json`, no build/transpile step**. This is
intentional (see [Project conventions](#4-project-conventions)). If you find
yourself reaching for a bundler, stop — the project is meant to be served
verbatim.

---

## 2. Running locally

> **You must serve over HTTP. Do not open `index.html` via `file://`.**
> Service workers and `fetch()` of the GPX files require an `http(s)` origin.
> Under `file://` the service worker will not register and the trail detail
> screen will fail to load its GPX track.

From the repo root, start the project's standard dev server:

```bash
python3 -m http.server 8743
```

Then open:

```
http://localhost:8743/
```

`8743` is just the port this project uses by convention; any free port is fine.

**Any static file server works.** A few alternatives:

```bash
# Node (no install — uses npx)
npx serve -l 8743

# Node (alternative)
npx http-server -p 8743

# PHP
php -S localhost:8743
```

Stop the server with `Ctrl+C`. (Keep that in mind — stopping the server is also
how you [verify offline behavior](#6-testing).)

---

## 3. The service-worker gotcha (READ THIS)

**This is the single most common source of "my change isn't showing up."**

`sw.js` registers a service worker that caches the app shell — `index.html`,
`app.css`, `app.js`, `trails.js`, `i18n.js`, `manifest.json`, the PNG icons, the
Leaflet assets, and all bundled GPX + hero images — using a **cache-first**
strategy. That is exactly what makes the app work offline, but during
development it means:

> After you edit `app.js`, `app.css`, `index.html`, `trails.js`, `i18n.js`,
> etc., a normal reload serves the **stale cached version**. Your change is on
> disk but the SW hands the browser the old copy.

To see your change you must **unregister the service worker and delete its
caches**, then reload.

### Option A — DevTools console snippet (fastest)

Paste this into the DevTools **Console** on the running app, then let it reload:

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

This unregisters every service worker for the origin, deletes **all** caches
(both the app-shell cache and the downloaded map-tile cache), and reloads.

### Option B — DevTools UI

**Application → Storage → Clear site data** (click the **Clear site data**
button). This wipes service workers, Cache Storage, localStorage, etc. for the
origin in one click. Then reload.

> Tip: While actively iterating, open DevTools → **Application → Service
> Workers** and tick **"Update on reload"** (and optionally **"Bypass for
> network"**). With these on, each reload re-fetches from the network and
> activates the new worker, which sidesteps most of the staleness. Still do a
> full **Clear site data** before any final verification so you're testing what
> a real user gets.

### Shipping updates the right way: bump `APP_V`

For **returning users**, the correct way to force everyone onto a new version on
deploy is to bump the cache version constant at the top of `sw.js`:

```js
const APP_V  = 'wa-trails-app-v9';   // ← bump this (…-v10, …-v11) when you ship shell changes
const TILE_V = 'wa-trails-tiles-v1'; // map-tile cache; bump only if tile handling changes
```

On `activate`, the worker deletes every cache whose key isn't the current
`APP_V` / `TILE_V`:

```js
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k!==APP_V && k!==TILE_V).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});
```

So changing `APP_V` from `wa-trails-app-v9` to `wa-trails-app-v10` invalidates
the old app-shell cache for all users and re-precaches the new shell on next
load. **Bump `APP_V` whenever you change shell files** (`index.html`, `app.css`,
`app.js`, `trails.js`, `i18n.js`, or the bundled asset lists). Leave `TILE_V`
alone unless you change how tiles are cached — bumping it throws away users'
downloaded offline maps.

> The console snippet / Clear site data is for **your** machine during dev.
> Bumping `APP_V` is for **users** on deploy. They are not interchangeable.

---

## 4. Project conventions

Read the existing files and match their style — there is no linter or formatter
config to enforce anything, so consistency is by convention. What's actually in
the codebase:

- **Vanilla ES, in the browser, no modules/bundler.** Scripts are plain
  `<script src="…">` tags in `index.html`, loaded in order: Leaflet → `i18n.js`
  → `trails.js` → `app.js`. There is no `import`/`export`; code shares state
  through the global scope.
- **`'use strict';`** at the top of `app.js`.
- **Single quotes** for strings throughout. Template literals (backticks) are
  used for HTML generation and interpolation.
- **Semicolons are used** — statements terminate with `;`. (Don't omit them;
  match the file.)
- **Compact formatting.** Short helpers are frequently one-liners; related
  declarations are packed onto a single line (e.g.
  `let map = null, curTrail = null;`). Indentation is **2 spaces**.
- **Section banners.** Major sections are separated by comment rules like:

  ```js
  // ════════════════════════════════════════════════════════════
  //  Detail screen
  // ════════════════════════════════════════════════════════════
  ```

- **Query helpers.** Two tiny DOM helpers are defined once and used everywhere
  instead of raw `document.querySelector`:

  ```js
  const $  = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];
  ```

  Use `$('#id')` for a single element and `$$('.sel')` for an array of elements.
- **Module-level state.** App state lives in a block of `let`/`const` near the
  top of `app.js` (e.g. `map`, `curTrail`, `trackPts`, `trackWpts`, `totalDist`,
  `gpsWatch`, `sheetState`, `dlState`). Functions read and mutate these
  directly. There is no state-management library and no classes — it's plain
  functions over shared module-scope variables.
- **Rendering is string templating.** Screens are (re)rendered by building HTML
  strings with template literals and assigning to `.innerHTML`
  (e.g. `renderList()`, `renderSheetBody()`), then wiring up event listeners
  afterward.
- **Constants up top.** Tunables live as `const`s at the top of `app.js`:
  `TILE_CACHE`, `DL_ZOOMS`, `padFor(z)`, `FT`, plus the `TILE_SOURCES` map (the two
  basemaps — `usgs` and `gsi`) and the `trailSource(trail)` helper that picks one
  per trail. Reuse them rather than hard-coding values.
- **CSS custom properties** drive theming in `app.css` (`:root { --bg-0, --blue,
  --safe-t, … }`), including iOS safe-area insets. The design is dark,
  mobile-first, and responsive (portrait + landscape).
- **Bilingual by construction (`i18n.js`).** The app is Japanese-by-default with
  an EN toggle, and all text/units live in `window.I18N` (`i18n.js`). **Hard
  rule: any user-facing string must be added to BOTH `en` and `ja`** in
  `i18n.js` — never hard-code a display string in `app.js`/`index.html`. Static
  strings go in `I18N.ui.{en,ja}` and are referenced with `t('key')`;
  interpolated strings go in `I18N.fn.{en,ja}` as functions called via
  `tf('key')(args)`. See [`docs/I18N.md`](./I18N.md) for the full structure and
  helpers (`loc`, `trDiff`, `fmtDist`, …).
- **`data-i18n` attribute convention.** Static translatable text in
  `index.html` carries a `data-i18n="key"` (or `data-i18n-aria="key"` for
  `aria-label`s); `applyStaticI18n()` swaps the text/attribute on load and on
  every language switch. The HTML carries the **Japanese** default inline so the
  first paint is correct before JS runs (e.g.
  `<h1 data-i18n="appName">梅ちゃんのトレイル</h1>`).
- **Never name a global `L`** — that's Leaflet's global. The trail-localization
  helper is `loc()` (an earlier `function L(trail)` shadowed Leaflet and broke
  the map). See the naming caution in [`docs/I18N.md`](./I18N.md).

**There is intentionally no framework, transpiler, or build step.** Keep new
code in the same plain-ES, no-dependency style. New third-party libraries should
be a deliberate decision, not a reflex — every added asset has to be cached for
offline and counts against the [GitHub Pages limits](#8-github-pages-constraints).

---

## 5. Adding a new trail

This is the most important contributor workflow. A trail is the sum of several
coordinated edits: a GPX file, a hero image, an English data object (with a
`tiles` field for non-US trails), a **Japanese translation block**, and a
service-worker precache entry. Miss any one and the trail will look broken,
won't work offline, or shows English text in Japanese mode.

> The detailed data-extraction / sourcing pipeline (how trail stats, GPX, and
> photos are obtained and processed) lives in
> [`docs/DATA-PIPELINE.md`](./DATA-PIPELINE.md). Translation conventions live in
> [`docs/I18N.md`](./I18N.md). This section covers wiring an already-sourced
> trail into the app.

Pick a **slug** first — a lowercase, hyphenated id (e.g. `lake-22`,
`snow-lake`). It's used as the trail's identity in the data, the URL hash
(`#/trail/<slug>`), and to track offline status. Use it consistently below.

### a. Add the GPX file

Place the track in the **`gpx/`** directory:

```
gpx/My_New_Trail.gpx
```

The app parses standard GPX: `<trkpt lat lon>` track points (with optional
`<ele>`) and optional `<wpt>` waypoints (with `<name>`). The exact file name
doesn't have to match the slug, but it must match the `gpx:` path you set in the
trail object **and** the path you add to the service worker (steps c and d).

### b. Add the hero image

Produce a hero photo and place it in **`images/`** named after the slug:

```
images/<slug>.webp
```

- **Format/size:** `.webp`, **1200×800** recommended. Existing heroes are
  ~200–315 KB each — keep new ones in that ballpark to respect the
  [size budget](#8-github-pages-constraints).
- The file path must match the `img:` field (step c) and the service-worker
  precache entry (step d).

### c. Add the trail object to `window.TRAILS`

Append an object to the `window.TRAILS` array in **`trails.js`**. **Every field
below is required** (except `tiles`, which is optional — see the row) — the list
cards and detail screen read all of them, and a missing field renders as
`undefined`. Copy an existing entry and edit it.

| Field | Type | Description / allowed values |
| --- | --- | --- |
| `slug` | string | Lowercase-hyphenated id; must be unique. Drives the `#/trail/<slug>` route. |
| `name` | string | Display name (e.g. `"Lake 22 Trail"`). |
| `area` | string | Location label (e.g. `"Granite Falls, WA"`). |
| `img` | string | Path to hero image — `"images/<slug>.webp"` (matches step b). |
| `gpx` | string | Path to GPX — `"gpx/My_New_Trail.gpx"` (matches step a). |
| `tiles` | string | **Optional.** Basemap source. **Omit for US trails** (defaults to USGS topo). Set to `"gsi"` for trails **outside the US** (e.g. Japan) to use the **GSI 地理院タイル** basemap. `app.js` resolves it via `trailSource(trail)` (the `TILE_SOURCES` map), so both the live map and the offline tile download use the chosen source automatically. |
| `lengthMi` | number | Length in miles, e.g. `6.1`. Used for the **Distance** sort. |
| `gainFt` | number | Elevation gain in feet, e.g. `1456`. Used for the **Elevation** sort. |
| `diff` | string | **Exactly one of** `"Easy"`, `"Moderate"`, `"Hard"`, `"Very Hard"`. Drives the difficulty badge **and** the filter chips. Note: the **Easy filter chip was removed** (no current trail is Easy), so an `"Easy"` trail still gets a badge but no chip will match it — the filter chips are **All / Moderate / Hard / Very Hard**. Any other value won't match a filter and gets a default badge style. |
| `route` | string | Route type, e.g. `"Out & back"`, `"Loop"`, `"Point to point"`. (`"Loop"` suppresses the separate "End" marker on the map.) |
| `time` | string | Estimated time, e.g. `"3 h 17 min"`. |
| `season` | string | Best season, e.g. `"Apr – Nov"`. |
| `dogs` | string | Dog policy, e.g. `"Leashed"`, `"Not allowed"`. |
| `permit` | string | Permit/fee info. |
| `center` | `[lat, lon]` | Map center as a 2-element array of numbers, e.g. `[48.0700, -121.7555]`. Used as the initial map center and for the offline-status tile probe. |
| `summary` | string | One- or two-sentence overview (shown in the "Overview" section). |
| `description` | string | Longer prose for the "The hike" section. |
| `tips` | `string[]` | Array of short bullet strings for "Tips & need-to-know". |

Example skeleton:

```js
{
  slug: "my-new-trail",
  name: "My New Trail",
  area: "Somewhere, WA",
  img: "images/my-new-trail.webp",
  gpx: "gpx/My_New_Trail.gpx",
  // tiles: "gsi",   // ← add this ONLY for a non-US (e.g. Japan) trail; omit for US (USGS)
  lengthMi: 5.0, gainFt: 1200, diff: "Moderate",
  route: "Out & back", time: "3 h 00 min",
  season: "Jun – Oct", dogs: "Leashed",
  permit: "NW Forest Pass",
  center: [47.5000, -121.5000],
  summary: "Short overview shown at the top of the detail sheet.",
  description: "Longer narrative description of the hike.",
  tips: [
    "First tip.",
    "Second tip."
  ]
}
```

> **Non-US trails:** set `tiles: "gsi"` so the map and the offline download use
> the **GSI 地理院タイル** basemap (free, no API key, CORS-enabled, with Japanese
> topographic labels) instead of USGS topo. Both Japan trails
> (`fuji-yoshida`, `kinpu-odarumi`) carry `tiles: "gsi"`; the eight Washington
> trails omit `tiles` and fall back to USGS.

> The list header `subtitle` no longer shows a trail count. It is a static
> string — `ui.en` `"Tap a trail to explore"` / `ui.ja` `"タップして探索"` in
> `i18n.js`, with the Japanese default inlined on the `data-i18n="subtitle"`
> node in `index.html` for first paint — so adding or removing a trail needs no
> subtitle edit.

### d. Add the Japanese translation block to `i18n.js`

**Required.** Add a Japanese block to `I18N.trails` in **`i18n.js`**, keyed by
the **same slug** as the English object:

```js
I18N.trails = {
  // …existing entries…
  "my-new-trail": { ja: {
    name:        "…",   // katakana transliteration of the trail name
    area:        "…（ワシントン州）",
    summary:     "…",
    description: "…",
    permit:      "…",
    tips: [ "…", "…" ],
  }},
};
```

Translate the six text fields (`name, area, summary, description, permit,
tips`). Everything else (stats, coords, and the enum *values* like
`"Moderate"`) stays in `trails.js` and is localized through the enum tables.
Also translate any **new GPX waypoint names** by adding `English → Japanese`
entries to `I18N.wpt`.

> Without this block the trail still works — `loc()` falls back to the English
> base field-by-field — but it shows **English text in Japanese mode**, which
> defeats the purpose. Follow the translation conventions (katakana names,
> natural prose, です・ます調, metric units woven in) in
> [`docs/I18N.md`](./I18N.md).

### e. Precache the new assets in `sw.js`

So the trail works **offline**, add **both** the GPX path and the image path to
the `TRAIL_ASSETS` array in **`sw.js`** (it currently lists all **12** trails'
GPX + images, grouped Washington then Japan):

```js
const TRAIL_ASSETS = [
  // …existing entries…
  'gpx/My_New_Trail.gpx',
  'images/my-new-trail.webp',
];
```

These are precached on service-worker `install` (best-effort) and also filled on
first network fetch. If you skip this step, the trail still works **online**,
but its GPX/photo won't be guaranteed available offline.

> Paths in `sw.js` are relative to the site root, with **no leading `./`** for
> trail assets (e.g. `gpx/...`, `images/...`) — match the existing entries.

### f. (Optional but recommended) bump `APP_V`

Editing `trails.js`, `i18n.js`, and the precache list is a shell change. To make
returning users pick it up on deploy, bump `APP_V` in `sw.js` (currently
`wa-trails-app-v9`, so bump to the next version — see
[the SW section](#3-the-service-worker-gotcha-read-this)):

```js
const APP_V = 'wa-trails-app-v10';
```

### Verify the new trail locally

1. Run the server (`python3 -m http.server 8743`).
2. **Clear site data** (the SW will otherwise serve the old `trails.js`/`i18n.js`).
3. Confirm the new card appears in the list, the filter chip for its difficulty
   includes it (All / Moderate / Hard / Very Hard), and both sorts place it
   correctly.
4. Open it and confirm the map draws the track, the elevation profile renders,
   and the hero image loads. For a `tiles: "gsi"` trail, confirm the **GSI 地理院
   タイル** basemap renders (Japanese topo labels) rather than USGS, and that the
   map attribution line in the Details section shows the GSI credit.
5. **Toggle to Japanese** (the EN/日本語 button) and confirm the name, area,
   summary, description, tips, and any waypoint labels render in Japanese (no
   English fallback). The app defaults to Japanese, so also confirm the EN
   toggle shows the English base correctly.
6. Run the [offline check](#6-testing).

---

## 6. Testing

**There are no automated unit tests.** Verification is **manual browser
testing**, performed via Chrome DevTools (including DevTools automation/driving
the page). Test at iPhone-like viewports in **both orientations**:

| Orientation | Viewport (W×H) |
| --- | --- |
| Portrait | **390 × 844** |
| Landscape | **844 × 390** |

(Set these via DevTools device toolbar / `Emulation`. The landscape layout has
its own branch in the bottom-sheet code, so test it explicitly.)

**Test both languages.** The app is **Japanese by default**; use the EN/日本語
toggle (top-right of the list) to switch and re-check the screens in **both**
languages — text, units (km/m vs mi/ft), difficulty/route labels, marker
popups, and the global "Save maps" button label all change. Dev tip: the chosen
language is persisted in `localStorage.lang`, so to test the first-run default,
reset it with `localStorage.removeItem('lang')` (in the DevTools console) and
reload — it should come up in Japanese.

### Functional checklist

**List screen**

- [ ] The list renders **10 cards** (one per trail in `TRAILS` — 8 Washington +
      2 Japan).
- [ ] Difficulty filter chips (**All / Moderate / Hard / Very Hard** — there is
      no "Easy" chip) filter correctly; "All" shows everything.
- [ ] **↕ Distance** and **↕ Elevation** sorts reorder the cards; tapping an
      active sort chip again clears the sort.
- [ ] Cards show distance, gain, route, and **time** (star ratings were removed; the time
      occupies the slot where the star used to be). (There is **no** per-card
      offline ✓ badge anymore — offline maps are handled by one global button,
      below.)
- [ ] The header's global **⬇ Save maps** button (`#dl-all`, next to the
      language toggle) downloads tiles for **all 10 trails across both sources**:
      it goes idle → a live `NN%` → **✓ Maps saved**.

**Detail screen**

- [ ] Tapping a card routes to `#/trail/<slug>` and opens the detail screen.
- [ ] The GPX loads — i.e. `trackPts` is populated (the red track line appears
      on the map). If `trackPts` is empty, the GPX failed to fetch/parse.
- [ ] The **elevation profile** SVG draws, with the elevation range label.
- [ ] **Map tiles load** — USGS topo for Washington trails, **GSI 地理院タイル**
      for Japan trails (`tiles: "gsi"`).
- [ ] Trailhead/endpoint and waypoint markers appear. (Both Japan trails
      have **no GPX waypoints** — only trailhead/end markers, and Loop routes
      suppress the separate "End" marker.)
- [ ] The bottom sheet drags between peek and full; the GPS FAB repositions
      correctly in both orientations.
- [ ] **GPS dot:** tap the ◎ button → location permission prompt → blue GPS dot
      + accuracy circle appear and follow your position; tapping again
      recenters, then stops. (GPS needs a real location source; the simulated
      sensors in DevTools can stand in.)
- [ ] The Details section's attribution line shows the correct map credit for
      the trail's source (USGS for US, GSI for Japan).

**Language (run the above in both EN and JA)**

- [ ] First load with no stored preference (`localStorage.removeItem('lang')`)
      comes up in **Japanese**.
- [ ] The EN/日本語 toggle switches every screen live: list cards, the detail
      title/peek/sheet, stat units (km/m ↔ mi/ft), difficulty/route/dogs labels,
      season/time strings, and the map marker popups (trailhead/end + waypoints).
- [ ] No untranslated English leaks through in Japanese mode (a missing
      `I18N.trails[slug].ja` field or `I18N.wpt` entry shows English).

### Offline verification (do this — it's the whole point of the app)

1. With the app loaded, tap the header's global **⬇ Save maps** button
   (`#dl-all`) and **wait for it to read ✓ Maps saved**. This downloads tiles
   for **all 10 trails** across **both** sources (USGS + GSI) into the tile
   cache in one pass.
2. Go offline: either **stop the local server** (`Ctrl+C`) or, in Chrome
   DevTools, **Network → Offline**.
3. **Reload** the page.
4. Confirm the **app still loads** — the shell (HTML/CSS/JS), trail data, GPX,
   and hero images all come from the service-worker cache.
5. Open **any** trail (a Washington one *and* a Japan one) and confirm its **map
   tiles still render** from the tile cache — USGS topo for the US trail, GSI
   地理院タイル for the Japan trail.
6. Go back online (restart the server / untick Offline) when done.

If the app fails to load with the server stopped, the service worker isn't
caching the shell correctly — check `SHELL` / `TRAIL_ASSETS` in `sw.js` and the
DevTools **Application → Cache Storage** entries.

> **GSI tiles in local dev:** the GSI 地理院タイル endpoint is free, keyless, and
> CORS-enabled, and loads fine from a normal browser on a home/office network.
> It may return **HTTP 403 from datacenter IPs**, but that won't affect local
> dev on a residential connection. If GSI tiles fail to download, check you're
> not on a flagged network before suspecting the code.

> **Optional:** a Lighthouse PWA/perf pass in DevTools is a reasonable
> additional smoke test, but it is not part of the required flow.

---

## 7. Deployment

Deployment is **a `git push` to `main`** — GitHub Pages serves the repository
root.

```bash
git add -A
git commit -m "Add <thing>"
git push origin main
```

Within a minute or so, GitHub Pages republishes:

```
https://huangwaylon.github.io/gpx/
```

Key points:

- **GitHub Pages serves the repo root of `main`.** There is no build; files are
  served verbatim (this is why there's no build step to configure).
- **`.nojekyll`** (an empty file in the root) **disables Jekyll processing.**
  Without it, GitHub Pages would run files through Jekyll and **ignore files/
  folders whose names start with `_`** (and apply other Jekyll behavior). The
  `.nojekyll` file guarantees everything is served as-is. **Keep it.**
- **Enable Pages once** in the repo: **Settings → Pages → Build and deployment →
  Source: Deploy from a branch → Branch: `main` / root (`/`)**.
- **Returning users + caching:** because of the service worker, shipping a code
  change is not enough on its own for users who've already loaded the app — also
  **bump `APP_V`** in `sw.js` so their cached shell is invalidated (see
  [the SW section](#3-the-service-worker-gotcha-read-this)).
- **The `alltrails/` source is partly committed.** It used to be git-ignored; the
  `.html` + `.gpx` exports (~8 MB) are now tracked for provenance, while the heavy
  `.webarchive` captures stay git-ignored (they embed third-party secret tokens — see
  §8/§9). None of it is referenced or served by the app.

---

## 8. GitHub Pages constraints

Stay within GitHub Pages' published limits:

| Limit | Value | Implication |
| --- | --- | --- |
| **Per-file size** | **100 MB hard limit** | No single committed file may exceed this. (Largest committed file is ~0.6 MB — `gpx/The_Enchantments_Traverse.gpx`.) A file over 100 MB makes `git push` fail. |
| **Repository size** | **1 GB soft limit** | Keep the repo reasonable. The deployed app is **~5 MB**; with the committed `alltrails/` `.html`/`.gpx` source (~8 MB) the whole repo is **~13 MB** — well under 1 GB. |
| **Bandwidth** | **100 GB / month (soft)** | Fine for this app's traffic; just don't host huge downloads here. |

The `alltrails/` source folder holds saved AllTrails pages. The `.html` + `.gpx`
exports (~8 MB) are **committed** for provenance; the heavy `.webarchive` captures
(~45 MB) are **git-ignored** — they embed third-party secret tokens (a Mapbox token)
that GitHub's **secret-scanning push protection** rejects, so committing one makes
`git push` fail. Only the ~5 MB app (HTML/CSS/JS + `gpx/` + `images/` + a few small
files) actually ships to users. When adding new source captures, keep webarchives out
and watch the per-file limit:

```bash
du -sh .                      # whole repo, incl .git
du -sh alltrails gpx images   # source vs deployed assets
find . -path ./.git -prune -o -type f -size +90M -print   # anything near the 100 MB cap
```

> Map **tiles are not in the repo.** They're fetched on demand from **USGS**
> (US trails) and **GSI 地理院タイル** (Japan trails) and cached client-side (in
> the browser's Cache Storage) when a user taps the global **Save maps** button.
> They never count against repo size.

---

## 9. Repository layout & what's ignored

### Layout

```
gpx/                     # ← repo root, served as-is by GitHub Pages
├── index.html           # App shell: list + detail screens (data-i18n keys, JA inline)
├── app.css              # Dark, mobile-first, responsive styles (CSS custom props)
├── app.js               # Routing, Leaflet map, GPX parsing, GPS, elevation, tile download, i18n helpers
├── i18n.js              # UI strings + per-trail Japanese translations (window.I18N)
├── trails.js            # window.TRAILS — trail metadata, English base content (edit to add trails)
├── sw.js                # Service worker: offline caching (SHELL + TRAIL_ASSETS, APP_V/TILE_V)
├── manifest.json        # PWA manifest (name, icons, standalone display)
├── icon-180/192/512.png # App icon (apple-touch-icon + manifest) — Enchantments photo crop
├── .nojekyll            # Disables Jekyll on GitHub Pages (serve files verbatim)
├── README.md            # User-facing overview
├── gpx/                 # GPX track files (one per trail)
├── images/              # Hero photos (<slug>.webp, ~1200×800)
├── docs/
│   ├── ARCHITECTURE.md          # Canonical, code-grounded design reference
│   ├── DATA-PIPELINE.md         # Trail data sourcing/extraction pipeline (see §5)
│   ├── DECISIONS-AND-LESSONS.md # ADRs + bugs/lessons from the build
│   ├── DEVELOPMENT.md           # ← this file
│   ├── I18N.md                  # Internationalization: window.I18N, helpers, conventions
│   ├── IOS-PWA-GUIDE.md         # Offline/GPS/install/caching + iOS behavior
│   └── README.md                # Docs index
└── alltrails/           # AllTrails source — .html/.gpx committed (~8 MB); .webarchive git-ignored (secrets)
```

> Note: the load order in `index.html` matters — Leaflet loads first, then
> `i18n.js` (defines `window.I18N`), then `trails.js` (defines `window.TRAILS`),
> then `app.js` (consumes both). `i18n.js` is part of the app shell and is
> precached by the service worker.

### What's git-ignored

From `.gitignore` (`alltrails/` itself is **not** ignored — its `.html`/`.gpx` are committed;
only `.webarchive` saves are excluded):

| Pattern | What it excludes | Why |
| --- | --- | --- |
| `.DS_Store` | macOS Finder metadata | OS cruft |
| `*.webarchive` | Safari page archives under `alltrails/` | They embed third-party secret tokens (a Mapbox token) that GitHub push protection blocks; the `.html`/`.gpx` source is committed instead |
| `*.log` | Server / tooling logs | Build/run noise |

Run `git status` before committing to confirm only intended files are staged (`.DS_Store`,
`*.webarchive`, and `*.log` are ignored).
