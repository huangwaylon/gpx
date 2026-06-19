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
| **Background Sync / Periodic Sync / Background Fetch** | All **unsupported** on iOS. | Tile caching is **foreground & user-initiated** — via the global **"Save maps"** button or a per-trail card button — never background prefetch. |
| **SW ES modules / nested workers** | Modules need iOS 15+, nested workers 15.5/16.4. | App ships a **classic, non-module** SW — no `type:'module'`, no nested workers. |
| **Cache API** | Fully supported since iOS 11.1. | App **shell** only (`wa-trails-app-v23`). **Map tiles moved to IndexedDB** (`tiles-db.js`) — opening a Cache holding thousands of tile records is slow on WebKit and stalled launch (ADR-12). |
| **`watchPosition()` in background** | **No** background geolocation; JS suspends when screen locks / app is backgrounded, and the watch can come back **silently dead** (no fixes, no error). | GPS only works screen-on, foreground. On wake (`pageshow`/`visibilitychange`) the app **`restartWatch()`s** the watch + kicks a one-shot fix (with a 32 s self-heal guard so GPS can't wedge if iOS fires neither callback), and re-acquires Wake Lock. **Document: keep screen on.** |
| **`navigator.permissions.query` for geolocation** | **Not** supported on iOS — cannot pre-check. | App skips pre-checks; handles `GeolocationPositionError.code === 1` in `onPosErr`. |
| **`navigator.wakeLock` (standalone)** | Reliable in standalone PWAs on the **iOS 26+ target** (the 16.4–18.3 standalone breakage is below our floor). | Calls `wakeLock.request('screen')` in `startGPS()`, re-acquires on visibility change. Only relevant for phone-in-hand navigation; the pocket-and-check pattern is covered by GPS-gap recovery. No fallback needed. |
| **`beforeinstallprompt`** | **Never fires** on iOS. | Installation is left to the user (Safari **Share → Add to Home Screen**); the app shows **no in-app install banner or prompt** and performs **no standalone detection**. |
| **7-day storage eviction** | iOS evicts **all** script-writable storage after 7 days of no interaction. `persist()` does **not** help. | `refreshCacheStatus()` re-checks each trail's **completion-manifest** record on startup and re-probes its multi-zoom sample tiles in IndexedDB; a card's button (and the global button) reads "saved" only if the record is present **and** every probe survives. Affects `localStorage` too — both the `lang` preference and the manifest itself (a wiped manifest simply reverts every button to "⬇"). **GAP: no auto re-prompt** when tiles are gone. |
| **Manifest features** | `display:standalone` works; `fullscreen`/`minimal-ui` → standalone; `shortcuts`/`categories`/`screenshots` ignored; `id` needs iOS 17+. | Manifest uses `display:standalone` + `id:"/ume-trails"` and a Japanese `name`. Relies on Apple meta tags for capability; ships **both** `mobile-web-app-capable` and `apple-mobile-web-app-capable`. |
| **Splash screen** | Auto-generated from `background_color` + icon; no manifest control. | Sets `background_color:#f4f6f3`; accepts the auto splash. |
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

- Because **there is no Background Fetch/Sync on iOS**, the app never tries to prefetch tiles in the background. The **only** way map tiles enter the cache is a **foreground, user-initiated** download — either the global **"Save maps"** button or a per-trail card button (both share the `saveTiles` engine; see *The offline strategy*). This is not a stylistic choice; it is the **direct consequence** of the missing background APIs.

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

> **Updated by ADR-12.** Map **tiles moved out of the Cache API into IndexedDB** (`tiles-db.js`).
> On WebKit, opening a Cache that holds thousands of tile records is slow, and that open sat on the
> launch critical path → a multi-second black screen on relaunch once maps were saved. Cache Storage
> now holds **only the app shell** — a **single** versioned cache — and saved tiles live in IndexedDB
> (fast keyed lookup). The app therefore **does** use IndexedDB now (it didn't before ADR-12); any
> "no IndexedDB / two caches" wording elsewhere in this guide is **superseded** by this ADR.

The app uses the Cache API for **the app shell only**, and **IndexedDB** for saved map tiles. There
is now a **single** Cache-Storage cache, keyed by version string so it can be rotated cleanly:

| Cache name (constant) | Contents | Population strategy |
|---|---|---|
| **`wa-trails-app-v23`** (`APP_V` in `sw.js`) | App shell (incl. `tiles-db.js`) + bundled trail data (GPX + hero images) | Precached on SW `install` via `fetch(u,{cache:'reload'})` + `cache.put` — shell must-succeed, trail assets best-effort; topped up on cache miss at runtime. |

Saved **map tiles** (USGS topo for US trails, GSI 地理院タイル for Japan trails) are **not** in any
Cache-Storage cache — they live in the IndexedDB store defined by `tiles-db.js` (DB `wa-trails-tiles`,
object store `tiles`, keyed by tile URL), filled IndexedDB-first on `fetch` and by the user-initiated
"Save maps" download. See *Storage & the 7-day eviction rule* and *The offline strategy* for the
handlers.

`sw.js` declarations:

```js
const APP_V = 'wa-trails-app-v23';   // tiles now live in IndexedDB (tiles-db.js), not a cache
importScripts('./tiles-db.js');       // shared tile store → self.TileStore (also loaded by the page)
```

**App-shell cache (`APP_V`).** On `install` the SW precaches the shell (HTML, CSS, JS — **including the now-required `tiles-db.js`** — manifest, icon, and Leaflet's JS/CSS from unpkg). Each file is fetched with `{cache:'reload'}` and stored with `cache.put` (not `addAll`), so a new version never stores a **stale** copy of a shell file from the HTTP cache — important now that `tiles-db.js` is a required shell file. The shell is **must-succeed**; the bundled trail assets are added **best-effort** so a single failed asset cannot abort installation:

```js
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_V);
    await Promise.all(SHELL.map(async u => {                  // shell must succeed
      const res = await fetch(u, { cache: 'reload' });
      if (!res.ok) throw new Error('precache failed: ' + u);
      await c.put(u, res);
    }));
    await Promise.allSettled(TRAIL_ASSETS.map(async u => {    // assets best-effort
      const res = await fetch(u, { cache: 'reload' });
      if (res.ok) await c.put(u, res);
    }));
    self.skipWaiting();
  })());
});
```

The `activate` handler deletes **every** cache except `APP_V` — so bumping `APP_V` cleanly evicts stale data, and (on upgrade from a tiles-in-Cache build) it **drops the old `wa-trails-tiles-v1` tile cache** too. Tiles now live in IndexedDB, so users simply re-download once:

```js
const keys = await caches.keys();
await Promise.all(keys.filter(k => k !== APP_V).map(k => caches.delete(k)));
```

**Shell serving.** The shell branch is served **cache-first, scoped to `APP_V`** (`caches.open(APP_V).then(c => c.match(req)…)`) rather than via a global `caches.match()` — a global match can make WebKit open/scan unrelated stores, so scoping keeps shell serving fast. A navigation that misses falls back to `cache.match('./index.html')`. Map tiles are served from IndexedDB on a separate branch (see *The offline strategy*); both tile sources are CORS-enabled and fetched with `{ mode: 'cors' }`, so the stored bytes replay as **real (non-opaque)** responses.

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

  Because the watch dies when the screen sleeps, **no GPS is recorded while the screen is off, and
  no breadcrumb path is ever stored** — live tracking is a screen-on tool. What the app *does*
  rescue is the **session** itself: see *Live trail-progress survives a reload* below.
  **User guidance to document in-product:** *Keep your screen on while navigating; the blue dot stops updating when the phone sleeps.* (The app also holds a Wake Lock while navigating — see next section — which is reliable on the iOS 26+ target, but the dot still stops the moment you lock the phone yourself, so the guidance still matters for the pocket-and-check pattern.)

- **Live trail-progress survives a reload — and a cold relaunch auto-resumes.** Even though fixes
  stop with the screen off, the tracking *session* (the progress high-water mark + the elapsed clock)
  is mirrored to `localStorage` on every accepted fix, on a ~30 s heartbeat, and on **`visibilitychange
  → hidden` *and* `pagehide`**, with an **absolute** start timestamp. (`localStorage` is chosen over
  IndexedDB precisely here: its writes are **synchronous**, so they survive a freeze that an IndexedDB
  transaction wouldn't.) If iOS reloads or evicts the PWA mid-hike, a **cold relaunch lands straight
  back on the trail screen and auto-resumes** the live session: at boot, `bootRoute()` (called instead
  of `routeFromHash()`) checks for a **fresh, resumable** saved session — slug ∈ `TRAILS`,
  `Date.now() - savedAt ≤ SESSION_MAX_AGE_MS` (18 h), and **either paused or** `savedElapsedMs ≥
  RESUME_MIN_MS` (20 s, to skip accidental starts) — and if so sets `resumeOnOpen=true` and
  `history.replaceState(…, '#/trail/'+slug)` before routing. **Crucially this is decided on the saved
  session, not on `location.hash`:** an installed iOS PWA relaunches *inconsistently* — sometimes at
  the bare `start_url` (no hash), sometimes **restoring the last URL including the fragment** — so the
  earlier `!location.hash` guard meant auto-resume fired only *some* of the time (the rest fell through
  to a passive prompt that looks like "no active hike"). Deciding hash-independently makes resume
  **deterministic** either way. The **timer keeps counting** through the gap (absolute start), and a
  **stale-window re-acquire** re-snaps your position against the known GPX. `replaceState` keeps the
  **Back button** returning to the list; the `#list-resume` banner is the fallback.
  **Resident-process wakes (no reload)** — the *common* "just checking" case where iOS keeps the page
  alive and fires **no `load` event** — are handled by `onWake()` (hooked to **both `pageshow` and
  `visibilitychange → visible`**, idempotent): it refreshes the list resume banner, re-surfaces the
  resume offer on a trail, repaints the clock at once (`updateHUD()` — the 1 s `setInterval` is
  suspended while backgrounded), and — because iOS can leave `watchPosition` **silently dead** after a
  screen-off gap — **`restartWatch()`s** the watch and kicks one fresh `getCurrentPosition({maximumAge:0})`
  (deduped by `gpsWakePending`, with a **32 s `gpsWakeGuard` self-heal** that *always* clears that flag
  afterward — iOS can abandon a wake-time one-shot mid-flight when the phone is re-pocketed, firing
  **neither** callback, which would otherwise leave the flag stuck and wedge GPS for the rest of the
  hike). A **paused** wake skips this re-acquire (so it can't taint the eventual un-pause with a wrong-leg
  re-snap); the wake-lock re-acquire still runs. See `ARCHITECTURE.md` §10a. **Pause/resume and end live in the
  `#track-hud`, not the FAB** (the FAB only *starts*), so a stray map tap can never pause or reset an
  active hike — a separate cause of "it paused itself."

- Instead of pre-checking permission (impossible on iOS), the app **reacts to the error**. `watchPosition`'s error callback inspects the standard `GeolocationPositionError` code; **code `1` is `PERMISSION_DENIED`**:

  ```js
  function onPosErr(err){
    if (err.code === 1){   // PERMISSION_DENIED
      alert(t('alertDenied'));   // localized message (JA/EN) via the i18n table
      stopGPS();
    }
  }
  ```

  This is the correct iOS pattern: attempt the call, then handle denial after the fact.

- **Minor robustness note:** `onPosErr` handles only code `1`. Codes `2` (`POSITION_UNAVAILABLE`) and `3` (`TIMEOUT`) are ignored, so a transient timeout under tree cover currently produces no user feedback (the watch keeps trying, which is reasonable). Consider a soft "searching for GPS…" indicator for codes 2/3.

---

## Screen Wake Lock

### iOS behavior
- The **Screen Wake Lock API** (`navigator.wakeLock.request('screen')`) is **reliable in standalone / Home-Screen PWA mode on the app's iOS 26+ target.** (Historically it was broken in standalone on iOS 16.4–18.3 and only became reliable from 18.4+, but those versions are below our supported floor, so that breakage no longer applies.)
- A Wake Lock **only** keeps the screen awake while the page is **foreground with the screen already on**; iOS **auto-releases it the instant the page is hidden** (screen locked or app backgrounded). It cannot keep anything running while the phone is asleep or pocketed.

### What it actually buys this app
- The lock matters for exactly **one** usage mode: **phone-in-hand, watching the blue dot move** — it stops the screen dimming/locking mid-navigation so the user isn't tapping to wake it.
- It does **little** for the dominant **pocket-it-and-check-at-the-summit** pattern: the screen is off (lock released) most of the time, and when the user pulls the phone out they're interacting, so Auto-Lock wouldn't fire anyway. That pattern is served instead by the **GPS-gap-recovery path** (`refreshGpsAfterGap()` / `restartWatch()` on wake — see the geolocation section), which is independent of the Wake Lock.

### How this app handles it
- The app calls Wake Lock from `startGPS()`, releases it in `stopGPS()`, and re-acquires it when the page becomes visible again:

  ```js
  async function reqWake(){ if('wakeLock' in navigator){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch(_){ } } }
  async function relWake(){ if(wakeLock){ try{ await wakeLock.release(); }catch(_){ } wakeLock=null; } }

  // in onWake() (visibilitychange→visible / pageshow):
  if (gpsWatch !== null && (!wakeLock || wakeLock.released)) reqWake();
  ```

  Re-acquisition on return is mandatory because **Wake Locks are auto-released whenever a page is hidden** — this is true on every platform, not an iOS quirk. The guard tests `wakeLock.released` as well as `!wakeLock`: iOS auto-release leaves the sentinel **referenced but released**, so a bare `!wakeLock` check would see a truthy stale sentinel and never re-lock (the screen would then auto-lock for the rest of the hike).

- **No fallback is needed.** On the iOS 26+ target the `request()` succeeds, so there is no version where the screen sleeps despite the lock. The old pre-18.4 mitigations — a silent looping `<video>` keep-awake hack and a "raise Auto-Lock to Never" tip — are **not** implemented and are **not** worth adding: the supported iOS floor makes Wake Lock dependable, and the app's core usage pattern doesn't rely on it anyway.

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
- **`localStorage` is evicted too.** The 7-day rule covers *all* script-writable storage, including `localStorage`. The app keeps two things there: the **language preference** (`localStorage.lang`) and the **download completion manifest** (`tileManifest` — which trails were fully saved, plus each set's probe tiles). After 7 days of non-use both can reset: the language falls back to its **Japanese default**, and a wiped manifest simply reverts every download button to "⬇" (which, since the IndexedDB tiles are evicted on the same timer, is the *correct* state). This is benign, but worth knowing when reasoning about "why did my settings reset." See *Internationalization (i18n)* and `docs/I18N.md`.
- The app **verifies download state on every startup** rather than trusting it. A trail counts as **saved** only when a **completion-manifest record** exists for it (written solely by a download that committed its *whole* expected tile set with zero hard failures) **and** that record's **multi-zoom probe tiles** — a handful (~8) spread across zoom levels — are all still in the IndexedDB tile store. `trailSaved(trail)` enforces both; if any probe is missing it `clearSaved()`s the now-stale record (demoting *and* forgetting it). `refreshCacheStatus()` runs that check for every trail on boot and drives **both** each card's button (via `setCardDl`) **and** the global **"Save maps"** button (set **"done"** — `✓ Maps saved` / `✓ 保存済み` — only if **every** trail is verified, else **"idle"** — `⬇ Save maps` / `⬇ 地図を保存`):

  ```js
  async function trailSaved(trail){
    const rec = readManifest()[trail.slug];                  // completion record written by a full download
    if(!rec || !Array.isArray(rec.probes) || !rec.probes.length) return false;
    for(const u of rec.probes)                               // re-probe the sampled tiles
      if(!(await TileStore.has(u))){ clearSaved(trail.slug); return false; }   // evicted → demote + forget
    return true;
  }
  async function refreshCacheStatus(){
    if(dlState==='busy' || !('indexedDB'in window)) return;
    try{
      let all=true;
      for(const trail of TRAILS){
        const saved = await trailSaved(trail);
        if(cardDl.get(trail.slug)!=='busy') setCardDl(trail.slug, saved?'done':'idle');
        if(!saved) all=false;
      }
      dlState = all ? 'done' : 'idle';
    }catch(_){}
  }
  ```

  **This is the fix for the old false-✓.** Previously the probe sampled a **single z14 center tile** and "done" was gated on `ok > 0`, so a tile the service worker had cached *incidentally while you merely browsed a map online* faked a complete download → a blank map on the trail with no signal. A partial/interrupted download flipped to ✓ for the same reason. The manifest gate closes both holes: incidental SW tiles write no record, partial downloads clear theirs, and the multi-zoom probe catches a partial eviction a single center tile would miss.

  Boot in `app.js` runs the probe **off the critical path** — it is **not** awaited before routing the first screen. `bootRoute()` paints first, and the saved-maps button state updates a tick later when the IndexedDB probe resolves:

  ```js
  bootRoute();                    // route + paint the first screen immediately (not blocked on the probe)
  ...
  // Detect saved-maps state OFF the critical path; awaiting it before first paint used to stall launch
  // once many tiles were saved (ADR-12).
  refreshCacheStatus().then(updateDlBtn);
  ```

  If eviction has occurred, a trail's probe tiles are missing → that card's button (and, if any trail is missing, the global button) reverts from "✓ saved" to "⬇". So the **UI self-corrects** after eviction. Each card's button reflects its **own** trail's status; the global button shows "saved" only when *every* trail is covered.

- **GAP — no proactive re-prompt.** The app reflects eviction in the button state but does **not** actively warn the user (e.g. *"Your saved maps have expired — re-download before you go"*) and does not auto-re-download. A user who previously downloaded the maps could arrive at the trailhead, offline, with an empty cache and no warning.
  **Recommendations:**
  1. **Persist a "user intended this offline" flag** (in `localStorage`) when they tap "Save maps." On startup, if that flag is set but `refreshCacheStatus()` finds the tiles gone, show a re-download prompt.
  2. (Done) The status check now **probes several tiles across zoom levels** behind a manifest record rather than one center tile, so a partial/incidental cache no longer reads as a complete download.
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
  "short_name": "梅ちゃんのトレイル",
  "id": "/ume-trails",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#f4f6f3",
  "theme_color": "#f4f6f3",
  "orientation": "any",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

- `display:standalone` → real standalone launch on iOS.
- `id:"/ume-trails"` → used on iOS 17+, harmlessly ignored earlier.
- `name`/`short_name` are Japanese (`梅ちゃんのトレイル`) — iOS uses these for the install sheet / app identity; the Home-Screen icon label itself comes from `apple-mobile-web-app-title` (below).
- No `shortcuts`/`categories`/`screenshots` are declared (they'd be ignored anyway).
- `background_color:#f4f6f3` is what iOS uses to paint the **auto-generated splash**.

**Apple-specific meta/link tags present in `index.html`** (these do the heavy lifting on iOS):

| Tag (as written in `index.html`) | Value | Purpose |
|---|---|---|
| `<meta name="mobile-web-app-capable">` | `yes` | **Standard** (spec) capability tag; silences the Safari deprecation warning and aligns with the cross-browser spec. |
| `<meta name="apple-mobile-web-app-capable">` | `yes` | Apple-legacy form, kept for older iOS. Launch in standalone (no Safari chrome) when added to Home Screen. |
| `<meta name="apple-mobile-web-app-status-bar-style">` | `default` | Status bar style; **`default` → opaque status bar, content sits below it** (not drawn under). Safe-area insets still matter because of `viewport-fit=cover` (notch / home indicator), see below. |
| `<meta name="apple-mobile-web-app-title">` | `梅ちゃんのトレイル` | Home-Screen icon label. |
| `<link rel="apple-touch-icon">` | `icon-180.png` | Home-Screen icon (180×180 PNG; iOS does not reliably honor SVG here). |
| `<meta name="theme-color">` | `#f4f6f3` | UI tinting (also a standard tag). |
| `<link rel="manifest">` | `manifest.json` | Standard manifest link. |

Exact source:

```html
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="梅ちゃんのトレイル">
<meta name="theme-color" content="#f4f6f3">
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

- **How this app handles it.** It doesn't depend on `navigator.connection` at all. Offline resilience is handled structurally by the **service worker** (the app shell is served cache-first, and map tiles are served IndexedDB-first — see *The offline strategy* — so requests simply succeed from local storage when the network is down). The recommended online/offline signal on iOS is **`navigator.onLine` plus the `online`/`offline` events** — currently the app does not display an explicit offline banner.
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
Content can be obscured by the notch/Dynamic Island and the home indicator unless the page opts into the safe-area model. This is especially relevant here because the viewport uses `viewport-fit=cover`, so the layout extends into the notch / home-indicator regions.

- **How this app handles it — confirmed in source.** The viewport opts in with **`viewport-fit=cover`**, and `app.css` defines safe-area **custom properties** that are applied throughout the layout (header padding, filter bar, FAB position, bottom sheet, etc.).

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

- **Manifest identity is Japanese.** `name`/`short_name` and the `apple-mobile-web-app-title` meta are Japanese (`梅ちゃんのトレイル`), so the installed Home-Screen app is labeled in Japanese regardless of the in-app toggle (the manifest is static and not re-read on language switch). See *Web App Manifest specifics on iOS*.

> See `docs/I18N.md` for the complete i18n architecture (string tables, per-trail localized content, unit conversion, date/season formatting, etc.).

---

## The offline strategy (dedicated section)

Ume-chan's Trails uses a **three-tier offline model**. The first two tiers are automatic; the third is the deliberate, user-controlled step that the iOS background-fetch ban forces on us.

> **Updated by ADR-12.** Saved tiles now live in **IndexedDB** (`tiles-db.js`), not the Cache API.
> The three-tier *model* is unchanged; only tier-2/3 *storage* changed — in the service worker tiles
> are read **IndexedDB-first** and written there on a network miss / by "Save maps" (`downloadAll`
> requests the misses and lets the SW store them). The Cache-API code shown in the tier-2/3 snippets
> below is **historical**; see ADR-12 in `docs/DECISIONS-AND-LESSONS.md` for the current handlers.

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

### Tier 2 — Map tiles served IndexedDB-first with network fallback
Any request to a **USGS National Map tile (US trails) or a GSI 地理院タイル tile (Japan trails)** is intercepted and served **IndexedDB-first** (`isTile(url)` = host includes `nationalmap.gov` or `cyberjapandata.gsi.go.jp`): if the tile's bytes are in the IndexedDB store, replay them as a fresh `Response`; otherwise fetch, store the bytes on `res.ok` (kept alive via `e.waitUntil`), and return — falling back to a `503` if offline and uncached. The stored value is `{ body:ArrayBuffer, type }`, keyed by the tile URL; both sources are CORS so the body is readable:

```js
// sw.js — fetch handler (tiles), IndexedDB-first via TileStore (tiles-db.js)
const isTile = url => url.includes('nationalmap.gov') || url.includes('cyberjapandata.gsi.go.jp');

if (isTile(url)) {
  e.respondWith((async () => {
    try {
      const rec = await TileStore.get(url);
      if (rec) return new Response(rec.body, { headers: { 'Content-Type': rec.type } });
    } catch (_) {}
    try {
      const res = await fetch(e.request);
      if (res.ok) {                                   // keep the SW alive to finish the write
        const type = res.headers.get('Content-Type') || 'image/png';
        e.waitUntil(res.clone().arrayBuffer().then(body => TileStore.put(url, { body, type })).catch(() => {}));
      }
      return res;
    } catch (_) { return new Response('', { status: 503 }); }
  })());
  return;
}
```

This means simply **panning the map while online warms the store** for free — but it does **not** guarantee complete coverage at all zooms, which is what Tier 3 is for.

> **Panning can't escape the cached area offline.** The map sets a per-zoom `maxBounds` (`applyMaxBounds()`, recomputed on `zoomend` / after fitting the track) equal to the track's bounds expanded by the *same* `padFor(z)` the download uses. Because `padFor` tightens as you zoom in, the pannable box at each zoom matches the saved box at that zoom — so with no signal you can't drag the view onto a never-cached (blank) tile. The clamp is soft (default Leaflet viscosity). The box is widened on the top/bottom by the header/sheet insets so it bounds the **visible** viewport, not the whole container — otherwise the deliberately sheet-offset fit would be panned back down on load, sliding the track behind the sheet (ADR-19).

> **Two tile sources, one IndexedDB store.** US trails use USGS topo (`{z}/{y}/{x}`); Japan trails use GSI 地理院タイル (`{z}/{x}/{y}.png`, Japanese labels on the `std` layer). Both are 256-px, EPSG:3857 Web-Mercator XYZ tiles and are CORS-enabled (`Access-Control-Allow-Origin: *`), so their bytes are stored as **readable (non-opaque)** records. The two URL templates put the `x`/`y` tokens in a **different order**, but `app.js` substitutes them by name (`.replace('{z}'…).replace('{y}'…).replace('{x}'…)`), so the same tile math drives both. They share the single IndexedDB tile store (`tiles-db.js` — DB `wa-trails-tiles`, store `tiles`), keyed by tile URL. (Practical note: GSI works fine from real iPhones / home networks; it can `403` from some datacenter IPs, which is irrelevant to end users.)

### Tier 3 — User explicitly downloads tiles ("Save maps")
Two buttons pre-cache tiles into the **IndexedDB tile store**: a **global** "Save maps" button (`#dl-all`, next to the language toggle) caches **all 10 trails across both tile sources** in one tap, and a **per-trail** button on each list card (`.card-dl`) caches just that trail. The old download *modal* is gone — each button's own idle/percent/done state is its status.

Both share one engine. `trailTileURLs(trail)` computes a trail's bounding box from its (already-precached) GPX via `gpxBox()` and builds the full tile-URL list **using its own source template** across **z10 up to that source's `maxZoom`** (USGS 16, GSI 18). `saveTiles(urls, onProgress)` dedupes with a `Set`, fetches the missing tiles in batches of 8, and **commits each tile's bytes to IndexedDB on the page** — so reaching "saved" means the bytes are stored, not merely fetched (the SW's own deferred `e.waitUntil` write can be cut off when iOS suspends the backgrounded SW). It **classifies** each tile: `ok` (committed or already present), `absent` (the host 404'd — legitimately no tile there, so it counts as *covered*, not a failure), or `fail` (network error / the SW's offline 503 / 5xx / an IndexedDB quota abort — *retryable*); a `QuotaExceededError` also sets `dlQuotaHit`. `downloadTrail(trail, urls, onProgress)` runs `saveTiles` and then **records a completion-manifest entry only if `fail === 0`** (else clears it), so a partial/interrupted download never claims "saved." `downloadAll()` loops `downloadTrail` over every trail **one at a time** behind a single combined progress bar (trails are geographically disjoint, so there's no cross-trail overlap to dedupe and each card earns its own honest "done"); `downloadOne(slug)` runs it for one. Both **guard on `navigator.onLine`** (bailing with the `dlOffline` alert rather than faking a "saved" state offline), and on finishing they **alert** `dlQuota` (storage full) or `dlPartial` (some tiles failed) as appropriate:

```js
const DL_MIN_Z = 10;   // overview floor; ceiling = each source's maxZoom (USGS 16, GSI 18)
// Zoom-aware context buffer (degrees) added around each track per zoom: wider at overview
// zooms, progressively tighter toward max detail (z17–18 tiles are tiny, so a wide frame is
// costly and you rarely pan far when reading them). The SAME padFor also clamps map panning
// per zoom (maxBounds), so offline you can't pan onto a never-cached blank tile.
const padFor = z => z<=12 ? 0.05 : z<=14 ? 0.03 : z<=16 ? 0.015 : z===17 ? 0.008 : 0.004;

// Raw bbox of one trail, parsed from its precached GPX (falls back to a small
// box around trail.center if no track points parse). Padding is applied later, per zoom.
async function gpxBox(trail){ /* …parse trkpt min/max lat/lon… */ }

// Every tile URL for one box across z10..src.maxZoom, built from that source's URL template.
// Each zoom expands the box by its own padFor(z) before computing the tile range.
function tileURLsFor(box, src){ /* …loop z, build src.url.replace('{z}'…'{y}'…'{x}'…)… */ }
async function trailTileURLs(trail){ return tileURLsFor(await gpxBox(trail), trailSource(trail)); }

// Shared engine — fetch each missing tile and COMMIT its bytes to IndexedDB on the page.
// Classifies each tile so a 404 (no tile there) isn't mistaken for a failure. Returns {ok, absent, fail}.
let dlQuotaHit = false;
async function saveTiles(urls, onProgress){
  urls = [...new Set(urls)];                          // dedupe
  const total = urls.length || 1; let done=0, ok=0, absent=0, fail=0; const BATCH=8;
  for (let i=0; i<urls.length; i+=BATCH){
    await Promise.allSettled(urls.slice(i, i+BATCH).map(async u => {
      try{
        if (await TileStore.has(u)) ok++;             // already committed
        else { const r = await fetch(u, { mode:'cors' });
          if (r.ok){ const type = r.headers.get('Content-Type')||'image/png';
            await TileStore.put(u, { body: await r.arrayBuffer(), type }); ok++; }
          else if (r.status===404) absent++;          // host has no tile here → covered, not a miss
          else fail++; }                              // 503 (SW offline) / 5xx → retryable miss
      }catch(e){ if(e && e.name==='QuotaExceededError') dlQuotaHit=true; fail++; }
      done++; if (onProgress) onProgress(done, total);
    }));
  }
  return { ok, absent, fail };
}

// Save one trail's set and record a manifest entry ONLY if everything committed (404s are fine).
async function downloadTrail(trail, urls, onProgress){
  const r = await saveTiles(urls, onProgress);
  if (r.fail===0) markSaved(trail.slug, urls);        // complete → trustworthy "saved" record
  else clearSaved(trail.slug);                         // partial/interrupted → never claim saved
  return r;
}

async function downloadAll(){                          // global "Save maps" — every trail, one by one
  if (dlState==='busy' || !('indexedDB' in window)) return;
  if (!navigator.onLine){ alert(t('dlOffline')); return; }   // no connection → don't fake "saved"
  dlQuotaHit=false; dlState='busy'; updateDlBtn(); updateDlProgress(0,1);
  const lists = []; for (const trail of TRAILS){ const urls=[...new Set(await trailTileURLs(trail))];
    lists.push({trail, urls}); setCardDl(trail.slug,'busy',0); }
  const grand = lists.reduce((s,l)=>s+l.urls.length,0)||1; let base=0, anyFail=false;
  for (const {trail, urls} of lists){
    const r = await downloadTrail(trail, urls,
      (d,tot)=>{ updateDlProgress(base+d, grand); setCardDl(trail.slug,'busy',Math.round(d/tot*100)); });
    base += urls.length;
    if (r.fail===0) setCardDl(trail.slug,'done'); else { anyFail=true; setCardDl(trail.slug,'idle'); }
  }
  dlState='idle'; updateDlBtn();
  await refreshCacheStatus(); updateDlBtn();            // reconcile to "every trail verified saved?"
  if (dlQuotaHit) alert(t('dlQuota')); else if (anyFail) alert(t('dlPartial'));
}

async function downloadOne(slug){                      // per-trail card button — same engine + guards
  if (cardDl.get(slug)==='busy' || !('indexedDB' in window)) return;
  if (!navigator.onLine){ alert(t('dlOffline')); return; }
  const trail = TRAILS.find(x => x.slug===slug); if (!trail) return;
  dlQuotaHit=false; setCardDl(slug,'busy',0);
  const r = await downloadTrail(trail, [...new Set(await trailTileURLs(trail))],
                                (d,total)=>setCardDl(slug,'busy',Math.round(d/total*100)));
  setCardDl(slug, r.fail===0 ? 'done' : 'idle');
  if (r.fail===0) refreshCacheStatus().then(updateDlBtn);   // this trail may complete the global ✓
  else if (dlQuotaHit) alert(t('dlQuota')); else alert(t('dlPartial'));
}
```

**Global-button states** are driven by `dlState` (`'idle' | 'busy' | 'done'`) via `updateDlBtn()`/`updateDlProgress()`. (Each per-trail card button mirrors the same three states from the `cardDl` map via `setCardDl()`, showing a conic progress ring instead of a percentage label; the busy % is cached in a parallel `cardDlPct` map so a filter/sort/language re-render mid-download restores the ring.)

| `dlState` | Label (EN / JA) | Visual |
|---|---|---|
| `idle` | `⬇ Save maps` / `⬇ 地図を保存` | default |
| `busy` | live `NN%` | inline CSS gradient fill via a `--p` custom property |
| `done` | `✓ Maps saved` / `✓ 保存済み` | "done" styling |

A button shows **done** only when `refreshCacheStatus()` re-confirms the relevant trail(s) against the completion manifest + probe tiles — *not* merely because some bytes were fetched. The two result alerts use new i18n keys (EN/JA both present): **`dlPartial`** ("Some map tiles couldn't be saved (weak connection)…") and **`dlQuota`** ("Out of storage — couldn't save all maps…").

Neither button shows a tile-count preview before committing — it just shows live progress as it works (a percentage on the global button, a conic ring on the card button).

### Approximate tile counts & storage footprint
The global "Save maps" total is the **sum across all 10 trails and both tile sources**; a per-trail download is just one trail's slice. Each trail's tile count is computed at runtime from its real track bounding box × zoom levels (`gpxBox` → `tileURLsFor`), so it varies a lot by trail:

- A compact trail (e.g. a short out-and-back like **Talapus Lake** or **Mount Pilchuck**) contributes on the order of **~150** tiles.
- A large, spread-out route (e.g. **The Enchantments Traverse**) produces a **much larger** bounding box and therefore **many more** tiles — on the order of **a thousand** — because box-area × 7 zooms grows with geographic extent. (Tile counts roughly **quadruple per added zoom level**, and zooms 15–16 dominate the total.)

Summed across everything (and deduped), a full "Save maps" run caches roughly **~5,200 tiles ≈ 2,830 USGS** (the 8 Washington trails) **+ ~2,480 GSI** (the 2 Japan trails — the GSI z17–18 levels roughly *doubled* the total). At a typical **~20 KB** per 256×256 topo PNG tile:

| Scope | Approx tiles | Approx storage |
|---|---|---|
| One compact trail | ~150 | **~3 MB** |
| The Enchantments (largest box) | ~1,200 | **~20–30 MB** |
| **All 10 trails, both sources (a full "Save maps")** | **~5,200** | **roughly ~100 MB total** |

This is well within the large installed-PWA quota on iOS 17+ (~60% of disk), so storage size is **not** the limiting factor — *eviction* (the 7-day rule, which applies equally to the IndexedDB tile store) is.

### Why foreground, user-initiated downloads (not background prefetch)
This is the central design decision, and it's driven by both platform limits and product sense:

1. **No background fetch on iOS (hard constraint).** iOS has no Background Fetch/Sync, so tiles can only be pulled while the app is open and in the foreground. Bulk-caching imagery has to happen during an active session anyway — there's no "download overnight" option — so it must be an explicit, visible action with progress. This holds whether you tap the global button (all trails) or a single card's button.
2. **Both granularities (global + per-trail).** A per-trail card button fetches **just that trail** (a few MB — kind to metered data: save only the hike you're doing this weekend). The global button grabs **all 10 trails across both sources** (tens of MB) in one tap, for a trip where you'll lose signal entirely. The assumption is you set this up on Wi-Fi before heading out; both share the same engine and tile store, so they never double-fetch.
3. **Storage & the 7-day eviction rule.** Since tiles can be evicted after a week of inactivity anyway, the cache will drift out of date regardless; the buttons are the user's one-tap way to refresh maps right before a trip — all of them, or just the one they need.
4. **User control & predictability.** Every download is explicit and visible, with live progress and a clear "saved" end state, so storage use is consensual. Status is shown **both** per-trail (each card's button) and globally (the header button reads "saved" only when *every* trail is covered).

---

## Appendix — file map

| Concern | File(s) |
|---|---|
| Meta tags (both capability tags), manifest link, global "Save maps" button (`#dl-all`), `[data-i18n]` hooks | `index.html` |
| Manifest (iOS-respected fields; Japanese identity) | `manifest.json` |
| Caching strategy, shell precache (`{cache:'reload'}`), two-host tile match → IndexedDB | `sw.js`, `tiles-db.js` |
| Geolocation, Wake Lock, language preference, download verification (`trailSaved`/`refreshCacheStatus` + the `tileManifest`), global + per-trail tile download (`downloadAll`/`downloadOne`/`downloadTrail`/`saveTiles`/`gpxBox`), tile sources | `app.js` |
| i18n string tables, per-trail localized content, unit/date formatting | `i18n.js` (design: `docs/I18N.md`) |
| Safe-area variables, full-screen `#app` pinning (`position:fixed`), display font sizes | `app.css` |
| Trail metadata (10 trails: 8 WA + 2 Japan) | `trails.js` |
| Bundled offline assets | `gpx/` (10 GPX), `images/` (10 `.webp`) |

---

### Gap checklist (for the backlog)

- [ ] **In-app browser / no-SW detection** → "Open in Safari" hint.
- [ ] **Eviction re-prompt** → persist a "wanted offline" intent; warn + offer re-download when `refreshCacheStatus()` finds a previously-saved trail's tiles evicted.
- [ ] **Offline status chip** via `navigator.onLine` + `online`/`offline` events.
- [ ] **Geolocation error UX** for codes `2`/`3` (position unavailable / timeout).
- [ ] **16px font-size** on any future text input.

Closed since the previous revision:

- [x] **False-✓ saved state** — the "saved" check is now gated on a **completion manifest** (written only by a download that committed its *whole* set with zero hard failures) **plus a multi-zoom probe**, replacing the old single z14-center-tile / `ok>0` heuristic. Tiles the SW cached incidentally while browsing online, and partial/interrupted downloads, can no longer fake a green ✓ (so the partial-download / blank-map-offline bug is fixed).
- [x] **`mobile-web-app-capable`** meta tag — now shipped alongside the legacy `apple-mobile-web-app-capable` (both present in `index.html`).
- [x] **Wake Lock fallback (silent `<video>` + Auto-Lock tip)** — **dropped, won't do.** It only addressed iOS 16.4–18.3 standalone, which is below the iOS 26+ target where Wake Lock is reliable; and the app's pocket-and-check usage doesn't depend on the lock anyway.
