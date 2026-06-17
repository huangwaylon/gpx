# iOS Safari PWA Constraints — Ume-chan's Trails (梅ちゃんのトレイル)

A platform-constraints reference for **Ume-chan's Trails** (梅ちゃんのトレイル), an offline-capable hiking PWA targeting **iPhone Safari**, served as a static site on **GitHub Pages**. The app is bilingual — **Japanese by default with an English toggle** (see *Internationalization (i18n)* below and `docs/I18N.md`).

The app must keep working **with no cell signal on the trail** after being installed to the Home Screen. Stack: plain HTML / CSS / JS + Leaflet 1.9.4 + two topographic tile sources (USGS National Map for the US trails, GSI 地理院タイル for the Japan trails) + a classic service worker.

This document captures hard-won research about iOS Safari PWA behavior (2025/2026) and, for each constraint, exactly **how this app designs around it** — including honest notes where the app does **not** yet handle it (marked **GAP**).

> Scope note: "iOS" here means iOS/iPadOS Safari and Home-Screen web apps. Because Apple requires all iOS browsers to use the system WebKit, the engine-level constraints below apply to Chrome/Edge/Firefox on iOS too.

---

## Summary table

| Constraint | iOS behavior | How this app addresses it |
|---|---|---|
| **Service workers** | Supported in Safari tabs + Home-Screen PWAs since iOS 11.1. **Not** available in WKWebView / in-app browsers. | Registers `./sw.js` (classic SW) on `load`. Offline breaks inside in-app browsers — **recommend "Open in Safari"** (GAP: not detected/surfaced in-app). |
| **Background Sync / Periodic Sync / Background Fetch** | All **unsupported** on iOS. | Tile caching is **foreground & user-initiated** via a single global **"Save maps"** button — never background prefetch. |
| **SW ES modules / nested workers** | Modules need iOS 15+, nested workers 15.5/16.4. | App ships a **classic, non-module** SW — no `type:'module'`, no nested workers. |
| **Cache API** | Fully supported since iOS 11.1. | Used for **both** app shell (`wa-trails-app-v9`) and map tiles (`wa-trails-tiles-v1`, holding both USGS + GSI tiles). No IndexedDB. |
| **`watchPosition()` in background** | **No** background geolocation; JS suspends when screen locks / app is backgrounded. | GPS only works screen-on, foreground. App re-acquires Wake Lock on `visibilitychange`. **Document: keep screen on.** |
| **`navigator.permissions.query` for geolocation** | **Not** supported on iOS — cannot pre-check. | App skips pre-checks; handles `GeolocationPositionError.code === 1` in `onPosErr`. |
| **`navigator.wakeLock` (standalone)** | Broken in standalone on iOS 16.4–18.3; works in standalone only from **18.4+**. | Calls `wakeLock.request('screen')`, re-acquires on visibility change. **GAP: no video-loop fallback.** Advise raising Auto-Lock. |
| **`beforeinstallprompt`** | **Never fires** on iOS. | Installation is left to the user (Safari **Share → Add to Home Screen**); the app shows **no in-app install banner or prompt** and performs **no standalone detection**. |
| **7-day storage eviction** | iOS evicts **all** script-writable storage after 7 days of no interaction. `persist()` does **not** help. | `refreshCacheStatus()` re-checks a sample tile for every trail on startup and sets the single download button to "saved" only if all are present. Affects `localStorage` too (e.g. the `lang` preference resets to JA default). **GAP: no auto re-prompt** when tiles are gone. |
| **Manifest features** | `display:standalone` works; `fullscreen`/`minimal-ui` → standalone; `shortcuts`/`categories`/`screenshots` ignored; `id` needs iOS 17+. | Manifest uses `display:standalone` + `id:"/ume-trails"` and a Japanese `name`. Relies on Apple meta tags for capability; ships **both** `mobile-web-app-capable` and `apple-mobile-web-app-capable`. |
| **Splash screen** | Auto-generated from `background_color` + icon; no manifest control. | Sets `background_color:#0f172a`; accepts the auto splash. |
| **`navigator.connection`** | Network Information API unsupported. | App relies on cache-first SW + `navigator.onLine` semantics (see Other quirks). |
| **Input font-size < 16px** | iOS auto-zooms the page on focus of < 16px controls. | App has **no text inputs**, so the trap is effectively N/A — see note. |
| **Notch / home indicator** | Needs `viewport-fit=cover` + `env(safe-area-inset-*)`. | Both present: `viewport-fit=cover` in `index.html`, `--safe-*` vars in `app.css`. |

---

## Service Workers

### iOS behavior
- Service workers have been supported in **iOS Safari 11.1+**, both in normal browser tabs and in Home-Screen ("standalone") PWAs.
- **They are NOT available inside `WKWebView` / in-app browsers** — i.e. when a link is opened inside another app (Messages, Mail, Instagram, Slack, the in-app browsers of most social apps). In that context `navigator.serviceWorker` is unavailable, so **the app cannot cache or serve anything offline**. The site will appear to "work" while online and then break the moment there's no signal.
- **No Background Sync, no Periodic Background Sync, no Background Fetch.** A service worker on iOS only runs to handle `fetch`/lifecycle events while a controlled page is alive in the foreground. There is no mechanism to fetch or refresh data while the app is closed or backgrounded.
- **ES-module service workers** (`navigator.serviceWorker.register(url, { type: 'module' })`) require **iOS 15+**; **nested workers** (a worker spawning another) require **iOS 15.5 / 16.4**.

### How this app handles it
- The app registers a **classic (non-module)** service worker after `load`, guarded by a feature check:

  ```js
  // app.js — boot
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  ```

  Because registration uses no `type:'module'` and the SW spawns no nested workers, it runs on every iOS version that supports SWs at all (11.1+). This is a deliberate floor-setting choice for an app whose entire value proposition is offline reliability.

- Because **there is no Background Fetch/Sync on iOS**, the app never tries to prefetch tiles in the background. The **only** way map tiles enter the cache is a **foreground, user-initiated** download (the single global **"Save maps"** button — see *The offline strategy*). This is not a stylistic choice; it is the **direct consequence** of the missing background APIs.

- **GAP — in-app browser detection.** The app does not currently detect when it is running inside a WKWebView/in-app browser, and does not surface an "Open in Safari" hint. Inside such browsers offline support silently won't work.
  **Recommendation:** detect the lack of SW support and/or the in-app-browser UA and show a one-line banner: *"For offline maps, open this page in Safari (• • • → Open in Safari)."* A pragmatic heuristic:

  ```js
  const noSW = !('serviceWorker' in navigator);
  const inApp = /(FBAN|FBAV|Instagram|Line|Twitter|GSA)/.test(navigator.userAgent);
  if (noSW || inApp) showOpenInSafariHint();
  ```

---

## Cache API

### iOS behavior
The **Cache API** (`caches.open`, `cache.put`, `cache.match`, `cache.addAll`) is **fully supported since iOS 11.1** and is the storage primitive of choice for PWAs. It can store opaque cross-origin responses (important for third-party tiles).

### How this app handles it
The app uses the Cache API for **everything** persistent and uses **no IndexedDB**. There are exactly **two caches**, both keyed by version string so they can be rotated independently:

| Cache name (constant) | Contents | Population strategy |
|---|---|---|
| **`wa-trails-app-v9`** (`APP_V` in `sw.js`) | App shell + bundled trail data | `addAll` on SW `install` (shell), plus best-effort `add` of GPX + hero images; topped up on cache miss at runtime. |
| **`wa-trails-tiles-v1`** (`TILE_V` in `sw.js`, `TILE_CACHE` in `app.js`) | Map tiles — USGS topo (US trails) **and** GSI 地理院タイル (Japan trails) | Filled cache-first on `fetch`, and bulk-filled by the user-initiated "Save maps" download. |

`sw.js` declarations:

```js
const APP_V  = 'wa-trails-app-v9';
const TILE_V = 'wa-trails-tiles-v1';
```

**App-shell cache (`APP_V`).** On `install` the SW precaches the shell (HTML, CSS, JS, manifest, icon, and Leaflet's JS/CSS from unpkg). The shell `addAll` is treated as **must-succeed**; the bundled trail assets are added **best-effort** so a single failed asset cannot abort installation:

```js
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_V);
    await c.addAll(SHELL);                                   // shell must succeed
    await Promise.allSettled(TRAIL_ASSETS.map(u => c.add(u)));// assets best-effort
    self.skipWaiting();
  })());
});
```

The `activate` handler deletes any cache that is **not** one of the two current versions, so bumping `APP_V`/`TILE_V` cleanly evicts stale data:

```js
const keys = await caches.keys();
await Promise.all(keys.filter(k => k!==APP_V && k!==TILE_V).map(k => caches.delete(k)));
```

**Tile cache (`TILE_V`).** Served cache-first; both `ok` and opaque (`res.type === 'opaque'`) responses are stored, so tiles persist regardless of CORS outcome. In practice both sources are CORS-enabled and fetched with `{ mode: 'cors' }`, so tiles are cached as **real (non-opaque)** responses (see *The offline strategy* for the fetch handler).

---

## Geolocation

### iOS behavior
- **`watchPosition()` works only in the foreground with the screen on.** iOS suspends page JavaScript when the screen locks or the app is backgrounded, so the watch stops delivering positions. **There is no background geolocation for web content on iOS** — none of the native "always" / significant-location-change capabilities are exposed to the web.
- **`navigator.permissions.query({ name: 'geolocation' })` does NOT work on iOS.** The Permissions API either lacks `geolocation` or throws, so you **cannot pre-check** whether the user has granted/denied location. You only learn the state by *actually calling* the geolocation API and inspecting the result.

### How this app handles it
- GPS is **explicitly foreground-only.** `startGPS()` opens a high-accuracy watch and acquires a screen Wake Lock; `stopGPS()` clears the watch and releases the lock:

  ```js
  gpsWatch = navigator.geolocation.watchPosition(
    onPos, onPosErr, { enableHighAccuracy:true, maximumAge:4000, timeout:30000 });
  ```

  Because the watch dies when the screen sleeps, **the app cannot track you with the screen off.**
  **User guidance to document in-product:** *Keep your screen on while navigating; the blue dot stops updating when the phone sleeps.* (The app already tries to prevent sleep via Wake Lock — see next section — but Wake Lock itself is unreliable on older iOS, so the manual guidance still matters.)

- Instead of pre-checking permission (impossible on iOS), the app **reacts to the error**. `watchPosition`'s error callback inspects the standard `GeolocationPositionError` code; **code `1` is `PERMISSION_DENIED`**:

  ```js
  function onPosErr(err){
    if (err.code === 1){   // PERMISSION_DENIED
      alert('Location access denied. Enable it in Settings → Privacy → Location Services → Safari.');
      stopGPS();
    }
  }
  ```

  This is the correct iOS pattern: attempt the call, then handle denial after the fact.

- **Minor robustness note:** `onPosErr` handles only code `1`. Codes `2` (`POSITION_UNAVAILABLE`) and `3` (`TIMEOUT`) are ignored, so a transient timeout under tree cover currently produces no user feedback (the watch keeps trying, which is reasonable). Consider a soft "searching for GPS…" indicator for codes 2/3.

---

## Screen Wake Lock

### iOS behavior
- The **Screen Wake Lock API** (`navigator.wakeLock.request('screen')`) is **broken in standalone / Home-Screen PWA mode on iOS 16.4 – 18.3**: the API may exist but fails to actually keep the screen awake when launched from the Home Screen. It became reliable **in standalone mode only from iOS 18.4+**. (It generally works earlier in a normal Safari tab, but the app's target is the installed/standalone experience.)
- Net effect: on a large installed base of in-service iPhones (anything on iOS 16.4–18.3 running the app from the Home Screen), Wake Lock cannot be relied upon to keep the map visible during a hike.

### How this app handles it
- The app **does** call Wake Lock and re-acquires it when the page becomes visible again (e.g. after the user taps the screen back on), which covers iOS 18.4+ standalone and most tab usage:

  ```js
  async function reqWake(){ if('wakeLock' in navigator){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch(_){ } } }
  async function relWake(){ if(wakeLock){ try{ await wakeLock.release(); }catch(_){ } wakeLock=null; } }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && gpsWatch !== null && !wakeLock) reqWake();
  });
  ```

  `reqWake()` is fired from `startGPS()`, and the `visibilitychange` listener re-acquires the lock because **Wake Locks are auto-released whenever a page is hidden** — re-acquisition on return is required even on platforms where Wake Lock works.

- **GAP — no fallback for iOS < 18.4 standalone.** On 16.4–18.3 the `request()` call silently no-ops (the `catch(_)` swallows it), so the screen **will** sleep on schedule and GPS will stop. There is currently **no** fallback.
  **Recommendations:**
  1. **Silent looping `<video>` fallback** — the established hack for keeping iOS awake without Wake Lock: play a tiny, muted, `playsinline`, looping video while navigating. Start it alongside `reqWake()` when `wakeLock` ends up `null`, and pause it in `stopGPS()`/`relWake()`.

     ```js
     // sketch only — fallback when Wake Lock is unavailable/failed
     async function reqWake(){
       if ('wakeLock' in navigator){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch(_){} }
       if (!wakeLock) startKeepAwakeVideo();   // muted, playsinline, loop
     }
     ```
  2. **Advise raising Auto-Lock.** Surface a one-time tip: *Settings → Display & Brightness → Auto-Lock → Never (or a longer interval) while hiking.* This is the only fully reliable mitigation on affected iOS versions.

---

## Add to Home Screen / Install

### iOS behavior
- **There is no `beforeinstallprompt` event on iOS** and no programmatic install. Installation is **manual**: the user taps **Share → Add to Home Screen**. The app cannot trigger or even reliably detect availability of this flow — it can only *instruct* the user.
- **iOS 16.4+** additionally allows "Add to Home Screen" from third-party browsers (Chrome/Edge/Firefox), not just Safari. Before 16.4, only Safari could install.
- After install, a launched web app *can* be detected as standalone via the legacy `navigator.standalone` boolean and/or the standard `display-mode: standalone` media query — though this app no longer does so (see below).

### How this app handles it
- **No in-app install UI.** By product decision the app shows **no install banner or prompt at all**. Installation is left entirely to the user via Safari's native **Share → Add to Home Screen** gesture. The previous `#install` banner element, the `checkInstall()` function, and the `installDismiss` `localStorage` flag have all been **removed**.
- **No standalone detection.** Because there is no in-app install affordance to show or hide, the app **does not detect standalone mode at all** anymore — it neither reads `navigator.standalone` nor queries `matchMedia('(display-mode:standalone)')`. The `beforeinstallprompt` fact above is unchanged (it still never fires on iOS); the app simply no longer attempts any install-related UI around it.
  > For reference, the standard cross-version standalone check, were it ever needed again, is:
  > ```js
  > const standalone = window.navigator.standalone || matchMedia('(display-mode:standalone)').matches;
  > ```
- **Manual gesture is the whole flow.** There is nothing for the app to do here on iOS beyond shipping correct Apple meta tags (see *Web App Manifest specifics on iOS*) so that, once the user adds it to the Home Screen, it launches in standalone with the right icon and title (`梅ちゃんのトレイル`).

---

## Storage & the 7-day eviction rule

### iOS behavior
- iOS (WebKit ITP) **evicts ALL script-writable storage for an origin after 7 days without user interaction with that site.** This includes **Cache API, IndexedDB, OPFS, localStorage, and Service Worker registrations** — effectively everything a PWA can write.
- **`navigator.storage.persist()` does NOT override this on iOS.** Unlike some other platforms, requesting persistence does not exempt an origin from the 7-day timer. (Frequent foreground use *does* reset the clock — the eviction is specifically about *inactivity*.)
- Counterbalancing the eviction rule, **installed PWAs get a large quota**: on iOS 17+ roughly **~60% of device disk** is available to an installed web app, with an **~80% overall cap** shared across origins. So while data can *expire*, there is plenty of room to store map tiles in the first place.

### How this app handles it
- **Implication:** **downloaded map tiles can simply vanish after a week of not opening the app** — exactly the scenario where a user downloads a trail on Sunday and hikes it the *next* weekend. The app must not assume cached tiles are still present.
- **`localStorage` is evicted too.** The 7-day rule covers *all* script-writable storage, including `localStorage`. The only thing the app keeps there is the **language preference** (`localStorage.lang`), so after 7 days of non-use that preference can reset and the app falls back to its **Japanese default** on next launch — the same eviction mechanism that drops the tile cache also drops the saved language. This is benign (the user just re-toggles to English), but worth knowing when reasoning about "why did my settings reset." See *Internationalization (i18n)* and `docs/I18N.md`.
- The app **verifies cache state on every startup** rather than trusting it. `refreshCacheStatus()` runs during boot and, for each trail, checks whether a **representative sample tile** (the trail's center tile at zoom 14, built from *that trail's* tile source) is still in the tile cache. The result drives the single global **"Save maps"** button: it is set to the **"done"** state (`✓ Maps saved` / `✓ 保存済み`) only if **every** trail's sample tile is present; if any is missing it stays **"idle"** (`⬇ Save maps` / `⬇ 地図を保存`):

  ```js
  async function refreshCacheStatus(){
    if(dlState==='busy' || !('caches'in window)) return;
    try{
      const cache=await caches.open(TILE_CACHE);
      let all=true;
      for(const trail of TRAILS){
        const {x,y}=ll2t(trail.center[0],trail.center[1],14);
        const u=trailSource(trail).url.replace('{z}',14).replace('{y}',y).replace('{x}',x);
        if(!(await cache.match(u))){ all=false; break; }   // sample-tile probe (per-trail source)
      }
      dlState = all ? 'done' : 'idle';
    }catch(_){}
  }
  ```

  Boot order in `app.js` runs the probe **before** reflecting the button state, then updates the button label:

  ```js
  renderList();
  ...
  await refreshCacheStatus();
  updateDlBtn();   // reflect detected offline-maps state (idle / done)
  ```

  If eviction has occurred, at least one trail's sample tile is missing → `dlState` becomes `'idle'` → the button reverts from "✓ Maps saved" to "⬇ Save maps." So the **UI self-corrects** after eviction. (Note the all-or-nothing semantics: because the download is global, the button only shows "saved" when *every* trail is covered — there are no per-trail badges anymore.)

- **GAP — no proactive re-prompt.** The app reflects eviction in the button state but does **not** actively warn the user (e.g. *"Your saved maps have expired — re-download before you go"*) and does not auto-re-download. A user who previously downloaded the maps could arrive at the trailhead, offline, with an empty cache and no warning.
  **Recommendations:**
  1. **Persist a "user intended this offline" flag** (in `localStorage`) when they tap "Save maps." On startup, if that flag is set but `refreshCacheStatus()` finds sample tiles gone, show a re-download prompt.
  2. **Probe more than one tile** before declaring maps "saved" — a single sample tile per trail can be a false positive (present) or false negative. A few spot-checks across zoom levels would make the status trustworthier.
  3. Keep the app opened/used often enough, or simply re-download before each trip; this is the only guaranteed defense against the 7-day timer.

---

## Web App Manifest specifics on iOS

### iOS behavior
- **`display`**: `standalone` works. **`fullscreen` and `minimal-ui` fall back to `standalone`.**
- **Ignored on iOS**: `shortcuts`, `categories`, `screenshots` (and related richer-install metadata).
- **`id`**: honored only on **iOS 17+** (older iOS ignores it; identity falls back to `start_url`/`scope`).
- **Apple-specific `<meta>`/`<link>` tags are still required** for a good installed experience — the manifest alone is not sufficient on iOS.
- **Splash screen** is **auto-generated** by iOS from the manifest `background_color` plus the app icon. There is **no manifest field to supply a custom splash**; the only per-device control is the legacy `apple-touch-startup-image` link tags (not used here).

### How this app handles it
The manifest (`manifest.json`) is intentionally minimal and sticks to fields iOS respects:

```json
{
  "name": "梅ちゃんのトレイル",
  "short_name": "梅ちゃん",
  "id": "/ume-trails",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "orientation": "any",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

- `display:standalone` → real standalone launch on iOS.
- `id:"/ume-trails"` → used on iOS 17+, harmlessly ignored earlier.
- `name`/`short_name` are Japanese (`梅ちゃんのトレイル` / `梅ちゃん`) — iOS uses these for the install sheet / app identity; the Home-Screen icon label itself comes from `apple-mobile-web-app-title` (below).
- No `shortcuts`/`categories`/`screenshots` are declared (they'd be ignored anyway).
- `background_color:#0f172a` is what iOS uses to paint the **auto-generated splash**.

**Apple-specific meta/link tags present in `index.html`** (these do the heavy lifting on iOS):

| Tag (as written in `index.html`) | Value | Purpose |
|---|---|---|
| `<meta name="mobile-web-app-capable">` | `yes` | **Standard** (spec) capability tag; silences the Safari deprecation warning and aligns with the cross-browser spec. |
| `<meta name="apple-mobile-web-app-capable">` | `yes` | Apple-legacy form, kept for older iOS. Launch in standalone (no Safari chrome) when added to Home Screen. |
| `<meta name="apple-mobile-web-app-status-bar-style">` | `black-translucent` | Status bar style; **translucent → content draws under the status bar**, which is why safe-area insets matter (below). |
| `<meta name="apple-mobile-web-app-title">` | `梅ちゃんのトレイル` | Home-Screen icon label. |
| `<link rel="apple-touch-icon">` | `icon-180.png` | Home-Screen icon (180×180 PNG; iOS does not reliably honor SVG here). |
| `<meta name="theme-color">` | `#0f172a` | UI tinting (also a standard tag). |
| `<link rel="manifest">` | `manifest.json` | Standard manifest link. |

Exact source:

```html
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="梅ちゃんのトレイル">
<meta name="theme-color" content="#0f172a">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" sizes="180x180" href="icon-180.png">
```

- **No `apple-touch-startup-image`** is set, so iOS shows the auto-generated splash (background color + icon). Acceptable for this app.
- **Both capability tags are present.** `apple-mobile-web-app-capable` is deprecated in favor of the standard `mobile-web-app-capable`; the app now ships **both** — the Apple form for older iOS and the standard form to satisfy the spec and silence the Safari console deprecation warning. (Previously the app set only the `apple-` form; that gap is now closed.)

  ```html
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  ```

---

## Other iOS quirks

### Network Information API is unsupported
`navigator.connection` (downlink, effectiveType, `change` events) is **not implemented** on iOS. Don't branch on connection quality.

- **How this app handles it.** It doesn't depend on `navigator.connection` at all. Offline resilience is handled structurally by the **cache-first service worker** (a request simply succeeds from cache when the network is down). The recommended online/offline signal on iOS is **`navigator.onLine` plus the `online`/`offline` events** — currently the app does not display an explicit offline banner.
  **Recommendation (optional):** add an `offline`/`online` listener to show a subtle "Offline — showing saved maps" chip:

  ```js
  window.addEventListener('offline', showOfflineChip);
  window.addEventListener('online',  hideOfflineChip);
  ```

### Input font-size ≥ 16px to avoid focus auto-zoom
iOS Safari **auto-zooms the viewport** when the user focuses a form control whose computed `font-size` is **below 16px**, which is jarring in a map UI.

- **How this app handles it.** The app has **no `<input>`, `<textarea>`, or `<select>` fields** — all interactions are taps on buttons/cards — so the auto-zoom-on-focus trap **cannot trigger** today. (Note: `html,body` does not set an explicit base `font-size`, and several elements use sub-16px sizes like 9–15px; that's fine for *display* text and only matters for *focusable form fields*, of which there are none.)
  **Recommendation:** if a search/filter **text input** is ever added, give it `font-size: 16px` (or larger) to prevent the zoom. Also note `maximum-scale=1` is set in the viewport (below), which suppresses pinch-zoom but is **not** a substitute for the 16px rule on inputs across all iOS versions.

### Notch / Dynamic Island / home indicator (safe areas)
Content can be obscured by the notch/Dynamic Island and the home indicator unless the page opts into the safe-area model. This is especially relevant here because `apple-mobile-web-app-status-bar-style` is `black-translucent`, so the web view draws **under** the status bar.

- **How this app handles it — confirmed in source.** The viewport opts in with **`viewport-fit=cover`**, and `app.css` defines safe-area **custom properties** that are applied throughout the layout (header padding, filter bar, FAB position, bottom sheet, modal, etc.).

  `index.html`:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  ```

  `app.css`:
  ```css
  :root {
    --safe-t: env(safe-area-inset-top, 0px);
    --safe-b: env(safe-area-inset-bottom, 0px);
    --safe-l: env(safe-area-inset-left, 0px);
    --safe-r: env(safe-area-inset-right, 0px);
  }
  /* e.g. list header respects the notch + side insets */
  #list-header { padding: calc(var(--safe-t) + 14px) calc(16px + var(--safe-l)) 12px calc(16px + var(--safe-r)); }
  ```

  The root `#app` container is pinned with `position:fixed; top:0; right:0; bottom:0; left:0` so it fills the visual viewport edge-to-edge, including the safe areas under `viewport-fit=cover`. (It was previously sized with `height:100dvh` / a `100vh` fallback, but in an installed iOS **standalone** PWA `100dvh` could resolve ~34px short of the physical screen, leaving a gap at the bottom.)

---

## Internationalization (i18n)

The app is **bilingual**: **Japanese by default**, with an **English toggle** in the header. This is mostly orthogonal to the iOS constraints above, but two points intersect with this document; the full design lives in **`docs/I18N.md`**.

- **Language preference is stored in `localStorage.lang`** (`'ja'` | `'en'`), read at boot with a Japanese default:

  ```js
  let lang = (localStorage.lang === 'en' || localStorage.lang === 'ja') ? localStorage.lang : 'ja';
  ```

  Because `localStorage` is **script-writable storage**, it is subject to the **same 7-day eviction rule** as the Cache API (see *Storage & the 7-day eviction rule*). After 7 days of non-use the saved language can be wiped along with the tile cache, so the app reverts to its **Japanese default** on the next launch. Benign, but it's the same mechanism that drops downloaded maps.

- **`<html lang>` is updated dynamically.** The document ships as `<html lang="ja">` and `applyStaticI18n()` rewrites `document.documentElement.lang` (and `document.title`) whenever the language changes:

  ```js
  function applyStaticI18n(){ document.documentElement.lang = lang; /* …swap [data-i18n] text… */ }
  ```

- **Manifest identity is Japanese.** `name`/`short_name` and the `apple-mobile-web-app-title` meta are Japanese (`梅ちゃんのトレイル` / `梅ちゃん`), so the installed Home-Screen app is labeled in Japanese regardless of the in-app toggle (the manifest is static and not re-read on language switch). See *Web App Manifest specifics on iOS*.

> See `docs/I18N.md` for the complete i18n architecture (string tables, per-trail localized content, unit conversion, date/season formatting, etc.).

---

## The offline strategy (dedicated section)

Ume-chan's Trails uses a **three-tier offline model**. The first two tiers are automatic; the third is the deliberate, user-controlled step that the iOS background-fetch ban forces on us.

### Tier 1 — App shell + all trail data precached on SW install
On `install`, the service worker precaches the **app shell** (must-succeed) and, best-effort, **all 10 GPX tracks + all 10 hero images**, so the app UI and every trail's info/elevation/photo work offline **immediately after first load** — even before the user downloads any map tiles.

```js
const SHELL = [
  './', './index.html', './app.css', './app.js', './trails.js', './i18n.js',
  './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

const TRAIL_ASSETS = [
  // Washington (8)
  'gpx/Lake_22_Trail.gpx', /* …6 more WA GPX… */ 'gpx/The_Enchantments_Traverse.gpx',
  'images/lake-22.webp',   /* …6 more WA images… */ 'images/enchantments.webp',
  // Japan (2)
  'gpx/Mt_Fuji_Yoshida.gpx','gpx/Mount_Kinpu_Odarumi.gpx',
  'images/fuji-yoshida.webp','images/kinpu-odarumi.webp',
];
```

> Verified: the repo contains exactly **10 GPX files** and **10 `.webp` hero images**, matching the 10 trails in `trails.js` — 8 in Washington (`lake-22`, `snow-lake`, `lake-valhalla`, `talapus-lake`, `mount-pilchuck`, `bridal-veil`, `skyline-loop`, `enchantments`) and 2 in Japan (`fuji-yoshida`, `kinpu-odarumi`). The GPX/image lists in `sw.js` are bundled at install time — this is *trail metadata*, not map imagery.

### Tier 2 — Map tiles served cache-first with network fallback
Any request to a **USGS National Map tile (US trails) or a GSI 地理院タイル tile (Japan trails)** is intercepted and served **cache-first**: return the cached tile if present, otherwise fetch, store (including any **opaque** cross-origin responses), and return — falling back to a `503` if offline and uncached. The branch matches **both** tile hosts:

```js
// sw.js — fetch handler (tiles)
if (url.includes('nationalmap.gov') || url.includes('cyberjapandata.gsi.go.jp')) {
  e.respondWith(caches.open(TILE_V).then(cache =>
    cache.match(url).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') cache.put(url, res.clone());
      return res;
    }).catch(() => new Response('', { status: 503 })))
  ));
  return;
}
```

This means simply **panning the map while online warms the cache** for free — but it does **not** guarantee complete coverage at all zooms, which is what Tier 3 is for.

> **Two tile sources, one cache.** US trails use USGS topo (`{z}/{y}/{x}`); Japan trails use GSI 地理院タイル (`{z}/{x}/{y}.png`, Japanese labels on the `std` layer). Both are 256-px, EPSG:3857 Web-Mercator XYZ tiles and are CORS-enabled (`Access-Control-Allow-Origin: *`), so they cache as **real** (non-opaque) responses. The two URL templates put the `x`/`y` tokens in a **different order**, but `app.js` substitutes them by name (`.replace('{z}'…).replace('{y}'…).replace('{x}'…)`), so the same tile math drives both. They share the single `wa-trails-tiles-v1` cache. (Practical note: GSI works fine from real iPhones / home networks; it can `403` from some datacenter IPs, which is irrelevant to end users.)

### Tier 3 — User explicitly downloads every trail's tiles ("Save maps")
A **single global** button in the list header — **"Save maps"** (`#dl-all`, sitting next to the language toggle) — pre-caches tiles for **all 10 trails across both tile sources** into `wa-trails-tiles-v1` in one tap. There is **no** per-trail download button or download modal anymore.

`downloadAll()` walks every trail, computes each trail's bounding box from its (already-precached) GPX via `gpxBox()`, builds the full tile-URL list for that trail **using its own source template** across **z10 up to that source's `maxZoom`** (USGS 16, GSI 18), dedupes everything with a `Set`, then fetches in batches of 8 with inline progress:

```js
const DL_MIN_Z = 10;   // overview floor; ceiling = each source's maxZoom (USGS 16, GSI 18)
// Zoom-aware context buffer (degrees) added around each track per zoom: wider at overview
// zooms, progressively tighter toward max detail (z17–18 tiles are tiny, so a wide frame is
// costly and you rarely pan far when reading them).
const padFor = z => z<=12 ? 0.05 : z<=14 ? 0.03 : z<=16 ? 0.015 : z===17 ? 0.008 : 0.004;

// Raw bbox of one trail, parsed from its precached GPX (falls back to a small
// box around trail.center if no track points parse). Padding is applied later, per zoom.
async function gpxBox(trail){ /* …parse trkpt min/max lat/lon… */ }

// Every tile URL for one box across z10..src.maxZoom, built from that source's URL template.
// Each zoom expands the box by its own padFor(z) before computing the tile range.
function tileURLsFor(box, src){
  const urls = [];
  for (let z=DL_MIN_Z; z<=src.maxZoom; z++){ const p = padFor(z);
    const r = tRange({ n:box.n+p, s:box.s-p, e:box.e+p, w:box.w-p }, z);
    for (let x=r.x0; x<=r.x1; x++) for (let y=r.y0; y<=r.y1; y++)
      urls.push(src.url.replace('{z}',z).replace('{y}',y).replace('{x}',x)); }
  return urls;
}

async function downloadAll(){
  if (dlState === 'busy' || !('caches' in window)) return;
  dlState = 'busy'; updateDlBtn(); updateDlProgress(0, 1);
  let urls = [];
  for (const trail of TRAILS){                       // every trail…
    const box = await gpxBox(trail);
    urls.push(...tileURLsFor(box, trailSource(trail)));   // …via its own source
  }
  urls = [...new Set(urls)];                          // dedupe across trails
  const total = urls.length || 1; let done = 0;
  const cache = await caches.open(TILE_CACHE), BATCH = 8;
  for (let i = 0; i < urls.length; i += BATCH){
    await Promise.allSettled(urls.slice(i, i+BATCH).map(async u => {
      try{ if(!(await cache.match(u))){               // skip already-cached
        const r = await fetch(u, { mode:'cors' });
        if (r.ok || r.type === 'opaque') await cache.put(u, r);
      } }catch(_){}
      done++; updateDlProgress(done, total);
    }));
  }
  dlState = 'done'; updateDlBtn();
}
```

**Button states** are driven by `dlState` (`'idle' | 'busy' | 'done'`) via `updateDlBtn()`/`updateDlProgress()`:

| `dlState` | Label (EN / JA) | Visual |
|---|---|---|
| `idle` | `⬇ Save maps` / `⬇ 地図を保存` | default |
| `busy` | live `NN%` | inline CSS gradient fill via a `--p` custom property |
| `done` | `✓ Maps saved` / `✓ 保存済み` | "done" styling |

Because the download is one tap for **everything**, there is no per-trail tile-count preview before committing — the button just shows a live percentage as it works.

### Approximate tile counts & storage footprint
Because the download is now **global**, the meaningful number is the **total across all 10 trails and both tile sources**, not a per-trail figure. Each trail's tile count is still computed at runtime from its real track bounding box × 7 zoom levels (`gpxBox` → `tileURLsFor`), so it varies a lot by trail:

- A compact trail (e.g. a short out-and-back like **Talapus Lake** or **Mount Pilchuck**) contributes on the order of **~150** tiles.
- A large, spread-out route (e.g. **The Enchantments Traverse**) produces a **much larger** bounding box and therefore **many more** tiles — on the order of **a thousand** — because box-area × 7 zooms grows with geographic extent. (Tile counts roughly **quadruple per added zoom level**, and zooms 15–16 dominate the total.)

Summed across everything (and deduped), a full "Save maps" run caches roughly **~3,200 tiles ≈ 2,760 USGS** (the 8 Washington trails) **+ ~465 GSI** (the 2 Japan trails). At a typical **~15–25 KB** per 256×256 topo PNG tile:

| Scope | Approx tiles | Approx storage |
|---|---|---|
| One compact trail | ~150 | **~3 MB** |
| The Enchantments (largest box) | ~1,200 | **~20–30 MB** |
| **All 10 trails, both sources (a full "Save maps")** | **~3,200** | **roughly ~50–80 MB total** |

This is well within the large installed-PWA quota on iOS 17+ (~60% of disk), so storage size is **not** the limiting factor — *eviction* (the 7-day rule) is.

### Why a single foreground download instead of background prefetch
This is the central design decision, and it's driven by both platform limits and product sense:

1. **No background fetch on iOS (hard constraint).** iOS has no Background Fetch/Sync, so tiles can only be pulled while the app is open and in the foreground. Bulk-caching every trail's imagery has to happen during an active session anyway — there's no "download overnight" option — so it must be an explicit, visible action with progress. This rationale is **unchanged**; what changed is that it's now **one tap for everything** rather than a per-trail button.
2. **All-or-nothing, by design (a deliberate trade-off).** The old per-trail downloads let a user fetch *only the chosen trail* (a few MB) to respect metered data. The single button trades that selectivity for simplicity: it grabs **all 10 trails across both sources** (tens of MB) in one go. The assumption is that the user sets this up on Wi-Fi at home before a trip; on a weak/metered trailhead LTE connection the full download is heavier than the old per-trail option would have been.
3. **Storage & the 7-day eviction rule.** Since tiles can be evicted after a week of inactivity anyway, the cache will drift out of date regardless; the "Save maps" button is the user's one-tap way to refresh **all** maps right before a trip, which keeps the whole set current at once.
4. **User control & predictability.** The button is explicit and visible, with a live percentage and a clear "✓ Maps saved" end state, so storage use is consensual and the user always knows whether the maps are ready. The trade-off versus the old design is that the status is now **global** (all trails saved, or not) rather than a per-trail badge.

---

## Appendix — file map

| Concern | File(s) |
|---|---|
| Meta tags (both capability tags), manifest link, global "Save maps" button (`#dl-all`), `[data-i18n]` hooks | `index.html` |
| Manifest (iOS-respected fields; Japanese identity) | `manifest.json` |
| Caching strategy, two named caches, precache lists (10 GPX + 10 images), two-host tile match | `sw.js` |
| Geolocation, Wake Lock, language preference, cache-status probe, global tile download (`downloadAll`/`gpxBox`), tile sources | `app.js` |
| i18n string tables, per-trail localized content, unit/date formatting | `i18n.js` (design: `docs/I18N.md`) |
| Safe-area variables, full-screen `#app` pinning (`position:fixed`), display font sizes | `app.css` |
| Trail metadata (10 trails: 8 WA + 2 Japan) | `trails.js` |
| Bundled offline assets | `gpx/` (10 GPX), `images/` (10 `.webp`) |

---

### Gap checklist (for the backlog)

- [ ] **In-app browser / no-SW detection** → "Open in Safari" hint.
- [ ] **Wake Lock fallback** for iOS 16.4–18.3 standalone → silent looping `<video>`; plus Auto-Lock tip.
- [ ] **Eviction re-prompt** → persist a "wanted offline" intent; warn + offer re-download when the sample-tile probe fails; probe more than one tile per trail (the "Save maps" button is global all-or-nothing — no per-trail badge to nudge from).
- [ ] **Offline status chip** via `navigator.onLine` + `online`/`offline` events.
- [ ] **Geolocation error UX** for codes `2`/`3` (position unavailable / timeout).
- [ ] **16px font-size** on any future text input.

Closed since the previous revision:

- [x] **`mobile-web-app-capable`** meta tag — now shipped alongside the legacy `apple-mobile-web-app-capable` (both present in `index.html`).
