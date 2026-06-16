# Development Guide — Washington Trails

Developer guide for **Washington Trails**, a static, offline-capable hiking PWA
for iPhone. It shows 8 Washington State trails with USGS topographic maps, GPX
tracks, live GPS, and elevation profiles.

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
`app.css`, `app.js`, `trails.js`, `manifest.json`, `icon.svg`, the Leaflet
assets, and all bundled GPX + hero images — using a **cache-first** strategy.
That is exactly what makes the app work offline, but during development it means:

> After you edit `app.js`, `app.css`, `index.html`, `trails.js`, etc., a normal
> reload serves the **stale cached version**. Your change is on disk but the SW
> hands the browser the old copy.

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
const APP_V  = 'wa-trails-app-v2';   // ← bump this (…-v3, …-v4) when you ship shell changes
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

So changing `APP_V` from `wa-trails-app-v2` to `wa-trails-app-v3` invalidates
the old app-shell cache for all users and re-precaches the new shell on next
load. **Bump `APP_V` whenever you change shell files** (`index.html`, `app.css`,
`app.js`, `trails.js`, or the bundled asset lists). Leave `TILE_V` alone unless
you change how tiles are cached — bumping it throws away users' downloaded
offline maps.

> The console snippet / Clear site data is for **your** machine during dev.
> Bumping `APP_V` is for **users** on deploy. They are not interchangeable.

---

## 4. Project conventions

Read the existing files and match their style — there is no linter or formatter
config to enforce anything, so consistency is by convention. What's actually in
the codebase:

- **Vanilla ES, in the browser, no modules/bundler.** Scripts are plain
  `<script src="…">` tags in `index.html`, loaded in order: Leaflet → `trails.js`
  → `app.js`. There is no `import`/`export`; code shares state through the global
  scope.
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
  `gpsWatch`, `sheetState`, `cacheStatus`). Functions read and mutate these
  directly. There is no state-management library and no classes — it's plain
  functions over shared module-scope variables.
- **Rendering is string templating.** Screens are (re)rendered by building HTML
  strings with template literals and assigning to `.innerHTML`
  (e.g. `renderList()`, `renderSheetBody()`), then wiring up event listeners
  afterward.
- **Constants up top.** Tunables live as `const`s at the top of `app.js`:
  `TILE_URL`, `TILE_CACHE`, `DL_ZOOMS`, `PAD`, `FT`, `MI`. Reuse them rather than
  hard-coding values.
- **CSS custom properties** drive theming in `app.css` (`:root { --bg-0, --blue,
  --safe-t, … }`), including iOS safe-area insets. The design is dark,
  mobile-first, and responsive (portrait + landscape).

**There is intentionally no framework, transpiler, or build step.** Keep new
code in the same plain-ES, no-dependency style. New third-party libraries should
be a deliberate decision, not a reflex — every added asset has to be cached for
offline and counts against the [GitHub Pages limits](#8-github-pages-constraints).

---

## 5. Adding a new trail

This is the most important contributor workflow. A trail is the sum of **four
edits**: a GPX file, a hero image, a data object, and a service-worker precache
entry. Miss any one and the trail will look broken or won't work offline.

> The detailed data-extraction / sourcing pipeline (how trail stats, GPX, and
> photos are obtained and processed) lives in
> [`docs/DATA-PIPELINE.md`](./DATA-PIPELINE.md). This section covers wiring an
> already-sourced trail into the app.

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
below is required** — the list cards and detail screen read all of them, and a
missing field renders as `undefined`. Copy an existing entry and edit it.

| Field | Type | Description / allowed values |
| --- | --- | --- |
| `slug` | string | Lowercase-hyphenated id; must be unique. Drives the `#/trail/<slug>` route. |
| `name` | string | Display name (e.g. `"Lake 22 Trail"`). |
| `area` | string | Location label (e.g. `"Granite Falls, WA"`). |
| `img` | string | Path to hero image — `"images/<slug>.webp"` (matches step b). |
| `gpx` | string | Path to GPX — `"gpx/My_New_Trail.gpx"` (matches step a). |
| `rating` | number | Star rating, e.g. `4.7`. |
| `reviews` | number | Review count, e.g. `18454` (rendered with thousands separators). |
| `lengthMi` | number | Length in miles, e.g. `6.1`. Used for the **Distance** sort. |
| `gainFt` | number | Elevation gain in feet, e.g. `1456`. Used for the **Elevation** sort. |
| `diff` | string | **Exactly one of** `"Easy"`, `"Moderate"`, `"Hard"`, `"Very Hard"`. Drives the difficulty badge **and** the filter chips — any other value won't match a filter and gets a default badge style. |
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
  rating: 4.6, reviews: 1234,
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

> The `8 trails` count in the list header (`index.html`) and `README.md` is a
> hard-coded string, not computed from `TRAILS.length`. If you change the number
> of trails, update those copy strings too.

### d. Precache the new assets in `sw.js`

So the trail works **offline**, add **both** the GPX path and the image path to
the `TRAIL_ASSETS` array in **`sw.js`**:

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

### e. (Optional but recommended) bump `APP_V`

Editing `trails.js` and the precache list is a shell change. To make returning
users pick it up on deploy, bump `APP_V` in `sw.js` (see
[the SW section](#3-the-service-worker-gotcha-read-this)):

```js
const APP_V = 'wa-trails-app-v3';
```

### Verify the new trail locally

1. Run the server (`python3 -m http.server 8743`).
2. **Clear site data** (the SW will otherwise serve the old `trails.js`).
3. Confirm the new card appears in the list, the filter chip for its difficulty
   includes it, and both sorts place it correctly.
4. Open it and confirm the map draws the track, the elevation profile renders,
   and the hero image loads.
5. Run the [offline check](#6-testing).

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

### Functional checklist

**List screen**

- [ ] The list renders **8 cards** (one per trail in `TRAILS`).
- [ ] Difficulty filter chips (All / Easy / Moderate / Hard / Very Hard) filter
      correctly; "All" shows everything.
- [ ] **↕ Distance** and **↕ Elevation** sorts reorder the cards; tapping an
      active sort chip again clears the sort.
- [ ] Cards show distance, gain, route, rating; offline-ready cards show the ✓
      badge.

**Detail screen**

- [ ] Tapping a card routes to `#/trail/<slug>` and opens the detail screen.
- [ ] The GPX loads — i.e. `trackPts` is populated (the red track line appears
      on the map). If `trackPts` is empty, the GPX failed to fetch/parse.
- [ ] The **elevation profile** SVG draws, with the elevation range label.
- [ ] **Map tiles load** (USGS topo).
- [ ] Trailhead/endpoint and waypoint markers appear.
- [ ] The bottom sheet drags between peek and full; the GPS FAB repositions
      correctly in both orientations.
- [ ] **GPS dot:** tap the ◎ button → location permission prompt → blue GPS dot
      + accuracy circle appear and follow your position; tapping again
      recenters, then stops. (GPS needs a real location source; the simulated
      sensors in DevTools can stand in.)
- [ ] **Download for offline:** the "Download map for offline" button opens the
      modal, shows a tile count, runs the progress bar to 100%, and flips to
      "✓ Map saved for offline" (and the list card gains its ✓ badge).

### Offline verification (do this — it's the whole point of the app)

1. With the app loaded and a trail's tiles **downloaded** (run the download flow
   first), **stop the local server** (`Ctrl+C`).
2. **Reload** the page.
3. Confirm the **app still loads** — the shell (HTML/CSS/JS), trail data, GPX,
   and hero images all come from the service-worker cache.
4. Open the trail you downloaded and confirm its **map tiles still render** from
   the tile cache (other, non-downloaded trails will show blank tiles offline —
   that's expected).
5. Restart the server when done.

If the app fails to load with the server stopped, the service worker isn't
caching the shell correctly — check `SHELL` / `TRAIL_ASSETS` in `sw.js` and the
DevTools **Application → Cache Storage** entries.

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
- **Push only the app, never the source material.** Confirm `git status` doesn't
  include the `alltrails/` folder (it's git-ignored — see below).

---

## 8. GitHub Pages constraints

Stay within GitHub Pages' published limits:

| Limit | Value | Implication |
| --- | --- | --- |
| **Per-file size** | **100 MB hard limit** | No single committed file may exceed this. (Largest current file is `gpx/The_Enchantments_Traverse.gpx` at ~626 KB — comfortably fine.) |
| **Repository size** | **1 GB soft limit** | Keep the repo lean. The deployed app is **only ~3.4 MB**. |
| **Bandwidth** | **100 GB / month (soft)** | Fine for this app's traffic; just don't host huge downloads here. |

The reason the repo stays tiny: the **`alltrails/` source folder (~166 MB** of
AllTrails HTML/webarchive source material) **is git-ignored and must never be
committed.** Only the ~3.4 MB app (HTML/CSS/JS + `gpx/` + `images/` + a few small
files) is deployed. Before committing, sanity-check that you're not about to add
large source files:

```bash
git status                       # alltrails/ should NOT appear
du -sh --exclude=.git --exclude=alltrails .   # deployed app size (~3.4 MB)
```

> Map **tiles are not in the repo.** They're fetched on demand from USGS and
> cached client-side (in the browser's Cache Storage) when a user taps
> "Download map for offline." They never count against repo size.

---

## 9. Repository layout & what's ignored

### Layout

```
gpx/                     # ← repo root, served as-is by GitHub Pages
├── index.html           # App shell: list + detail screens
├── app.css              # Dark, mobile-first, responsive styles (CSS custom props)
├── app.js               # Routing, Leaflet map, GPX parsing, GPS, elevation, tile download
├── trails.js            # window.TRAILS — all trail metadata (edit to add trails)
├── sw.js                # Service worker: offline caching (SHELL + TRAIL_ASSETS, APP_V/TILE_V)
├── manifest.json        # PWA manifest (name, icons, standalone display)
├── icon.svg             # App icon (also Apple touch icon)
├── .nojekyll            # Disables Jekyll on GitHub Pages (serve files verbatim)
├── README.md            # User-facing overview
├── gpx/                 # GPX track files (one per trail)
├── images/              # Hero photos (<slug>.webp, ~1200×800)
├── docs/
│   ├── DEVELOPMENT.md   # ← this file
│   └── DATA-PIPELINE.md # Trail data sourcing/extraction pipeline (see §5)
└── alltrails/           # Source material (~166 MB) — GIT-IGNORED, never deployed
```

> Note: the load order in `index.html` matters — Leaflet loads first, then
> `trails.js` (defines `window.TRAILS`), then `app.js` (consumes it).

### What's git-ignored

From `.gitignore`:

| Pattern | What it excludes | Why |
| --- | --- | --- |
| `alltrails/` | The ~166 MB AllTrails source folder | Large source material; not part of the app (see [§8](#8-github-pages-constraints)) |
| `.DS_Store` | macOS Finder metadata | OS cruft |
| `*.webarchive` | Safari web archive files | Editor/OS cruft, part of the source-scraping workflow |
| `*.log` | Server / tooling logs | Build/run noise |

Always run `git status` before committing to confirm none of these (especially
`alltrails/` and stray `*.webarchive` files) are staged.
