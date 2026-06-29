'use strict';

/* ════════════════════════════════════════════════════════════
   Ume-chan's Trails — offline hiking PWA (JA default, EN toggle)
   ════════════════════════════════════════════════════════════ */

// Saved offline tiles live in IndexedDB (see tiles-db.js → window.TileStore), not Cache Storage.
// Offline pre-caching spans z10 (overview) up to each source's own maxZoom — USGS tops out at
// z16 (its native ceiling; z17+ 404s), GSI serves to z18 — so Japan trails cache the extra
// z17–18 detail while US trails stop where the USGS cache ends.
const DL_MIN_Z   = 10;
// Zoom-aware bbox padding (degrees, ~111 km per °) added around each track when caching
// offline tiles. Generous at overview zooms — where you pan to take in the surrounding
// terrain — and progressively tighter toward max detail, since each extra zoom quadruples the
// tile count and you rarely pan far while reading z17–18 detail right at your position.
const padFor = z => z<=12 ? 0.05 : z<=14 ? 0.03 : z<=16 ? 0.015 : z===17 ? 0.008 : 0.004;
const FT         = 3.28084;
const MI_PER_KM  = 1.609344;

// Elevation-profile SVG geometry. The viewBox is W×PROF_H; PROF_H must match #elev-svg's
// height in app.css, and PROF_PAD_B/T are the px reserved below/above the plotted area.
const PROF_H = 96, PROF_PAD_B = 14, PROF_PAD_T = 12;

// Track / marker palette — mirrors the map-semantic custom properties in app.css
// (SVG strings and Leaflet options can't read CSS vars without getComputedStyle).
// Keep in sync with :root in app.css. `pine` is the brand accent (elevation fill).
const C = { red:'#d4442e', green:'#1f9d63', blue:'#2f6fe0', violet:'#7b5bff', amber:'#d6861c',
            pine:'#1f6f5c', ink:'#16231d' };

// ── Inline SVG icons (offline-safe, scale with currentColor) ──
// Replaces emoji throughout. Stroke icons use the shared attrs in icon(); the two
// filled action glyphs (play/pause for the tracking FAB) are full strings.
const ICON_PATHS = {
  dist:    '<path d="m18 8 4 4-4 4"/><path d="m6 8-4 4 4 4"/><path d="M2 12h20"/>',
  gain:    '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  clock:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  pin:     '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  download:'<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  check:   '<path d="M20 6 9 17l-5-5"/>',
  users:   '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  calendar:'<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2.5"/><path d="M3 10h18"/>',
  sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  sunset:  '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  ext:     '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  chevDown:'<path d="m6 9 6 6 6-6"/>',
  navigate:'<path d="M3 11 22 2 13 21 11 13 3 11Z"/>',
};
function icon(name, cls){
  return `<svg class="ic${cls?' '+cls:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `+
         `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}
const ICON_PLAY  = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.14a1 1 0 0 1 1.5-.87l11 6.86a1 1 0 0 1 0 1.74l-11 6.86A1 1 0 0 1 7 18.86Z"/></svg>';
const ICON_PAUSE = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5.5" width="3.7" height="13" rx="1.3"/><rect x="13.8" y="5.5" width="3.7" height="13" rx="1.3"/></svg>';

// Live-tracking tuning. Per GPS fix we snap the position to the nearest track vertex,
// searching only a forward window around the last snapped index so an out-and-back's
// return leg (which overlaps the outbound leg) can't match the wrong leg.
const SNAP_FWD_M  = 250;   // how far ahead along the track to search (≈ one fix's travel)
const SNAP_BACK_M = 80;    // small backward slack for GPS jitter
// If this many consecutive fixes land outside that forward window, the window has gone stale
// (e.g. you pocketed the phone at the trailhead and pulled it out at the summit — a frozen
// window can never reach a far-off fix). Abandon it and re-acquire from scratch via acquireIdx,
// so progress jumps to where you actually are instead of staying stranded near the last snap.
const REACQUIRE_AFTER = 3;

// Map tile sources. Each trail picks one via its `tiles` field (default = usgs).
// US trails use USGS topo ({z}/{y}/{x}); Japan trails use GSI 地理院タイル ({z}/{x}/{y}).
// The {token} ORDER in the two URLs differs, but the download/probe code substitutes
// by name (.replace('{z}'…).replace('{y}'…).replace('{x}'…)), so the same XYZ
// (Web Mercator) tile math works unchanged for both.
const TILE_SOURCES = {
  usgs: {
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16, leaflet: '© USGS', creditKey: 'attribUsgs',
  },
  gsi: {
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxZoom: 18, leaflet: '地理院タイル © 国土地理院', creditKey: 'attribGsi',
  },
};
const trailSource = trail => TILE_SOURCES[trail.tiles] || TILE_SOURCES.usgs;

// ── App state ──
let map = null, curTrail = null, trackLayer = null;
let mapOrient = '';               // 'l'|'p' — last map orientation; resize re-fits only when this flips
let trackPts = [], trackWpts = [];
let totalDist = 0, gpsWatch = null, gpsMk = null, gpsAcc = null, gpsFollow = false;
let curPos = null, wakeLock = null, wakeReq = false;   // wakeReq: a wakeLock.request() is in flight (re-entrancy guard)
let sheetState = 'peek';          // 'peek' | 'full'
let dlState = 'idle';             // global offline-maps download: 'idle' | 'busy' | 'done'
const cardDl = new Map();         // per-trail download state by slug: 'idle' | 'busy' | 'done' (survives list re-renders)
const cardDlPct = new Map();      // per-trail busy progress % by slug, so renderList can restore the ring mid-download

// Cached profile elevation bounds (smoothed), computed once per trail in loadTrail.
let eleLo = 0, eleHi = 0, eleRange = 1;
// Downsampled render points for the track polyline, kept WITH cumulative distance .d so the
// green "walked" overlay (live tracking) can be sliced by distance without re-deriving them.
let renderPts = [];
// Far end of the trail = the point of greatest distance from the trailhead. For an out-and-back
// (whose GPX is a closed round trip) this is the turnaround/summit, and progress locks here.
let turnDist = 0, turnIdx = 0, isOutAndBack = false;

// Elevation-scrub state (drag a finger along the profile to inspect a point on the trail).
let scrubbing = false, scrubMk = null, scrubRAF = 0, scrubX = 0, scrubRect = null, scrubCardRect = null;
// Persistent inspected point: a tap or a drag-release leaves the dot + vertical line + readout on
// screen until a tap clears it (see initProfileScrub). scrubHeld = a readout is currently shown;
// scrubHeldD = its distance-along (m), kept so it can be re-placed after a profile redraw (resize /
// language switch). scrubStartX/scrubMoved/scrubStartHeld are per-gesture (to tell a tap from a drag).
let scrubHeld = false, scrubHeldD = 0, scrubStartX = 0, scrubMoved = false, scrubStartHeld = false;

// Live trail-progress state.
let tracking = false, paused = false;
let trackStartTs = 0, trackElapsedMs = 0, hudTimer = null, hudTicks = 0;
let walkedDist = 0, progIdx = -1;   // monotonic distance-along reached (m); last snapped vertex
let turnedAround = false;           // out-and-back: latched once we reach the turnaround so a re-acquire snaps to the RETURN leg, never the overlapping outbound leg
let walkedLayer = null, walkedHalo = null, walkedLine = null;   // green "walked" overlay: white halo + green line (a layerGroup), drawn over the red base track
let reacqMiss = 0;                  // consecutive off-window fixes (triggers a full re-acquire)
let trackSearching = false;         // sustained fix rejections (weak GPS / off-trail) → show a HUD hint

// Free-hike (record-anywhere) state. A free hike has no preset GPX — we record raw GPS fixes into
// recSegs and draw them as a green line as you walk. It reuses the whole tracking apparatus
// (start/pause/end FAB+HUD, the screen-on Wake Lock, GPS-gap recovery, and the localStorage resume
// session); `freeHike` is the flag that swaps the per-fix handler (recordFix vs updateProgress) and
// the HUD readout (distance vs trail %). `tileLayer` is held so the basemap can be swapped to the
// right region (USGS/GSI) once the first fix reveals where you are.
let freeHike = false, tileLayer = null, freeHikeSource = 'usgs';
let recSegs = [], recDist = 0, recLast = null, recBreak = false;   // recorded path as line SEGMENTS ([lat,lon][][]); total metres; last vertex; "start a new segment on the next fix"
let recLayer = null, recHalo = null, recLine = null, recStartMk = null;   // white halo + green multi-line layerGroup (mirrors the walked overlay) + a start dot
const REC_MIN_MOVE_M = 5;          // ignore sub-5 m fixes so stationary GPS jitter doesn't inflate distance / zig-zag the line
const REC_MAX_ACC_M  = 50;         // drop fixes worse than this (≈ tree-cover noise) rather than recording a wild jump
let pendingResume = null;           // a saved session offered for resume on the current trail
let resumeOnOpen = false;           // bootRoute (cold relaunch) or the list "resume hike" banner → auto-resume on open
let gpsWasHidden = false;           // GPS was live when last backgrounded (→ refresh fix on return)
let gpsWakePending = false;         // a wake-time getCurrentPosition is in flight (dedupes rapid visibility flips)
let gpsWakeGuard = null;            // safety timer that ALWAYS releases gpsWakePending (iOS may fire neither GPS callback)
let locatingTimer = null;           // safety auto-hide for the "locating…" indicator
let booting = true;                 // true until just after first load — bootRoute owns the initial resume; onWake stands down
let openingDetail = false;          // openDetail is mid-await — onWake stands down so it can't double-offer/flash a resume

// A tracking session is mirrored to localStorage so it survives a page reload / iOS tab eviction
// (progress + an absolute start timestamp, so the elapsed clock keeps counting across the gap).
// Reopening the trail offers to restore it. Only the HUD ✕ (endTracking) forgets it.
const SESSION_KEY = 'trackSession';
const SESSION_MAX_AGE_MS = 18 * 3600 * 1000;   // discard a saved session older than this (stale)
const RESUME_MIN_MS = 20000;                   // ignore trivially-short sessions (accidental starts) when offering/auto-resuming
const HIKE_SLUG = '__hike__';                  // sentinel "slug" for a free-hike resume in the list banner (free hikes have no trail)
const LAST_POS_KEY = 'lastPos';                // last GPS fix [lat,lon], so a free hike opens centered on where you were

const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// ════════════════════════════════════════════════════════════
//  i18n
// ════════════════════════════════════════════════════════════
let lang = (localStorage.lang === 'en' || localStorage.lang === 'ja')
  ? localStorage.lang : 'ja';   // Japanese is the default

const t = key => I18N.ui[lang][key] ?? I18N.ui.en[key] ?? key;
const tf = key => I18N.fn[lang][key] ?? I18N.fn.en[key];

// Localized accessors for trail data
function trDiff(d)  { return (I18N.diff[lang][d]  ?? d); }
function trRoute(r) { return (I18N.route[lang][r] ?? r); }
function trDogs(g)  { return (I18N.dogs[lang][g]  ?? g); }
function trWpt(name){ return lang === 'ja' ? (I18N.wpt[name] ?? name) : name; }

// "Apr – Nov" → "4月～11月" in JA; unchanged in EN
function trSeason(s) {
  if (lang !== 'ja') return s;
  return s.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, m => I18N.months[m])
          .replace(/\s*[–-]\s*/g, '～');
}

// Returns the trail object with locale-appropriate text fields merged in
function loc(trail) {
  if (lang === 'ja') {
    const j = I18N.trails[trail.slug]?.ja;
    if (j) return { ...trail, ...j };
  }
  return trail;
}

// Apply static UI strings to all [data-i18n] / [data-i18n-aria] nodes
function applyStaticI18n() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.title = t('appName');
  updateDlBtn();                  // the global download button's label is state+lang dependent
}

function setLang(next) {
  lang = next;
  localStorage.lang = next;
  applyStaticI18n();
  renderList();
  updateListResume();
  if (curTrail) {            // re-render the open detail view in the new language
    $('#detail-title').textContent = loc(curTrail).name;
    renderPeek(curTrail);
    renderSheetBody(curTrail);
    setSheet(sheetState);    // JA/EN body heights differ → re-fit the peek height + FAB offsets + map padding
    redrawTrailLabels();
    updateTrackUI(); updateHUD();   // re-localize the tracking controls + HUD message
    if(pendingResume) renderResumePrompt();
    syncGpsCursor();
    redrawScrubCursor();     // re-place a held readout (the rebuilt SVG wiped its cursor) in the new units
  } else if (freeHike) {     // re-render the open free-hike view in the new language
    $('#detail-title').textContent = t('freeHike');
    renderFreeHikePeek();
    renderFreeHikeBody();
    setSheet(sheetState);
    updateTrackUI(); updateHUD();
    if(pendingResume) renderResumePrompt();
  }
}

// ════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  const t0 = performance.now();
  applyStaticI18n();              // also calls updateDlBtn() → button shows its idle label at once
  renderList();
  bindGlobal();
  bootRoute();                    // resume an active hike's trail screen on a cold relaunch, else normal routing
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  // Detect saved-maps state OFF the critical path. It opens IndexedDB and probes tiles; awaiting it
  // before the first paint is what used to stall launch once many tiles were saved.
  refreshCacheStatus().then(updateDlBtn);
  setTimeout(()=>{ booting=false; }, 0);   // boot's resume is done; let onWake handle resident-process wakes
  if (localStorage.perf === '1') requestAnimationFrame(() => {
    const n = performance.getEntriesByType('navigation')[0];
    if (n) console.info(`[perf] sw-served shell ~${n.responseStart|0}ms · DOMContentLoaded ${n.domContentLoadedEventEnd|0}ms · load ${n.loadEventStart|0}ms · boot+route ${(performance.now()-t0)|0}ms`);
  });
});
window.addEventListener('hashchange', routeFromHash);

function routeFromHash() {
  if (location.hash.startsWith('#/hike')) { openFreeHike(); return; }
  const m = location.hash.match(/^#\/trail\/([\w-]+)/);
  if (m) {
    const trail = TRAILS.find(x => x.slug === m[1]);
    if (trail) { openDetail(trail); return; }
  }
  showList();
}

// Boot-only routing: if a hike is mid-session, land straight back on its trail screen (the elapsed
// clock keeps counting) instead of the list — that's what a hiker reopening the app wants. We do this
// REGARDLESS of location.hash: an installed iOS PWA may relaunch at the bare start_url (no hash) OR
// restore the last URL (hash present) — both happen, unpredictably — so keying auto-resume off "no
// hash" made it fire only some of the time (the rest landing on a passive prompt that looks like no
// active hike). Routing to the active session's trail and setting resumeOnOpen makes cold-relaunch
// resume deterministic either way. A real deep link still wins when there's no fresh session. Uses
// replaceState so no second hashchange fires and Back (hash → '') still returns to the list.
function bootRoute() {
  const s = readSession();
  if (freshResumable(s)) {
    resumeOnOpen = true;
    const want = s.hike ? '#/hike' : '#/trail/' + s.slug;
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  routeFromHash();
}

// ════════════════════════════════════════════════════════════
//  List screen
// ════════════════════════════════════════════════════════════
let listFilter = 'all', listSort = null;

// Difficulty → slug (used for the CSS class `d-<slug>` and the filter chips' data-filter).
const DIFF = { 'Easy':'easy', 'Moderate':'moderate', 'Hard':'hard', 'Very Hard':'veryhard' };
function diffClass(d) { return DIFF[d] ? 'd-'+DIFF[d] : 'd-moderate'; }
function diffKey(d)   { return DIFF[d]; }
// Distance/elevation units: miles+feet in EN, km+meters in JA
function fmtDist(mi) { return lang === 'ja' ? `${(mi*MI_PER_KM).toFixed(1)} km` : `${mi} mi`; }
function fmtGain(ft) { return lang === 'ja' ? `${Math.round(ft/FT).toLocaleString()} m` : `${ft.toLocaleString()} ft`; }

function renderList() {
  const wrap = $('#trail-list');
  let trails = TRAILS.slice();
  if (listFilter !== 'all') trails = trails.filter(x => diffKey(x.diff) === listFilter);
  if (listSort === 'dist') trails.sort((a,b) => a.lengthMi - b.lengthMi);
  if (listSort === 'gain') trails.sort((a,b) => a.gainFt - b.gainFt);

  wrap.innerHTML = trails.map(trail => {
    const tr = loc(trail);
    const dl = cardDl.get(trail.slug) || 'idle';   // per-trail download state survives this re-render
    const pct = dl==='busy' ? (cardDlPct.get(trail.slug) ?? 0) : null;   // restore the busy ring after a re-render
    return `
    <div class="card-wrap" role="listitem">
      <a class="card" href="#/trail/${trail.slug}">
        <div class="card-img-wrap">
          <img class="card-img" src="${trail.img}" alt="" loading="lazy" width="1200" height="800">
          <span class="card-badge ${diffClass(trail.diff)}">${trDiff(trail.diff)}</span>
          <div class="card-titlebar">
            <div class="card-title">${tr.name}</div>
            <div class="card-area">${icon('pin')}${tr.area}</div>
          </div>
        </div>
        <div class="card-stats">
          <span class="s">${icon('dist')}<span>${fmtDist(trail.lengthMi)}</span></span>
          <span class="s">${icon('gain')}<span>${fmtGain(trail.gainFt)}</span></span>
          <span class="s time">${icon('clock')}<span>${fmtTime(trail.time)}</span></span>
        </div>
      </a>
      <button class="card-dl${dl==='done'?' done':dl==='busy'?' busy':''}" type="button" data-slug="${trail.slug}"
              ${pct!=null?`style="--p:${pct}"`:''}
              aria-label="${t(dl==='done'?'dlOneDone':'dlOne')}">
        <span class="cdl-ic" aria-hidden="true">${icon(dl==='done'?'check':'download')}</span>
      </button>
    </div>`;
  }).join('');
}

// Mirror each filter/sort chip's visual .active onto aria-pressed so screen readers convey the state.
function syncChipPressed(){
  $$('#filter-bar .chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('active') ? 'true' : 'false'));
}

function bindGlobal() {
  $$('#filter-bar .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.dataset.filter) {
        listFilter = chip.dataset.filter;
        $$('#filter-bar .chip[data-filter]').forEach(c => c.classList.toggle('active', c === chip));
      } else if (chip.dataset.sort) {
        listSort = (listSort === chip.dataset.sort) ? null : chip.dataset.sort;
        $$('#filter-bar .chip[data-sort]').forEach(c => c.classList.toggle('active', c.dataset.sort === listSort));
      }
      syncChipPressed();
      renderList();
    });
  });
  syncChipPressed();   // initial aria-pressed state (the "all" filter chip starts active)

  $('#lang-toggle').addEventListener('click', () => setLang(lang === 'ja' ? 'en' : 'ja'));
  $('#btn-back').addEventListener('click', () => { location.hash = ''; });
  $('#btn-gps').addEventListener('click', toggleGPS);
  $('#btn-track').addEventListener('click', onTrackFab);
  $('#th-pause').addEventListener('click', togglePause);
  $('#th-close').addEventListener('click', endTracking);
  $('#tr-resume').addEventListener('click', () => { const s=pendingResume; hideResumePrompt(); if(s) resumeSession(s); });
  $('#tr-dismiss').addEventListener('click', () => { clearSession(); hideResumePrompt(); });
  // The resume prompt is role="alertdialog": Escape dismisses it, and Tab is trapped between its two
  // actions so keyboard focus can't wander onto the map/sheet behind it.
  $('#track-resume').addEventListener('keydown', e => {
    if(e.key==='Escape'){ clearSession(); hideResumePrompt(); const f=$('#btn-track'); if(f && !f.hidden) f.focus(); return; }
    if(e.key==='Tab'){
      const f=[$('#tr-dismiss'), $('#tr-resume')], i=f.indexOf(document.activeElement);
      if(e.shiftKey && i<=0){ e.preventDefault(); f[f.length-1].focus(); }
      else if(!e.shiftKey && i===f.length-1){ e.preventDefault(); f[0].focus(); }
    }
  });
  $('#dl-all').addEventListener('click', downloadAll);
  // Per-trail download: one delegated listener on the stable list container (survives every
  // renderList re-render). The button is a sibling of the card's <a>, so it doesn't navigate.
  $('#trail-list').addEventListener('click', e => {
    const b = e.target.closest('.card-dl'); if(!b) return;
    e.preventDefault(); e.stopPropagation();
    downloadOne(b.dataset.slug);
  });
  $('#list-resume').addEventListener('click', () => {
    const slug = $('#list-resume').dataset.slug; if(!slug) return;
    resumeOnOpen = true; location.hash = (slug === HIKE_SLUG) ? '#/hike' : '#/trail/' + slug;
  });
  const rec = $('#btn-record');
  rec.querySelector('.rec-ic').innerHTML = icon('navigate');
  rec.addEventListener('click', () => { location.hash = '#/hike'; });

  initSheetDrag();
  initProfileScrub();
}

function showList() {
  $('#detail').hidden = true;
  $('#list').hidden = false;
  if (gpsWatch !== null) stopGPS();
  stopTracking(); hideResumePrompt();
  scrubbing = false; clearScrub();
  curTrail = null; freeHike = false; resumeOnOpen = false;
  updateListResume();
}

// ════════════════════════════════════════════════════════════
//  Detail screen
// ════════════════════════════════════════════════════════════
async function openDetail(trail) {
  // Capture + consume resumeOnOpen synchronously: it's a module global read after an await below,
  // and a second navigation (hashchange / iOS restoring a hash a tick later) could otherwise consume
  // or clear it out from under us. See the post-await curTrail guard.
  const resumeThis = resumeOnOpen; resumeOnOpen = false;
  openingDetail = true;             // onWake stands down until this open's own resume decision is made
  curTrail = trail; freeHike = false;
  stopTracking(); hideResumePrompt(); scrubbing = false; scrubHeld = false;   // fresh per-trail tracking/scrub state
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = loc(trail).name;

  renderPeek(trail);
  renderSheetBody(trail);     // render the body first so setSheet can size the peek to the chart
  setSheet('peek');
  initMap(trail.center, trail.tiles || 'usgs');
  try {
    await loadTrail(trail);
    if (curTrail !== trail) return;   // a newer navigation superseded this one mid-load — don't touch its map/session
    if(resumeThis){             // arrived via cold-relaunch auto-route (bootRoute), wake-resume, or the list banner → resume straight away
      const s=readSession();
      if(freshResumable(s) && !s.hike && s.slug===trail.slug) resumeSession(s);
      else maybeOfferResume();
    } else {
      maybeOfferResume();  // a saved session for this trail (survived a reload) can be resumed
    }
  } finally {
    if (curTrail === trail) openingDetail = false;   // only release if still the active open (a newer one keeps it set)
  }
}

function renderPeek(trail) {
  const tr = loc(trail);
  $('#pk-title').textContent = tr.name;
  $('#pk-meta').innerHTML =
    `<span class="s">${icon('dist')}${fmtDist(trail.lengthMi)}</span>` +
    `<span class="s">${icon('gain')}${fmtGain(trail.gainFt)}</span>` +
    `<span class="s ${diffClass(trail.diff)}" style="font-weight:700">${trDiff(trail.diff)}</span>` +
    `<span class="s">${icon('clock')}${fmtTime(trail.time)}</span>`;
}

function renderSheetBody(trail) {
  const tr = loc(trail);
  $('#sheet-body').innerHTML = `
    <div id="elev-card">
      <div class="hd"><span class="t">${t('elevation')}</span><span class="r" id="elev-range"></span></div>
      <svg id="elev-svg" preserveAspectRatio="none" role="img" aria-label="${t('scrubAria')}"></svg>
      <div id="scrub-tip" hidden></div>
    </div>

    ${trail.plan ? renderPlanCard(trail.plan) : ''}

    <div class="section">
      <h3>${t('secOverview')}</h3>
      <p>${tr.summary}</p>
    </div>
    <div class="section">
      <h3>${t('secHike')}</h3>
      <p>${tr.description}</p>
    </div>
    <div class="section">
      <h3>${t('secTips')}</h3>
      <ul class="tips">${tr.tips.map(x=>`<li>${x}</li>`).join('')}</ul>
    </div>
    <div class="section">
      <h3>${t('secDetails')}</h3>
      <dl class="facts">
        <dt>${t('factRoute')}</dt><dd>${trRoute(trail.route)}</dd>
        <dt>${t('factSeason')}</dt><dd>${trSeason(trail.season)}</dd>
        <dt>${t('factDogs')}</dt><dd>${trDogs(trail.dogs)}</dd>
        <dt>${t('factPermit')}</dt><dd>${tr.permit}</dd>
        <dt>${t('factLocation')}</dt><dd>${tr.area}</dd>
      </dl>
    </div>
    <div class="section">
      <p class="attrib">${t('attribTrail')} ／ ${t(trailSource(trail).creditKey)}</p>
    </div>
  `;
  drawProfile();
}

// "3 h 17 min" → "3時間17分" (JA); "3h 17m" / "10–13h" (EN — compact but readable)
function fmtTime(s) {
  if (lang !== 'ja') return s.replace(/\s*–\s*/g,'–').replace(/\s*h\b/g,'h').replace(/\s*min\b/g,'m');
  return s.replace(/~/g,'約').replace(/(\d+)\s*h(?:r)?/g,'$1時間').replace(/(\d+)\s*min/g,'$1分')
          .replace(/\s*[–-]\s*/g,'～').replace(/時間(?=～|$)/,'時間').replace(/ /g,'');
}

// Optional upcoming-hike plan panel (data from a shared YAMAP plan, baked in so it
// works fully offline — no network call). Summary chips + an hour-by-hour timeline.
// The plan's own distance/gain are shown here (metric in JA, imperial in EN, like the
// rest of the app) and read as the plan's figures, not the trail's.
function renderPlanCard(plan) {
  const by   = plan.by[lang]        || plan.by.en;
  const pace = plan.paceLabel[lang] || plan.paceLabel.en;
  const dist = lang === 'ja' ? `${plan.distKm} km` : `${(plan.distKm/MI_PER_KM).toFixed(1)} mi`;
  const gain = lang === 'ja' ? `${plan.gainM.toLocaleString()} m`
                             : `${Math.round(plan.gainM*FT).toLocaleString()} ft`;
  return `
    <section class="plan-card">
      <div class="plan-head">
        ${icon('calendar')}
        <span class="lbl">${t('secPlan')}</span>
        <a class="plan-yamap" href="${plan.url}" target="_blank" rel="noopener"
           aria-label="${t('planYamapAria')}">${t('planYamap')}${icon('ext')}</a>
      </div>
      <div class="plan-date">${fmtPlanDate(plan.dateISO)}</div>
      <div class="plan-chips">
        <span class="pc">${icon('users')}${tf('planParty')(plan.party)}</span>
        <span class="pc">${icon('dist')}${dist}</span>
        <span class="pc">${icon('gain')}${gain}</span>
      </div>
      ${plan.itinerary ? renderTimeline(plan) : ''}
      <div class="plan-foot">${pace} ${plan.pace}% · ${t('planCourse')} ${plan.constant} · ${t('planBy')} ${by}</div>
    </section>`;
}

// Hour-by-hour itinerary as a vertical timeline. Leg durations between stops are
// computed from the times (a `depart` time marks a rest, e.g. the 2 h on the summit).
function renderTimeline(plan) {
  const it = plan.itinerary;
  const hm = s => { const [h,m] = s.split(':').map(Number); return h*60 + m; };
  const dur = (a,b) => { const d = b - a; return d < 0 ? d + 1440 : d; };   // minutes; wraps past midnight for a multi-day plan
  const rows = it.map((s, i) => {
    const stay = s.depart ? dur(hm(s.time), hm(s.depart)) : 0;
    const badge = stay
      ? `<span class="tl-stay">${lang==='ja' ? '滞在 '+fmtDur(stay) : fmtDur(stay)+' rest'}</span>`
      : '';
    const stop = `<li class="tl-stop tl-${s.type}"><span class="tl-dot"></span>` +
      `<span class="tl-time">${s.time}</span>` +
      `<span class="tl-name">${s.name[lang] || s.name.en}${badge}</span></li>`;
    if (i === it.length - 1) return stop;
    const leg = dur(s.depart ? hm(s.depart) : hm(s.time), hm(it[i+1].time));
    return stop + `<li class="tl-leg"><span>${fmtDur(leg)}</span></li>`;
  }).join('');
  const meta = `<div class="tl-meta">` +
    `<span>${icon('sunrise')} ${plan.sunrise}<span class="sr-only"> ${t('schedRise')}</span></span>` +
    `<span>${icon('sunset')} ${plan.sunset}<span class="sr-only"> ${t('schedSet')}</span></span>` +
    (plan.totalTime ? `<span>${icon('clock')} ${plan.totalTime}<span class="sr-only"> ${t('schedTotal')}</span></span>` : '') +
    `</div>`;
  return `<details class="tl-wrap" open>
      <summary class="tl-title">${t('secSchedule')}<span class="tl-caret">${icon('chevDown')}</span></summary>
      ${meta}<ol class="tl">${rows}</ol>
    </details>`;
}

// Minutes → "2時間" / "39分" (JA) or "2 h" / "39 min" (EN)
function fmtDur(min) {
  const h = Math.floor(min/60), m = min%60;
  if (lang === 'ja') return (h ? `${h}時間` : '') + (m ? `${m}分` : '') || '0分';
  const p = []; if (h) p.push(`${h} h`); if (m) p.push(`${m} min`);
  return p.join(' ') || '0 min';
}

// "2026-06-27" → "2026年6月27日（土）" (JA) / "Sat, Jun 27, 2026" (EN).
// Built from local date parts so the weekday isn't shifted by UTC parsing.
function fmtPlanDate(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  if (lang === 'ja') {
    const wd = ['日','月','火','水','木','金','土'][dt.getDay()];
    return `${y}年${m}月${d}日（${wd}）`;
  }
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${wd}, ${mo} ${d}, ${y}`;
}

// ── Map ──
// center: [lat,lon]; srcKey: a TILE_SOURCES key ('usgs'|'gsi'). A trail passes its own center +
// source; a free hike passes the last-known location (or a default) and the region's source, then
// swaps the basemap once its first fix lands (swapTileSource).
function initMap(center, srcKey) {
  if (map) { map.remove(); map = null; }
  // map.remove() drops all layers; clear stale references so onPos/scrub recreate them fresh.
  trackLayer = walkedLayer = scrubMk = gpsMk = gpsAcc = null; endMarker._all = [];
  recLayer = recHalo = recLine = recStartMk = null;
  freeHikeSource = srcKey;
  const src = TILE_SOURCES[srcKey] || TILE_SOURCES.usgs;
  map = L.map('map', { zoomControl:false, attributionControl:true, center, zoom:13, tap:true });
  map.createPane('gpsPane'); map.getPane('gpsPane').style.zIndex = 650;   // GPS dot + accuracy ring sit ABOVE the green walked overlay (which is on overlayPane, z400)
  const zoom = L.control.zoom({ position:'topright' }).addTo(map);
  // minZoom = DL_MIN_Z: the map can't zoom out past the cached overview level, so there's no blank-
  // tile band offline (offline pre-cache starts at z10; allowing z8–9 showed gray tiles with no data).
  tileLayer = L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:DL_MIN_Z, attribution:src.leaflet, crossOrigin:true }).addTo(map);
  map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
  map.on('zoomend', applyMaxBounds);   // the cached box tightens with zoom (padFor) — re-clamp panning to it
  zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
  mapOrient = window.innerWidth > window.innerHeight ? 'l' : 'p';
}

// Clamp panning to the offline-cached box for the CURRENT zoom. The download pre-caches the track's
// bbox padded by padFor(z), which tightens as you zoom in; matching maxBounds to that box per zoom
// means you can never pan onto a never-cached (blank) tile — wide roaming at overview, held to the
// saved frame at max detail. Soft (default viscosity): a gentle bounce at the edge, not a hard wall.
//
// We clamp the box under the *visible* map, not the whole map container. The header overlays the top
// and the bottom sheet overlays the bottom, and fitTrack() deliberately offsets the track up into the
// visible band between them — so the map's geometric center sits south of the track, and the viewport's
// (hidden) bottom strip pokes south of the cached box. If we clamped the bare cached box to the full
// container, setMaxBounds()'s _panInsideMaxBounds would immediately animate that sheet-offset view back
// down on load, dragging the just-fit track partly behind the sheet (worst on the compact Japan trails,
// whose small bbox leaves the tall viewport poking furthest past the box). So we widen the clamp on the
// covered edges by exactly the header/sheet inset (converted to degrees of latitude at this zoom): the
// visible viewport still can't pan onto never-cached tiles, while the hidden strips behind the header
// and sheet may extend past the cache — invisible, so harmless.
function applyMaxBounds(){
  if(!map || !trackLayer) return;
  const H=map.getSize().y; if(!H) return;
  const p=padFor(map.getZoom()), b=trackLayer.getBounds();
  const sw=b.getSouthWest(), ne=b.getNorthEast();
  // Mirror fitTrack's vertical padding (header at top, sheet peek at bottom).
  const topPx=70, botPx=Math.min(H*0.9, sheetPeekHeight()+30);
  const latAt=y=>map.containerPointToLatLng([0,y]).lat;
  const degTop=Math.max(0, latAt(0)-latAt(topPx));        // lat span the header covers
  const degBot=Math.max(0, latAt(H-botPx)-latAt(H));      // lat span the sheet covers
  map.setMaxBounds([[sw.lat-p-degBot, sw.lng-p],[ne.lat+p+degTop, ne.lng+p]]);
}

async function loadTrail(trail) {
  trackPts = []; trackWpts = []; totalDist = 0;
  renderPts = []; walkedDist = 0; progIdx = -1; reacqMiss = 0; turnedAround = false;
  let text;
  try { text = await (await fetch(trail.gpx)).text(); }
  catch(e) {
    console.error('GPX load failed', e);
    // Don't leave a blank detail screen (e.g. offline with the GPX evicted) — tell the user.
    if(curTrail===trail){ const body=$('#sheet-body');
      if(body && !body.querySelector('.load-err'))
        body.insertAdjacentHTML('afterbegin', `<div class="load-err" role="alert">${t('trailLoadError')}</div>`); }
    return;
  }
  if (curTrail !== trail) return;   // a newer navigation superseded this fetch — don't draw A's track / set A's farEnd onto B's map
  const xml = new DOMParser().parseFromString(text, 'text/xml');

  xml.querySelectorAll('wpt').forEach(w => {
    const lat=+w.getAttribute('lat'), lon=+w.getAttribute('lon');
    const name=(w.querySelector('name')?.textContent||'').trim().replace(/\s+/g,' ');
    trackWpts.push({ lat, lon, name, d:null });
  });

  let pLat=null,pLon=null,d=0;
  xml.querySelectorAll('trkpt').forEach(n => {
    const lat=+n.getAttribute('lat'), lon=+n.getAttribute('lon');
    const ele=+(n.querySelector('ele')?.textContent ?? 0);
    if (pLat!==null) d += hav(pLat,pLon,lat,lon);
    trackPts.push({ lat, lon, ele, d });
    pLat=lat; pLon=lon;
  });
  totalDist = d;

  smoothEle();
  precomputeProfileAndFarEnd();

  trackWpts.forEach(w => {
    let best=Infinity;
    trackPts.forEach(p => { const dd=hav(w.lat,w.lon,p.lat,p.lon); if(dd<best){best=dd;w.d=p.d;} });
  });

  drawTrack();
  drawProfile();
}

// One-pass precompute (avoids re-deriving these on every profile redraw / GPS fix):
//   • eleLo/eleHi/eleRange — smoothed-elevation bounds for the profile's Y scale.
//   • turnIdx/turnDist     — the far end (max distance from the trailhead). For an out-and-back
//     the GPX is a closed round trip, so this is the turnaround; progress locks here.
function precomputeProfileAndFarEnd() {
  eleLo = Infinity; eleHi = -Infinity;
  const p0 = trackPts[0]; let far = -1; turnIdx = 0;
  trackPts.forEach((p, i) => {
    if (p.se < eleLo) eleLo = p.se;
    if (p.se > eleHi) eleHi = p.se;
    const dd = hav(p0.lat, p0.lon, p.lat, p.lon);
    if (dd > far) { far = dd; turnIdx = i; }
  });
  eleRange = (eleHi - eleLo) || 1;
  turnDist = trackPts[turnIdx] ? trackPts[turnIdx].d : totalDist;
  isOutAndBack = curTrail.route === 'Out & back';
}

// 15-point centered moving average over raw GPX elevations → trackPts[i].se ("smoothed
// elevation"), used everywhere downstream (profile, cursor) to tame GPS elevation noise.
function smoothEle() {
  const w = 15, n = trackPts.length;
  const raw = trackPts.map(p => p.ele);
  for (let i=0;i<n;i++){
    const lo=Math.max(0,i-(w>>1)), hi=Math.min(n,i+(w>>1)+1);
    let s=0; for(let j=lo;j<hi;j++) s+=raw[j];
    trackPts[i].se = s/(hi-lo);
  }
}

function drawTrack() {
  const step = Math.max(1, Math.floor(trackPts.length/1200));
  // Keep the downsampled points (with cumulative distance .d) so the green progress overlay
  // can be sliced by distance; coords is just their [lat,lon] for the base polylines.
  renderPts = trackPts.filter((_,i)=>i%step===0||i===trackPts.length-1);
  const coords = renderPts.map(p=>[p.lat,p.lon]);
  walkedLayer = null;            // recreated lazily by recolorProgress() while tracking

  L.polyline(coords, { color:'#fff', weight:7.5, opacity:0.85, lineJoin:'round' }).addTo(map); // halo
  trackLayer = L.polyline(coords, { color:C.red, weight:4, opacity:0.98, lineJoin:'round' }).addTo(map);

  if (trackPts.length) {
    endMarker(trackPts[0], C.green, 'markerTrailhead');
    const last = trackPts[trackPts.length-1];
    const isLoop = curTrail.route === 'Loop' || hav(trackPts[0].lat,trackPts[0].lon,last.lat,last.lon) < 120;
    if (!isLoop) endMarker(last, C.red, 'markerEnd');
  }
  trackWpts.forEach(w => {
    w._marker = L.marker([w.lat,w.lon], { icon:dotIcon(C.amber,11) })
      .bindPopup(`<div class="wp-pop">${trWpt(w.name)}</div>`, {maxWidth:240})
      .addTo(map);
  });

  fitTrack();
}

// Fit the map to the full track, leaving room for the header (top) and the sheet peek (bottom).
// animate:false → the fit lands on its final center/zoom synchronously (no slide), so the
// applyMaxBounds() below reads the settled view and the clamp never has to chase a moving target.
function fitTrack() {
  if (map && trackLayer) map.fitBounds(trackLayer.getBounds(), { paddingTopLeft:[30,70], paddingBottomRight:[30, sheetPeekHeight()+30], animate:false });
  applyMaxBounds();   // re-clamp after a fit (zoomend won't fire if the fit didn't change zoom)
}

// Endpoint markers store an i18n key so labels can be re-rendered on language switch
function endMarker(p, color, key) {
  const mk = L.marker([p.lat,p.lon], { icon:dotIcon(color,15) })
    .bindPopup(`<div class="wp-pop">${t(key)}</div>`).addTo(map);
  mk._i18nKey = key;
  (endMarker._all ||= []).push(mk);
}

// Re-bind marker popups in the active language (called from setLang)
function redrawTrailLabels() {
  (endMarker._all || []).forEach(mk => {
    if (mk._i18nKey) mk.setPopupContent(`<div class="wp-pop">${t(mk._i18nKey)}</div>`);
  });
  trackWpts.forEach(w => { if (w._marker) w._marker.setPopupContent(`<div class="wp-pop">${trWpt(w.name)}</div>`); });
}

function dotIcon(color,size){
  const h=size/2;
  return L.divIcon({ className:'',
    html:`<div style="width:${size}px;height:${size}px;background:${color};border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,.6)"></div>`,
    iconSize:[size,size], iconAnchor:[h,h] });
}

// ── Elevation profile ──
// Profile Y for a smoothed elevation `se` (px within the PROF_H-tall viewBox). drawProfile and
// drawProfileCursor MUST map elevations identically, or the GPS/scrub dot drifts off the area —
// hence this single shared helper. Reads the cached eleLo/eleRange (set in loadTrail).
const profY = se => PROF_H - PROF_PAD_B - ((se-eleLo)/eleRange)*(PROF_H - PROF_PAD_B - PROF_PAD_T);

function drawProfile() {
  const svg = $('#elev-svg'); if (!svg || trackPts.length<2 || totalDist<=0) return;
  const W = svg.clientWidth || 340, H = PROF_H;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const step=Math.max(1,Math.floor(trackPts.length/500));
  const sub=trackPts.filter((_,i)=>i%step===0||i===trackPts.length-1);
  const X=dd=>(dd/totalDist)*W;

  let path=`M0,${H}`;
  sub.forEach(p=>{ path+=` L${X(p.d).toFixed(1)},${profY(p.se).toFixed(1)}`; });
  path+=` L${W},${H}Z`;
  let line=`M0,${profY(sub[0].se).toFixed(1)}`;
  sub.forEach(p=>{ line+=` L${X(p.d).toFixed(1)},${profY(p.se).toFixed(1)}`; });

  const wp = trackWpts.filter(w=>w.d!=null).map(w=>{
    const x=X(w.d).toFixed(1);
    return `<line x1="${x}" y1="4" x2="${x}" y2="${H}" stroke="${C.amber}" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>`;
  }).join('');

  svg.innerHTML = `
    <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.pine}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${C.pine}" stop-opacity="0.03"/>
    </linearGradient></defs>
    ${wp}
    <path d="${path}" fill="url(#eg)"/>
    <path d="${line}" fill="none" stroke="${C.pine}" stroke-width="1.75"/>
    <g id="epos"></g>`;
  $('#elev-range').textContent = fmtElevRange(eleLo, eleHi);
}

// Profile axis labels: feet in EN, meters in JA
function fmtElevRange(loM, hiM) {
  if (lang === 'ja') return `${Math.round(loM).toLocaleString()}～${Math.round(hiM).toLocaleString()} m`;
  return `${Math.round(loM*FT).toLocaleString()}–${Math.round(hiM*FT).toLocaleString()} ft`;
}

// Interpolated point at cumulative distance D (m) along the track: binary-search the monotonic
// trackPts[].d, then linearly blend the bracketing vertices. Used by the scrub and the progress
// overlay's exact split vertex. Returns {lat,lon,se,d,idx}.
function pointAtDistance(D){
  const n=trackPts.length; if(!n) return null;
  D=Math.max(0,Math.min(totalDist,D));
  let lo=0,hi=n-1;
  while(lo<hi){ const mid=(lo+hi+1)>>1; if(trackPts[mid].d<=D) lo=mid; else hi=mid-1; }
  const a=trackPts[lo], b=trackPts[Math.min(lo+1,n-1)];
  const seg=b.d-a.d, t=seg>1e-9 ? (D-a.d)/seg : 0;
  return { lat:a.lat+t*(b.lat-a.lat), lon:a.lon+t*(b.lon-a.lon), se:a.se+t*(b.se-a.se), d:D, idx:lo };
}

// Nearest track vertex to a lat/lon, scanning indices [from,to] (default = whole track).
// Returns {idx, dist} with dist in meters.
function nearestIdx(lat,lon,from=0,to=trackPts.length-1){
  let best=Infinity, bi=from;
  for(let i=from;i<=to;i++){ const dd=hav(lat,lon,trackPts[i].lat,trackPts[i].lon); if(dd<best){best=dd;bi=i;} }
  return { idx:bi, dist:best };
}

// Nearest DOWNSAMPLED render point (≤~1200, vs the full track of up to ~7k) to a lat/lon — used only
// for the non-tracking GPS profile cursor, where sub-vertex precision doesn't matter. Keeps the
// per-fix work bounded on the long trails (Enchantments, Fuji) instead of scanning every vertex.
function nearestRenderPt(lat,lon){
  let best=Infinity, bp=null;
  for(const p of renderPts){ const dd=hav(lat,lon,p.lat,p.lon); if(dd<best){best=dd;bp=p;} }
  return bp;
}

// Single point's elevation / distance-along, in the active language's units.
function fmtElev(m){ return lang==='ja' ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m*FT).toLocaleString()} ft`; }
function fmtDistAlong(m){ return lang==='ja' ? `${(m/1000).toFixed(1)} km` : `${(m/(MI_PER_KM*1000)).toFixed(1)} mi`; }

// Draw the profile cursor (vertical line + dot) for point p={d,se}. When `scrub` is true the dot
// is violet (matching the map marker) and the floating readout pill is shown; otherwise it's the
// blue GPS-position dot. Shared by GPS (onPos) and scrubbing.
function drawProfileCursor(p, scrub){
  const svg=$('#elev-svg'), g=$('#epos'); if(!svg||!g||!p||totalDist<=0) return;
  const W=svg.viewBox.baseVal.width||340, H=PROF_H;
  const x=(p.d/totalDist)*W, y=profY(p.se);
  g.innerHTML=
    `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="${C.ink}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="4,3"/>`+
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${scrub?C.violet:C.blue}" stroke="#fff" stroke-width="2"/>`;
  const tip=$('#scrub-tip');
  if(tip && scrub){
    tip.innerHTML=`${fmtElev(p.se)}<span class="d">${fmtDistAlong(p.d)}</span>`;
    tip.hidden=false;
    // Reuse the rects captured at gesture start to avoid a forced reflow each scrub frame.
    const r=scrubRect||svg.getBoundingClientRect(), card=scrubCardRect||svg.closest('#elev-card').getBoundingClientRect();
    const cssX=(r.left-card.left)+(p.d/totalDist)*r.width, half=tip.offsetWidth/2;
    tip.style.left=Math.max(half+2, Math.min(card.width-half-2, cssX))+'px';
  }
}

// Put the blue GPS cursor back on the profile at the current position, if any (used after the
// profile SVG is rebuilt or a scrub ends). onPos draws its own cursor from the fresh fix. Skips while
// a scrub is active OR a readout is held, so it never overwrites the inspected point.
function syncGpsCursor(){
  if(!curPos || !trackPts.length || scrubbing || scrubHeld) return;
  if(tracking && !paused && progIdx>=0) drawProfileCursor(trackPts[progIdx], false);
  else { const rp=nearestRenderPt(curPos.lat,curPos.lon); if(rp) drawProfileCursor(rp, false); }
}

// ── Elevation scrubbing (with a persistent, tap-to-toggle inspected point) ──
// Bound once (from bindGlobal) via delegation, since the profile SVG is rebuilt on every language
// switch / sheet re-render. touch-action:none + user-select:none on #elev-card keep the drag from
// scrolling the sheet or selecting text; window-level move/up listeners track the finger past the edge.
//
// Interaction model:
//   • Press-drag → live readout that follows the finger; on release the dot + vertical line + readout
//     PERSIST, so you can let go and study them.
//   • Tap on an empty profile → reveals the readout at that point and persists it.
//   • Tap while a readout is held → clears it.
// The held point is remembered by distance (scrubHeldD), so it survives a profile redraw (resize / lang).
function placeScrub(p){
  drawProfileCursor(p, true);
  if(!scrubMk){
    scrubMk=L.marker([p.lat,p.lon], { interactive:false, zIndexOffset:900,
      icon:L.divIcon({ className:'', html:'<div class="scrub-dot"></div>', iconSize:[16,16], iconAnchor:[8,8] }) }).addTo(map);
  } else scrubMk.setLatLng([p.lat,p.lon]);
}
function initProfileScrub(){
  document.addEventListener('pointerdown', e=>{
    if(!e.target.closest || !e.target.closest('#elev-svg') || trackPts.length<2) return;
    const svg=$('#elev-svg');
    scrubRect=svg.getBoundingClientRect();
    scrubCardRect=svg.closest('#elev-card').getBoundingClientRect();   // cached for the readout pill
    scrubbing=true; scrubMoved=false; scrubStartX=e.clientX; scrubStartHeld=scrubHeld;
    // Empty state → reveal the readout on press, so a plain tap and a press-and-hold both show it. If
    // a readout is already held, hold off — this gesture might be a tap to clear it or a drag to move
    // it; only an actual drag (movement, in onScrubMove) should reposition it.
    if(!scrubHeld) applyScrub(e.clientX);
    window.addEventListener('pointermove', onScrubMove);
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    e.preventDefault();
  });
}
function onScrubMove(e){
  scrubX=e.clientX;
  if(Math.abs(scrubX-scrubStartX) > 6) scrubMoved=true;          // past the tap slop → it's a drag
  if(!scrubRAF) scrubRAF=requestAnimationFrame(()=>{ scrubRAF=0;
    if(scrubMoved || !scrubStartHeld) applyScrub(scrubX); });    // follow the finger on a drag (or any move in an empty-state gesture)
}
function applyScrub(clientX){
  const rect=scrubRect; if(!rect) return;
  let f=(clientX-rect.left)/rect.width; f=Math.max(0,Math.min(1,f));
  scrubHeldD=f*totalDist;
  const p=pointAtDistance(scrubHeldD); if(!p) return;
  placeScrub(p);
}
function endScrub(e){
  scrubbing=false;
  window.removeEventListener('pointermove', onScrubMove);
  window.removeEventListener('pointerup', endScrub);
  window.removeEventListener('pointercancel', endScrub);
  if(scrubRAF){ cancelAnimationFrame(scrubRAF); scrubRAF=0; }
  // A clean tap (no drag) on a HELD readout dismisses it; otherwise a readout is on screen (revealed
  // on press, or moved by a drag) → persist it. A pointercancel (the OS interrupting the gesture) is
  // never treated as a deliberate tap, so it never clears.
  const wasTap = !scrubMoved && (!e || e.type!=='pointercancel');
  if(wasTap && scrubStartHeld) clearScrub();
  else scrubHeld=true;
}
// Remove the scrub marker + readout + held point, then restore the profile cursor to the GPS position
// (if any). The single source of truth for "no readout is shown" (scrubHeld=false).
function clearScrub(){
  if(scrubMk){ scrubMk.remove(); scrubMk=null; }
  const tip=$('#scrub-tip'); if(tip) tip.hidden=true;
  const g=$('#epos'); if(g) g.innerHTML='';
  scrubHeld=false;
  syncGpsCursor();
}
// Re-place a persisted readout after the profile SVG is rebuilt (resize / language switch) so the held
// dot + line + reading survive. No-op when nothing is held.
function redrawScrubCursor(){
  if(!scrubHeld || trackPts.length<2 || totalDist<=0) return;
  const p=pointAtDistance(scrubHeldD); if(p) placeScrub(p);
}

// ════════════════════════════════════════════════════════════
//  GPS
// ════════════════════════════════════════════════════════════
function toggleGPS(){
  if (gpsWatch !== null) {
    if (!gpsFollow && curPos) { gpsFollow=true; $('#btn-gps').classList.add('on'); map.setView([curPos.lat,curPos.lon], Math.max(map.getZoom(),15)); }
    else stopGPS();
    return;
  }
  startGPS();
}
function startGPS(){
  if (!navigator.geolocation){ alert(t('alertNoGeo')); return; }
  reqWake(); gpsFollow=true;
  $('#btn-gps').classList.add('on');
  setLocating(true);                       // waiting for the first fix
  gpsWatch = navigator.geolocation.watchPosition(onPos,onPosErr,{enableHighAccuracy:true,maximumAge:4000,timeout:30000});
}
function stopGPS(){
  if (gpsWatch!==null){ navigator.geolocation.clearWatch(gpsWatch); gpsWatch=null; }
  relWake(); gpsFollow=false; curPos=null; setLocating(false);
  if(gpsMk){gpsMk.remove();gpsMk=null;} if(gpsAcc){gpsAcc.remove();gpsAcc=null;}
  $('#btn-gps').classList.remove('on');
  const ep=$('#epos'); if(ep) ep.innerHTML='';
}
function onPos(pos){
  const {latitude:lat,longitude:lon,accuracy}=pos.coords;
  curPos={lat,lon}; setLocating(false);   // a fresh fix landed
  if(!gpsMk){
    gpsMk=L.marker([lat,lon],{pane:'gpsPane',icon:L.divIcon({className:'',html:'<div class="gps-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]}),zIndexOffset:1000}).addTo(map);
    gpsAcc=L.circle([lat,lon],{pane:'gpsPane',radius:accuracy,fillColor:C.blue,fillOpacity:0.08,color:C.blue,weight:1}).addTo(map);
  } else { gpsMk.setLatLng([lat,lon]); gpsAcc.setLatLng([lat,lon]); gpsAcc.setRadius(accuracy); }
  if(gpsFollow) map.setView([lat,lon], Math.max(map.getZoom(),15), {animate:true});
  if(freeHike){
    saveLastPos(lat,lon);
    swapTileSource(regionSourceKey(lat,lon));   // basemap to match the region (no-op after the first fix)
    if(tracking && !paused) recordFix(lat,lon,accuracy);
    return;
  }
  if(tracking && !paused) updateProgress(lat,lon,accuracy);
  if(trackPts.length && !scrubbing && !scrubHeld){
    // While tracking, reuse the windowed snap index (cheaper than a full-track scan, and it
    // won't jump the cursor to the wrong overlapping leg of an out-and-back); else use the nearest
    // DOWNSAMPLED render point so the per-fix cost stays bounded on long trails.
    if(tracking && !paused && progIdx>=0) drawProfileCursor(trackPts[progIdx], false);
    else { const rp=nearestRenderPt(lat,lon); if(rp) drawProfileCursor(rp, false); }
  }
}
function onPosErr(err){ setLocating(false); if(err.code===1){ alert(t('alertDenied')); stopGPS(); } }

// "Locating…" indicator — shown while waiting for a fresh fix (GPS start, or a screen-on refresh),
// hidden the moment a fix lands or the attempt errors. A safety timer hides it if neither fires.
function setLocating(on){
  const el=$('#gps-locating'); if(!el) return;
  clearTimeout(locatingTimer); locatingTimer=null;
  // Watchdog outlasts the 30 s geolocation timeout so the GPS error callback (not this timer) wins
  // and drives the hide — the pill shouldn't vanish to a false "located" while a fix is still pending.
  if(on){ el.hidden=false; locatingTimer=setTimeout(()=>{ el.hidden=true; }, 35000); }
  else el.hidden=true;
}

async function reqWake(){
  if(wakeReq || !('wakeLock'in navigator)) return;     // a request is already in flight, or unsupported
  if(wakeLock && !wakeLock.released) return;            // already holding a live lock — don't stack a 2nd
  wakeReq=true;
  try{ wakeLock=await navigator.wakeLock.request('screen'); }catch(_){}
  finally{ wakeReq=false; }
}
async function relWake(){ if(wakeLock){try{await wakeLock.release();}catch(_){}wakeLock=null;} }

// Re-issue the position watch. After a screen-off gap iOS can leave watchPosition silently DEAD
// (no fixes, no error), so a one-shot getCurrentPosition alone paints one fix and then nothing more.
// Clearing + reopening the watch restores continuous fixes; re-issuing inside an already-granted
// session does NOT re-prompt for permission on iOS.
function restartWatch(){
  if(!navigator.geolocation) return;
  if(gpsWatch!==null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = navigator.geolocation.watchPosition(onPos,onPosErr,{enableHighAccuracy:true,maximumAge:4000,timeout:30000});
}

// Back from a screen-off gap: the snap window is stale and the watch may be dead. Revive the watch,
// arm an immediate re-acquire, and kick one fresh high-accuracy fix so the dot/progress/clock refresh
// within ~a second of looking — not after several windowed misses. Deduped by gpsWakePending so a
// rapid lock/unlock (or a pageshow+visibilitychange double-fire) can't stack overlapping requests.
function refreshGpsAfterGap(){
  if(gpsWakePending) return;
  gpsWakePending=true;
  // Self-heal: ALWAYS release the dedupe flag after the one-shot's own timeout, even if iOS fires
  // NEITHER GPS callback (it can silently abandon a getCurrentPosition when the phone is re-pocketed
  // mid-flight). Without this backstop the flag could stick true and every later wake would bail at
  // the guard above → GPS frozen for the rest of the hike with no recovery path.
  clearTimeout(gpsWakeGuard);
  gpsWakeGuard=setTimeout(()=>{ gpsWakePending=false; }, 32000);
  reacqMiss = REACQUIRE_AFTER;
  recBreak = true;                  // free hike: continuity was lost, so the next fix starts a new line segment
  setLocating(true);
  restartWatch();
  const settle=()=>{ gpsWakePending=false; clearTimeout(gpsWakeGuard); };
  navigator.geolocation.getCurrentPosition(
    p =>{ settle(); onPos(p); },
    () =>{ settle(); setLocating(false); },
    {enableHighAccuracy:true, maximumAge:0, timeout:30000});
}

// ── App lifecycle (iOS) ──
// iOS suspends a resident PWA (lock / app-switch → page survives, no reload) or terminates it
// (memory eviction → fresh load + bootRoute). It fires lifecycle events inconsistently, so we hook
// several and keep each handler idempotent. PERSIST on both visibilitychange→hidden AND pagehide
// (whichever fires before suspension); WAKE on both visibilitychange→visible AND pageshow (bfcache
// restore). Persisting on every accepted fix (updateProgress) is the durability backstop for a hard
// kill that fires no event at all. Clearing gpsWakePending on hide is the self-heal for a wake-time
// getCurrentPosition that iOS abandons mid-flight when the phone is re-pocketed (neither callback
// fires): without it the flag sticks true and every later refreshGpsAfterGap bails, leaving GPS dead.
function onHide(){ persistSession(); gpsWasHidden = gpsWatch!==null; gpsWakePending=false; clearTimeout(gpsWakeGuard); }

function onWake(){
  updateListResume();                  // keep the list's "resume hike" banner current after a resident wake
  // On a trail screen but not tracking, with a resumable session for THIS trail and no prompt up yet,
  // re-surface the resume offer (covers a resident wake where the offer was never shown). bootRoute
  // owns the initial-load resume (booting), and openDetail owns its own post-load resume
  // (openingDetail) — stand down while either is in charge, else the prompt can flash then be replaced.
  if(!booting && !openingDetail && !tracking && (curTrail || freeHike) && !pendingResume){
    const s=readSession();
    if(freshResumable(s) && sessionMatchesScreen(s)) maybeOfferResume();
  }
  if(tracking) updateHUD();             // repaint the clock now (the 1s interval was suspended while hidden)
  if(gpsWatch!==null){
    // iOS auto-releases the screen Wake Lock every time the page hides, but leaves our sentinel
    // reference truthy (only its .released flips). Re-acquire when there's no LIVE lock — testing
    // .released as well as null is what makes this fire on the 2nd+ screen-on (a bare !wakeLock
    // guard saw the stale released sentinel and never re-locked, so the screen auto-locked for the
    // rest of the hike).
    if(!wakeLock || wakeLock.released) reqWake();
    // Refresh the fix only when fixes actually matter. While paused, onPos ignores fixes and arming
    // a re-acquire would taint the eventual un-pause (a spurious wrong-leg re-snap) — so skip it; the
    // wake-lock re-acquire above still runs so the screen stays on if the user un-pauses.
    if(gpsWasHidden && !(tracking && paused)) refreshGpsAfterGap();
  }
  gpsWasHidden=false;
}

document.addEventListener('visibilitychange',()=>{ if(document.hidden) onHide(); else onWake(); });
window.addEventListener('pagehide', onHide);
window.addEventListener('pageshow', onWake);

// ════════════════════════════════════════════════════════════
//  Free hike — record your own route (no preset trail)
//  Reuses the detail screen's map + GPS + Wake Lock + tracking session machinery; the difference
//  is the per-fix handler (recordFix appends to a drawn polyline instead of snapping to a GPX) and
//  the HUD readout (recorded distance instead of trail %). curTrail stays null; `freeHike` is the flag.
// ════════════════════════════════════════════════════════════

// GSI 地理院タイル only covers Japan; everywhere else uses USGS topo. Rough Japan bbox (incl. the
// southern islands). Picks the basemap for a free hike from the first GPS fix.
function regionSourceKey(lat,lon){ return (lat>=24 && lat<=46 && lon>=122 && lon<=154) ? 'gsi' : 'usgs'; }

// Last GPS fix, persisted so a free hike opens centered on where you were last (no blank world map
// while the first fix lands). Rounded to ~1 m; tiny + synchronous, like the rest of our localStorage.
function readLastPos(){ try{ const v=JSON.parse(localStorage.getItem(LAST_POS_KEY)||'null'); return (Array.isArray(v)&&v.length===2)?v:null; }catch(_){ return null; } }
function saveLastPos(lat,lon){ try{ localStorage.setItem(LAST_POS_KEY, JSON.stringify([+lat.toFixed(5),+lon.toFixed(5)])); }catch(_){} }

async function openFreeHike(){
  // Same resume-handoff dance as openDetail: capture+consume resumeOnOpen, hold openingDetail so a
  // racing wake doesn't double-offer. No GPX to await, so this resolves synchronously.
  const resumeThis = resumeOnOpen; resumeOnOpen = false;
  openingDetail = true;
  curTrail = null; freeHike = true;
  stopTracking(); hideResumePrompt(); scrubbing = false; scrubHeld = false;
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = t('freeHike');
  renderFreeHikePeek();
  const saved = readLastPos();
  const center = saved || (TRAILS[0] && TRAILS[0].center) || [47.6, -122.3];
  initMap(center, saved ? regionSourceKey(saved[0], saved[1]) : 'usgs');   // sets freeHikeSource
  renderFreeHikeBody();        // after initMap so the basemap credit matches the chosen source
  setSheet('peek');
  const s = readSession();
  if (resumeThis && freshResumable(s) && s.hike) resumeSession(s);   // resumeSession (re)starts GPS itself
  else { startGPS(); maybeOfferResume(); }                          // location-first: show the blue dot right away
  openingDetail = false;
}

function renderFreeHikePeek(){
  $('#pk-title').textContent = t('freeHike');
  updateFreeHikePeek();
}
// Live peek meta: recorded distance + elapsed while recording, else a how-to hint. Called from
// updateHUD so the numbers tick with the HUD.
function updateFreeHikePeek(){
  if(!freeHike) return;
  const meta=$('#pk-meta'); if(!meta) return;
  meta.innerHTML = tracking
    ? `<span class="s">${icon('dist')}${fmtDistAlong(recDist)}</span>` +
      `<span class="s">${icon('clock')}${fmtElapsed(elapsedMs())}</span>`
    : `<span class="s">${t('fhHint')}</span>`;
}
function renderFreeHikeBody(){
  const src = TILE_SOURCES[freeHikeSource] || TILE_SOURCES.usgs;
  $('#sheet-body').innerHTML = `
    <div class="section">
      <h3>${t('fhAboutTitle')}</h3>
      <p>${t('fhAbout')}</p>
    </div>
    <div class="section">
      <h3>${t('fhTipsTitle')}</h3>
      <ul class="tips">${(t('fhTips')||[]).map(x=>`<li>${x}</li>`).join('')}</ul>
    </div>
    <div class="section">
      <p class="attrib">${t(src.creditKey)}</p>
    </div>`;
}

// Swap the basemap once a free hike's first fix reveals the region (USGS↔GSI). No-op unless the
// source actually changes, so it fires at most once per hike (in practice on the first fix).
function swapTileSource(srcKey){
  if(srcKey===freeHikeSource || !map) return;
  freeHikeSource=srcKey;
  const src=TILE_SOURCES[srcKey];
  if(tileLayer) tileLayer.remove();
  tileLayer=L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:DL_MIN_Z, attribution:src.leaflet, crossOrigin:true }).addTo(map);
  if(freeHike) renderFreeHikeBody();   // refresh the basemap credit line
}

// Append one accepted fix to the recorded path. Drops fixes worse than REC_MAX_ACC_M (a wild jump
// would zig-zag the line + inflate distance) and ignores sub-REC_MIN_MOVE_M steps (stationary GPS
// jitter). A `recBreak` (set on pause-resume or a screen-off GPS gap) starts a NEW line segment so
// the path isn't drawn — or counted — as a straight line across ground we didn't actually record.
// Mirrors progress to localStorage only when a point is added, so a stationary phone doesn't churn writes.
function recordFix(lat,lon,acc){
  if(acc>REC_MAX_ACC_M){ if(!trackSearching){ trackSearching=true; updateHUD(); } return; }
  if(recBreak){                                       // continuity was lost → close the old segment, start fresh
    recBreak=false; recLast=null;
    if(!recSegs.length || recSegs[recSegs.length-1].length) recSegs.push([]);
  }
  if(!recSegs.length) recSegs.push([]);
  if(recLast){
    const step=hav(recLast.lat,recLast.lon,lat,lon);
    if(step<REC_MIN_MOVE_M){ if(trackSearching){ trackSearching=false; updateHUD(); } return; }
    recDist+=step;
  }
  recLast={lat,lon};
  recSegs[recSegs.length-1].push([+lat.toFixed(5), +lon.toFixed(5)]);
  trackSearching=false;
  drawRecLine();
  updateHUD();
  persistSession();
}

// Draw the recorded path: a start dot at the very first point, then a white-haloed green line.
// Segments are passed to Leaflet as an array-of-arrays (a multi-polyline), so a paused/screen-off
// gap shows as a break rather than a bogus straight line.
function drawRecLine(){
  if(!map || !recSegs.length) return;
  const first = recSegs[0][0];
  if(first && !recStartMk) recStartMk=L.marker(first, { icon:dotIcon(C.green,15) }).addTo(map);
  const lines = recSegs.filter(s => s.length>=2);     // a lone point can't draw a line yet
  if(!lines.length) return;
  if(!recLayer){
    recHalo=L.polyline(lines,{ color:'#fff', weight:7.5, opacity:0.85, lineJoin:'round' });
    recLine=L.polyline(lines,{ color:C.green, weight:4, opacity:0.97, lineJoin:'round' });
    recLayer=L.layerGroup([recHalo, recLine]).addTo(map);
  } else { recHalo.setLatLngs(lines); recLine.setLatLngs(lines); }
}

// ════════════════════════════════════════════════════════════
//  Live trail progress
//  Start a session → each GPS fix snaps to the trail, fills the walked portion green,
//  and the HUD shows percent + elapsed time. Out-and-back progress locks at the far end
//  so the return leg never un-colors the trail.
// ════════════════════════════════════════════════════════════

// The track FAB only ever STARTS (or continues a pending resume). Pause/resume and end live in the
// HUD, so a stray tap on the map — common when "just checking" the screen mid-hike — can never pause
// or reset an active session. While a session is live (or paused, or a resume is being offered) the
// FAB is hidden and the HUD/prompt own the controls.
function onTrackFab(){
  if(tracking) return;                       // hidden while tracking; ignore any stray tap
  if(pendingResume){ const s=pendingResume; hideResumePrompt(); resumeSession(s); return; }  // continue, don't start over
  startTracking();
}
// HUD pause/resume button — the ONLY way to pause, so pausing is always deliberate.
function togglePause(){
  if(!tracking) return;
  paused=!paused;
  if(paused) trackElapsedMs+=Math.max(0,Date.now()-trackStartTs);   // bank elapsed (clamped vs a backward clock), freeze
  else {                                                            // resume from now; ensure live, FRESH fixes
    trackStartTs=Date.now();
    recBreak=true;                         // free hike: don't draw/count a straight line across the paused gap
    if(gpsWatch===null) startGPS();        // watch was off → (re)start it
    else refreshGpsAfterGap();             // watch survived a long pocket-pause → revive it + re-acquire (it may be dead, progIdx is stale)
  }
  updateTrackUI(); updateHUD();
  persistSession();
}
// 1 s HUD clock; also re-persists every ~30 s so `savedAt` stays fresh near the 18 h window even
// during a long GPS-quiet stretch — INCLUDING while paused (a summit nap / long lunch), so a paused
// session doesn't age toward staleness and get dropped. localStorage writes are synchronous, cheap.
function startHudTimer(){
  clearInterval(hudTimer); hudTicks=0;
  hudTimer=setInterval(()=>{ updateHUD(); if(tracking && (++hudTicks%30===0)) persistSession(); }, 1000);
}
function startTracking(){
  if(!navigator.geolocation){ alert(t('alertNoGeo')); return; }
  hideResumePrompt();                      // starting fresh overrides any offered resume
  tracking=true; paused=false;
  trackStartTs=Date.now(); trackElapsedMs=0;
  walkedDist=0; progIdx=-1; reacqMiss=0; turnedAround=false; trackSearching=false;
  recSegs=[]; recDist=0; recLast=null; recBreak=false;
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=walkedHalo=walkedLine=null; }
  if(recLayer){ recLayer.remove(); recLayer=recHalo=recLine=null; }
  if(recStartMk){ recStartMk.remove(); recStartMk=null; }
  $('#track-hud').hidden=false;
  if(gpsWatch===null) startGPS();          // tracking needs live fixes
  startHudTimer();
  updateTrackUI(); updateHUD();
  persistSession();
}
// Reset the in-memory session (used on navigation / trail-switch). Leaves the saved session in
// localStorage intact so reopening the trail can still offer a resume; only endTracking() forgets it.
function stopTracking(){
  tracking=false; paused=false; reacqMiss=0; trackSearching=false;
  clearInterval(hudTimer); hudTimer=null;
  const hud=$('#track-hud'); if(hud){ hud.hidden=true; hud.classList.remove('freehike'); }
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=walkedHalo=walkedLine=null; }
  walkedDist=0; progIdx=-1; trackElapsedMs=0; turnedAround=false;
  if(recLayer){ recLayer.remove(); recLayer=recHalo=recLine=null; }
  if(recStartMk){ recStartMk.remove(); recStartMk=null; }
  recSegs=[]; recDist=0; recLast=null; recBreak=false;
  updateTrackUI();
  updateFreeHikePeek();   // free hike: revert the peek from live stats back to the start hint (no-op for trails)
}
// Explicit end (HUD ✕): forget the saved session, then stop.
function endTracking(){ clearSession(); stopTracking(); }
// Reflect tracking state across both controls: the start-only FAB is hidden whenever a session is
// live/paused or a resume is being offered; the HUD pause button shows pause (live) vs resume (paused).
function updateTrackUI(){
  const fab=$('#btn-track');
  if(fab){
    fab.hidden = tracking || !!pendingResume;
    fab.innerHTML = ICON_PLAY;
    fab.setAttribute('aria-label', t(freeHike ? 'fhStartAria' : 'trackStartAria'));
  }
  const pb=$('#th-pause');
  if(pb){
    pb.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    pb.classList.toggle('paused', paused);
    pb.setAttribute('aria-label', t(paused ? 'trackResumeAria' : 'trackPauseAria'));
  }
}

// Off-trail gate: reject fixes whose nearest vertex is implausibly far, scaled to the reported
// GPS accuracy (tighter for good fixes, looser under tree cover) and clamped to a sane range.
function offTrailGate(acc){ return Math.max(25, Math.min(60, 2.5*(acc||20))); }

// Re-snap to the track from scratch (first fix, or after the windowed search went stale). Among
// vertices within the gate, take the one whose distance-along is CLOSEST to `near` (the progress
// already reached). On the first fix near=0, so this picks the smallest-d vertex — the trailhead
// side, never the geographically-overlapping return leg of an out-and-back (which would read as
// near-complete). Mid-hike near=walkedDist, so a re-acquire on the RETURN leg snaps to the return
// vertex (d≈walkedDist) instead of jumping ~km backward onto the overlapping outbound leg (which
// would make the elevation-profile GPS cursor leap backward on every screen-wake during the descent).
function acquireIdx(lat,lon,gate,near=0,lo=0,hi=trackPts.length-1){
  let bi=-1, bd=Infinity, biDist=Infinity;
  for(let i=lo;i<=hi;i++){
    const dd=hav(lat,lon,trackPts[i].lat,trackPts[i].lon);
    if(dd<=gate){ const key=Math.abs(trackPts[i].d-near); if(key<bd){ bd=key; bi=i; biDist=dd; } }
  }
  return bi<0 ? nearestIdx(lat,lon,lo,hi) : { idx:bi, dist:biDist };
}
function updateProgress(lat,lon,accuracy){
  const n=trackPts.length; if(n<2) return;
  const gate=offTrailGate(accuracy);
  let r;
  if(progIdx<0 || reacqMiss>=REACQUIRE_AFTER){      // first fix, OR the window went stale (repeated
    // misses): re-acquire whole-track, nearest the progress already reached (keeps the right leg).
    // Once an out-and-back has reached the turnaround (turnedAround latched below), the outbound and
    // return legs overlap geographically, so the "closest distance-along to walkedDist" tie-break
    // can't reliably pick the return vertex — restrict the scan to the RETURN half [turnIdx..end].
    // Without this, every descent re-acquire (each screen-wake) re-snaps onto the coincident OUTBOUND
    // leg and the elevation cursor / progIdx leap back up the climb.
    const lo = (isOutAndBack && turnedAround) ? turnIdx : 0;
    r=acquireIdx(lat,lon,gate,walkedDist,lo);       // re-acquire (whole track, or return leg only)
  } else {
    const avg=totalDist/(n-1)||1;                   // forward window around the last snap
    const from=Math.max(0, progIdx-Math.ceil(SNAP_BACK_M/avg));
    const to  =Math.min(n-1, progIdx+Math.ceil(SNAP_FWD_M/avg));
    r=nearestIdx(lat,lon,from,to);
  }
  if(r.dist>gate){                                  // off-trail/out-of-window: hold, count the miss
    reacqMiss++;
    // After sustained rejections (e.g. a viewpoint just off the line, or weak signal under tree
    // cover) progress would silently stall with no explanation — surface a HUD hint so the frozen
    // percent reads as "searching", not "broken". Cleared the moment a fix is accepted again.
    const wasSearching = trackSearching;
    trackSearching = reacqMiss >= REACQUIRE_AFTER;
    if(trackSearching !== wasSearching) updateHUD();
    return;
  }
  reacqMiss=0; trackSearching=false;
  progIdx=r.idx;
  // Only recolor when the high-water mark actually advances (walkedDist is monotonic), so a
  // stationary or backward-jittering fix doesn't rebuild the polyline for an identical line.
  if(trackPts[r.idx].d>walkedDist){ walkedDist=trackPts[r.idx].d; recolorProgress(); }
  // Latch "turned around" once we snap at/past the turn index (the normal continuous-tracking path)
  // OR get within a small slack of the turnaround distance (a safety net for a screen-off gap right
  // at the summit, where sparse fixes can leave walkedDist just short of turnDist — the exact-distance
  // check this replaced was why the descent still mis-snapped). Stays latched for the session, so
  // every re-acquire on the long descent stays on the return leg. The slack is small (SNAP_BACK_M) so
  // a wake during the final approach can't falsely fling progress past the summit.
  if(isOutAndBack && !turnedAround && (progIdx>=turnIdx || walkedDist>=turnDist-SNAP_BACK_M)) turnedAround=true;
  updateHUD();
  persistSession();                                 // mirror progress so a reload can resume
}

// Green overlay over the red base track, covering everything walked (cumulative distance
// ≤ walkedDist) with an exact end vertex. For an out-and-back the return leg overlaps the
// outbound on the map, so extending the overlay along it keeps the line green without
// un-coloring; walkedDist is monotonic so it never shrinks.
function recolorProgress(){
  if(!map || !renderPts.length) return;
  const D=walkedDist, coords=[];
  for(const p of renderPts){ if(p.d<=D) coords.push([p.lat,p.lon]); else break; }
  if(D>0){ const j=pointAtDistance(D); if(j) coords.push([j.lat,j.lon]); }
  if(coords.length<2){ if(walkedLayer){ walkedLayer.remove(); walkedLayer=walkedHalo=walkedLine=null; } return; }
  if(!walkedLayer){
    // Mirror the base track (drawTrack): a white halo UNDER the green line, so the walked overlay is
    // exactly as wide as the red track and fully hides it — no red peeking out beside a thinner line.
    walkedHalo=L.polyline(coords,{ color:'#fff', weight:7.5, opacity:0.85, lineJoin:'round' });
    walkedLine=L.polyline(coords,{ color:C.green, weight:4, opacity:0.97, lineJoin:'round' });
    walkedLayer=L.layerGroup([walkedHalo, walkedLine]).addTo(map);
  } else { walkedHalo.setLatLngs(coords); walkedLine.setLatLngs(coords); }
}

function elapsedMs(){ return trackElapsedMs + ((tracking && !paused) ? Math.max(0, Date.now()-trackStartTs) : 0); }
function fmtElapsed(ms){
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  const pad=x=>String(x).padStart(2,'0');
  return (h ? `${h}:${pad(m)}` : `${m}`) + ':' + pad(sec);
}
function updateHUD(){
  const hud=$('#track-hud'); if(!hud || hud.hidden) return;
  hud.classList.toggle('freehike', freeHike);
  if(freeHike){
    // No preset trail to measure against: show recorded distance (in the % slot) + elapsed.
    $('.th-pct').textContent = fmtDistAlong(recDist);
    $('.th-num').textContent = fmtElapsed(elapsedMs());
    const m = paused ? t('trackPaused') : trackSearching ? t('trackWeakSignal') : '';
    const msg=$('.th-msg'); msg.textContent=m; msg.hidden=!m;
    hud.classList.toggle('paused', paused);
    updateFreeHikePeek();
    return;
  }
  // Out-and-back % is measured to the far end (turnDist) so reaching it reads 100%; loop and
  // point-to-point measure against the full length.
  const total = isOutAndBack ? turnDist : totalDist;
  const pct = total>0 ? Math.min(100, Math.round(walkedDist/total*100)) : 0;
  $('.th-fill').style.width = pct+'%';
  $('.th-pct').textContent = pct+'%';
  $('.th-num').textContent = fmtElapsed(elapsedMs());
  // Paused takes precedence so the frozen clock is explained; then the searching/weak-signal hint;
  // else the turnaround/complete cue.
  const m = paused ? t('trackPaused')
          : trackSearching ? t('trackWeakSignal')
          : pct>=100 ? t(isOutAndBack ? 'trackTurnaround' : 'trackComplete') : '';
  const msg=$('.th-msg'); msg.textContent=m; msg.hidden=!m;
  hud.classList.toggle('paused', paused);
}

// ── Session persistence + resume ──
// iOS suspends/evicts a backgrounded PWA, so a hike's progress can vanish mid-walk (the phone
// pocketed on a long climb). We mirror the live session to localStorage on every accepted fix and
// whenever the page is hidden; reopening the trail offers to restore it. The start timestamp is
// absolute, so the elapsed clock keeps counting across the gap when resumed.
function persistSession(){
  if(!tracking) return;
  try{
    if(freeHike){
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        hike:true, recSegs, recDist, trackStartTs, trackElapsedMs, paused, savedAt:Date.now(),
      }));
      return;
    }
    if(!curTrail) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      slug:curTrail.slug, walkedDist, progIdx,
      trackStartTs, trackElapsedMs, paused, savedAt:Date.now(),
    }));
  }catch(_){}
}
function readSession(){ try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(_){ return null; } }
function clearSession(){ try{ localStorage.removeItem(SESSION_KEY); }catch(_){} }

// Elapsed for a saved session, computed live (running → keeps counting wall-clock since its
// absolute start; paused → frozen at its banked total) — same rule as elapsedMs(). The Math.max(0)
// guards a backward device-clock step (iOS NTP correction after hours off-grid): without it elapsed
// could go negative and freshResumable would silently discard a genuine multi-hour hike as "short".
function savedElapsedMs(s){ return (s.trackElapsedMs||0) + (s.paused ? 0 : Math.max(0, Date.now()-s.trackStartTs)); }

// Is a saved session worth auto-resuming/offering? The single shared predicate for every resume
// path (boot, wake, open-trail, list banner). Fresh = its trail exists and savedAt is within the
// staleness window. A RUNNING session must also clear the short-session floor (filters accidental
// starts); a PAUSED session is exempt — pausing is deliberate, so honor it however short.
function freshResumable(s){
  return !!s && (s.hike || TRAILS.some(x => x.slug === s.slug))
    && (Date.now() - (s.savedAt || 0) <= SESSION_MAX_AGE_MS)
    && (s.paused || savedElapsedMs(s) >= RESUME_MIN_MS);
}

// Does the saved session belong to the screen we're on now? A free hike resumes any saved hike; a
// trail resumes only its own (non-hike) session. The single gate for every resume path.
function sessionMatchesScreen(s){
  if(!s) return false;
  return freeHike ? !!s.hike : (!!curTrail && !s.hike && s.slug===curTrail.slug);
}

// On opening a trail or a free hike, offer to resume a saved session for it (unless it's gone
// stale/trivial).
function maybeOfferResume(){
  const s=readSession();
  if(!sessionMatchesScreen(s)) return;                               // none, or it's another screen's
  if(Date.now()-(s.savedAt||0) > SESSION_MAX_AGE_MS){ clearSession(); return; }   // too old
  if(!s.paused && savedElapsedMs(s) < RESUME_MIN_MS) return;         // running & trivially short — skip (paused is always offered)
  pendingResume=s;
  renderResumePrompt();
  $('#track-resume').hidden=false;
  updateTrackUI();                                                   // hide the start FAB while the prompt owns the choice
  requestAnimationFrame(()=>{ const r=$('#tr-resume'); if(r) r.focus(); });   // move focus into the alertdialog
}
function renderResumePrompt(){
  const s=pendingResume; if(!s) return;
  let detail;
  if(s.hike) detail = fmtDistAlong(s.recDist||0);
  else {
    const total = isOutAndBack ? turnDist : totalDist;
    detail = (total>0 ? Math.min(100, Math.round(s.walkedDist/total*100)) : 0) + '%';
  }
  $('#tr-msg').textContent = `${t('trackResumeMsg')} · ${detail} · ${fmtElapsed(savedElapsedMs(s))}`;
  $('#tr-resume').textContent = t('trackResume');
  $('#tr-dismiss').textContent = t('trackDismiss');
}
function hideResumePrompt(){ pendingResume=null; const el=$('#track-resume'); if(el) el.hidden=true; updateTrackUI(); }

// Restore a saved session: progress + the green overlay + the elapsed clock (which, thanks to the
// absolute start timestamp, now includes the time the app was gone), then go live again. The next
// few fixes re-acquire your real position via the windowed-snap miss counter.
function resumeSession(s){
  hideResumePrompt();
  tracking=true; paused=!!s.paused;
  trackStartTs=s.trackStartTs; trackElapsedMs=s.trackElapsedMs||0;
  if(s.hike){
    // Free hike: restore the recorded path + distance, redraw it, then go live. The elapsed clock
    // already accounts for the gap via the absolute start timestamp. recBreak makes the first new
    // fix start a fresh segment, so the post-gap reacquire isn't drawn as a line back to the old end.
    freeHike=true;
    recSegs=Array.isArray(s.recSegs)?s.recSegs:[];
    recDist=s.recDist||0;
    const lastSeg=recSegs.length?recSegs[recSegs.length-1]:null;
    const lastPt=lastSeg&&lastSeg.length?lastSeg[lastSeg.length-1]:null;
    recLast=lastPt?{lat:lastPt[0],lon:lastPt[1]}:null;
    recBreak=true; reacqMiss=0; trackSearching=false;
    $('#track-hud').hidden=false;
    drawRecLine();
    if(!paused){ if(gpsWatch===null) startGPS(); else refreshGpsAfterGap(); }
    startHudTimer();
    updateTrackUI(); updateHUD();
    persistSession();
    return;
  }
  walkedDist=s.walkedDist||0; progIdx=(s.progIdx>=0)?s.progIdx:-1;
  // Re-derive the out-and-back turnaround latch from the restored progress, so a relaunch on the
  // descent keeps re-acquiring onto the return leg (not the overlapping outbound leg).
  turnedAround = isOutAndBack && (progIdx>=turnIdx || walkedDist>=turnDist-SNAP_BACK_M);
  // The saved position is known-stale (the app was gone / the phone was pocketed), so arm an
  // immediate re-acquire: the first fix re-snaps from scratch via acquireIdx (nearest to walkedDist,
  // correct leg) instead of crawling forward through 3 rejected windowed fixes. Keep walkedDist so
  // the out-and-back leg disambiguation still holds.
  reacqMiss=REACQUIRE_AFTER;
  trackSearching=false;
  $('#track-hud').hidden=false;
  recolorProgress();
  if(!paused){ if(gpsWatch===null) startGPS(); else refreshGpsAfterGap(); }   // resume live, fresh fixes
  startHudTimer();
  updateTrackUI(); updateHUD();
  persistSession();                                 // re-stamp savedAt now that we're live again
}

// List-screen "resume hike" banner — the fallback way back into a saved session. On a cold relaunch
// bootRoute() already auto-routes a fresh active hike straight to its trail; this banner surfaces a
// saved session on the list after the user has navigated back here.
function updateListResume(){
  const el=$('#list-resume'); if(!el) return;
  const s=readSession();
  if(!freshResumable(s)){ el.hidden=true; delete el.dataset.slug; return; }
  const isHike = !!s.hike;
  const trail = isHike ? null : TRAILS.find(x=>x.slug===s.slug);
  if(!isHike && !trail){ el.hidden=true; delete el.dataset.slug; return; }
  el.querySelector('.lr-ic').innerHTML = ICON_PLAY;
  el.querySelector('.lr-label').textContent = t('resumeHike');
  el.querySelector('.lr-trail').textContent = isHike ? t('freeHike') : loc(trail).name;
  el.querySelector('.lr-time').textContent = fmtElapsed(savedElapsedMs(s));
  el.dataset.slug = isHike ? HIKE_SLUG : trail.slug;
  el.hidden=false;
}

// ════════════════════════════════════════════════════════════
//  Bottom sheet drag
// ════════════════════════════════════════════════════════════
// Peek (closed) height: tall enough to reveal the whole elevation chart so it can be scrubbed
// without opening the sheet (otherwise the synced map indicator is the only visible feedback),
// capped so the map stays usable. Cached in peekH so drag/resize don't re-measure each frame;
// recomputed by computePeekH() from the rendered sheet body (called at the top of setSheet).
let peekH = 0;
function computePeekH(){
  const card=$('#elev-card'), fallback=Math.round(window.innerHeight*0.16);
  if(!card || $('#detail').hidden || matchMedia('(orientation:landscape) and (max-height:560px)').matches)
    return peekH = fallback;
  const h = card.offsetTop + card.offsetHeight + 14;   // sheet top → just below the elevation chart
  return peekH = h ? Math.min(Math.max(h, fallback), Math.round(window.innerHeight*0.62)) : fallback;
}
function sheetPeekHeight(){ return peekH || Math.round(window.innerHeight*0.16); }
function setSheet(state){
  sheetState=state;
  computePeekH();
  const sheet=$('#sheet');
  const gps=$('#btn-gps'), track=$('#btn-track');
  const landscapeDocked = matchMedia('(orientation:landscape) and (max-height:560px)').matches;
  let gpsBottom;
  if (landscapeDocked){
    sheet.style.height='';
    gpsBottom = 'calc(20px + var(--safe-b))';
  } else {
    if(state==='peek') sheet.style.height = sheetPeekHeight()+'px';
    else if(state==='full') sheet.style.height = '90dvh';
    gpsBottom = `calc(${sheetPeekHeight()}px + 14px)`;
  }
  if(gps) gps.style.bottom = gpsBottom;
  if(track) track.style.bottom = `calc(${gpsBottom} + 58px)`;   // stacked above the GPS FAB
  // When the sheet is expanded full (portrait) it covers the map FABs — take them out of the focus
  // order so a keyboard/SR user can't tab into controls hidden behind the sheet. (inert is supported
  // on the iOS 26+ target.) In the landscape side-docked layout the FABs stay visible/usable.
  const fabsHidden = state==='full' && !landscapeDocked;
  [gps,track].forEach(el=>{ if(el) el.inert = fabsHidden; });
  const grip=$('#grip'); if(grip) grip.setAttribute('aria-expanded', state==='full' ? 'true' : 'false');
}
function initSheetDrag(){
  const sheet=$('#sheet'), grip=$('#grip'), peek=$('#sheet-peek');
  let startY=0, startH=0, dragging=false;
  const onStart=e=>{ dragging=true; startY=(e.touches?e.touches[0].clientY:e.clientY); startH=sheet.offsetHeight; sheet.style.transition='none'; };
  const onMove=e=>{ if(!dragging)return; const y=(e.touches?e.touches[0].clientY:e.clientY); const h=Math.min(window.innerHeight*0.9, Math.max(sheetPeekHeight(), startH+(startY-y))); sheet.style.height=h+'px'; };
  const onEnd=()=>{ if(!dragging)return; dragging=false; sheet.style.transition=''; const h=sheet.offsetHeight; setSheet(h > window.innerHeight*0.45 ? 'full':'peek'); };
  [grip,peek].forEach(el=>{
    el.addEventListener('touchstart',onStart,{passive:true});
    el.addEventListener('mousedown',onStart);
  });
  window.addEventListener('touchmove',onMove,{passive:true});
  window.addEventListener('mousemove',onMove);
  window.addEventListener('touchend',onEnd);
  window.addEventListener('mouseup',onEnd);
  peek.addEventListener('click',()=>{ if(!dragging) setSheet(sheetState==='peek'?'full':'peek'); });
  // Keyboard operability for the grip (role="button"): Enter/Space toggles peek↔full; Escape collapses.
  grip.addEventListener('keydown',e=>{
    if(e.key==='Enter' || e.key===' '){ e.preventDefault(); setSheet(sheetState==='peek'?'full':'peek'); }
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape' && !$('#detail').hidden && sheetState==='full') setSheet('peek');
  });
}

// ════════════════════════════════════════════════════════════
//  Offline map download — ONE button downloads ALL trails' tiles
//  (across both tile sources). iOS has no background fetch, so this
//  is a single foreground, user-initiated action with inline progress.
// ════════════════════════════════════════════════════════════
function tRange(b,z){ const a=ll2t(b.s,b.w,z), c=ll2t(b.n,b.e,z);
  return {x0:Math.min(a.x,c.x),x1:Math.max(a.x,c.x),y0:Math.min(a.y,c.y),y1:Math.max(a.y,c.y)}; }
function ll2t(lat,lon,z){ const n=1<<z; const x=Math.floor(n*(lon+180)/360);
  const r=lat*Math.PI/180; const y=Math.floor(n*(1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2);
  return {x,y}; }

// Raw bounding box of a trail, computed from its GPX track points (the GPX is already
// precached by the service worker, so this works offline too). Per-zoom padding is added
// later in tileURLsFor() via padFor(). Memoized per slug — a deterministic parse, and the
// global "save all" builds 10 of these (re-downloads shouldn't re-fetch+re-parse each one).
const gpxBoxCache = new Map();
async function gpxBox(trail){
  if(gpxBoxCache.has(trail.slug)) return gpxBoxCache.get(trail.slug);
  let n=-90,s=90,e=-180,w=180;
  try{
    const xml=new DOMParser().parseFromString(await (await fetch(trail.gpx)).text(),'text/xml');
    xml.querySelectorAll('trkpt').forEach(p=>{
      const la=+p.getAttribute('lat'), lo=+p.getAttribute('lon');
      n=Math.max(n,la); s=Math.min(s,la); e=Math.max(e,lo); w=Math.min(w,lo);
    });
    if(n<s) throw 0;                              // no track points parsed
  }catch(_){ const [cy,cx]=trail.center;          // fall back to a small box around center
    n=cy+0.02; s=cy-0.02; e=cx+0.02; w=cx-0.02; }
  const box={ n, s, e, w };
  gpxBoxCache.set(trail.slug, box);
  return box;
}

// Every tile URL for one box across the source's zoom range (z10 up to src.maxZoom — 16 for
// USGS, 18 for GSI), built from that source's tile template. Each zoom expands the box by its
// own padFor(z), so overview zooms cache wider context.
function tileURLsFor(box, src){
  const urls=[];
  for(let z=DL_MIN_Z; z<=src.maxZoom; z++){ const p=padFor(z);
    const r=tRange({ n:box.n+p, s:box.s-p, e:box.e+p, w:box.w-p }, z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++)
      urls.push(src.url.replace('{z}',z).replace('{y}',y).replace('{x}',x)); }
  return urls;
}

// Shared fetch+commit engine for BOTH the global and per-trail download buttons. Fetches each
// missing tile and stores its bytes in IndexedDB on the PAGE (so reaching "saved" means the bytes
// are committed — we don't lean on the SW's deferred e.waitUntil write, which iOS can cut off when
// it suspends the backgrounded SW; on the SW-controlled path the SW also caches the same key, an
// idempotent duplicate, not a 2nd fetch). Each tile is classified: `ok` (committed or already
// present), `absent` (the host 404'd — legitimately no tile there; counts as covered, NOT a
// failure), or `fail` (network error / timeout / the SW's offline 503 / 5xx / a quota abort —
// retryable, and what blocks a trail from being recorded "complete"). Sets dlQuotaHit so the caller can warn.
// Returns {ok, absent, fail}; reports progress via onProgress.
let dlQuotaHit = false;
async function saveTiles(urls, onProgress){
  urls=[...new Set(urls)];
  const total=urls.length || 1; let done=0, ok=0, absent=0, fail=0; const BATCH=8;
  for(let i=0;i<urls.length;i+=BATCH){
    await Promise.allSettled(urls.slice(i,i+BATCH).map(async u=>{
      try{
        if(await TileStore.has(u)){ ok++; }                 // already committed
        else{
          const r=await fetch(u,{mode:'cors', signal:AbortSignal.timeout(15000)});  // bounded: a hung tile times out → fail (retryable), never stalls the loop
          if(r.ok){ const type=r.headers.get('Content-Type')||'image/png'; await TileStore.put(u,{body:await r.arrayBuffer(), type}); ok++; }
          else if(r.status===404){ absent++; }              // host has no tile here → covered, not a miss
          else fail++;                                      // 503 (SW offline) / 5xx / other → retryable miss
        }
      }catch(e){ if(e && e.name==='QuotaExceededError') dlQuotaHit=true; fail++; }   // incl. IDB quota abort
      done++; if(onProgress) onProgress(done,total);
    }));
  }
  return {ok, absent, fail};
}

// Sample probe URLs spread evenly across a trail's (zoom-ordered) tile-URL set. Stored in the
// completion manifest and re-checked on launch: if any probe is gone, iOS evicted the set (the
// 7-day rule), so the trail is demoted from "saved". Spanning zoom levels catches a partial
// eviction that a single-center-tile probe would miss.
function sampleProbes(urls, k=8){
  const u=[...new Set(urls)];
  if(u.length<=k) return u;
  const out=[]; for(let i=0;i<k;i++) out.push(u[Math.round(i*(u.length-1)/(k-1))]);
  return [...new Set(out)];
}

// ── Per-trail completion manifest (localStorage) ──
// A trail counts as "saved" ONLY if it has a record here — written solely by a download that
// committed its WHOLE expected tile set with zero hard failures (404s are fine). This is what kills
// the old false-✓: tiles the service worker caches incidentally while you merely browse a map
// online never write a record, so they can't masquerade as a complete offline download. Eviction is
// caught by re-probing the record's sample tiles (see trailSaved). localStorage is synchronous,
// durable, and tiny here (10 trails × a few probe URLs).
const MANIFEST_KEY='tileManifest';
function readManifest(){ try{ return JSON.parse(localStorage.getItem(MANIFEST_KEY)||'{}')||{}; }catch(_){ return {}; } }
function writeManifest(m){ try{ localStorage.setItem(MANIFEST_KEY, JSON.stringify(m)); }catch(_){} }
function markSaved(slug, urls){ const m=readManifest(); m[slug]={ savedAt:Date.now(), probes:sampleProbes(urls) }; writeManifest(m); }
function clearSaved(slug){ const m=readManifest(); if(m[slug]){ delete m[slug]; writeManifest(m); } }

// Every tile URL for one trail (its box across its source's zoom range). The tile math is already
// shared (tileURLsFor/gpxBox/trailSource), so the global and per-trail paths build URLs identically.
async function trailTileURLs(trail){ return tileURLsFor(await gpxBox(trail), trailSource(trail)); }

// Save one trail's full (prebuilt) tile set and record a completion manifest entry ONLY if every
// tile committed (fail===0; 404s are fine). Shared core for the card button and the global loop.
async function downloadTrail(trail, urls, onProgress){
  const r=await saveTiles(urls, onProgress);
  if(r.fail===0) markSaved(trail.slug, urls);   // complete → trustworthy "saved"
  else clearSaved(trail.slug);                   // partial/interrupted → never claim saved
  return r;
}

// Global "save all maps": every trail, one after another, behind a single combined progress bar.
// (Trails are geographically disjoint, so there's no cross-trail tile overlap to dedupe; running
// per-trail lets each earn its own honest completion record and paints each card live.)
async function downloadAll(){
  if(dlState==='busy' || !('indexedDB'in window)) return;
  // navigator.onLine===false is a fast "definitely offline" hint — bail early with a clear message
  // rather than spinning every tile through its 15 s timeout. It's NOT fully reliable on iOS (it can
  // read true on a connected-but-no-internet Wi-Fi), so the real safety net is saveTiles: tiles that
  // fail are counted, the trail is never recorded "saved", and the user gets the dlPartial nudge.
  if(!navigator.onLine){ alert(t('dlOffline')); return; }
  dlQuotaHit=false;
  dlState='busy'; updateDlBtn(); updateDlProgress(0,1);
  // Build every trail's URL list up front so the combined bar reflects true total progress. Skip any
  // trail a per-trail download already owns (its card is 'busy'), so the global and per-trail engines
  // never drive — and race the manifest/state of — the same slug.
  const lists=[];
  for(const trail of TRAILS){
    if(cardDl.get(trail.slug)==='busy') continue;
    const urls=[...new Set(await trailTileURLs(trail))]; lists.push({trail,urls});
  }
  const grand=lists.reduce((s,l)=>s+l.urls.length,0)||1;
  let base=0, anyFail=false;
  for(const {trail,urls} of lists){
    setCardDl(trail.slug,'busy',0);   // mark busy only as we reach it, so an early quota-break leaves the rest idle (not stuck 'busy')
    const r=await downloadTrail(trail, urls, (d,tot)=>{ updateDlProgress(base+d, grand); setCardDl(trail.slug,'busy',Math.round(d/tot*100)); });
    base+=urls.length;
    if(r.fail===0) setCardDl(trail.slug,'done'); else { anyFail=true; setCardDl(trail.slug,'idle'); }
    if(dlQuotaHit) break;             // out of storage — stop hammering more put()s that will abort; already-completed trails keep their ✓
  }
  dlState='idle'; updateDlBtn();                 // drop 'busy' so refreshCacheStatus can run + set the honest global state
  await refreshCacheStatus(); updateDlBtn();
  if(dlQuotaHit) alert(t('dlQuota')); else if(anyFail) alert(t('dlPartial'));
}

// Per-trail "save this map" (the card button). Same engine + guards as the global button, scoped to
// one trail; state is tracked per-slug in cardDl/cardDlPct so it survives list re-renders.
async function downloadOne(slug){
  if(cardDl.get(slug)==='busy' || !('indexedDB'in window)) return;
  if(!navigator.onLine){ alert(t('dlOffline')); return; }
  const trail=TRAILS.find(x=>x.slug===slug); if(!trail) return;
  dlQuotaHit=false;
  setCardDl(slug,'busy',0);
  const urls=[...new Set(await trailTileURLs(trail))];
  const r=await downloadTrail(trail, urls, (d,total)=>setCardDl(slug,'busy',Math.round(d/total*100)));
  setCardDl(slug, r.fail===0 ? 'done' : 'idle');
  if(r.fail===0) refreshCacheStatus().then(updateDlBtn);    // this trail done may complete the global "✓ saved"
  else if(dlQuotaHit) alert(t('dlQuota')); else alert(t('dlPartial'));
}

// Reflect the current state + language on the global download button (icon + label).
function updateDlBtn(){
  const b=$('#dl-all'); if(!b) return;
  const icEl=b.querySelector('.dl-ic'), lblEl=b.querySelector('.dl-lbl');
  b.classList.toggle('busy', dlState==='busy');
  b.classList.toggle('done', dlState==='done');
  if(dlState==='done'){ icEl.innerHTML=icon('check'); lblEl.textContent=t('dlAllDone'); }
  else { icEl.innerHTML=icon('download'); if(dlState==='idle') lblEl.textContent=t('dlAll'); }
  // 'busy' label is the live percentage, set by updateDlProgress()
}
function updateDlProgress(done,total){
  const b=$('#dl-all'); if(!b) return;
  const pct=Math.round(done/total*100);
  b.style.setProperty('--p', pct+'%');
  if(dlState==='busy') b.querySelector('.dl-lbl').textContent=pct+'%';
}

// Paint one card's per-trail download button (idle/busy/done + busy %). cardDl/cardDlPct are the
// source of truth; the button DOM is rebuilt by renderList (filter/sort/lang) and re-reads them, so
// a running download — which holds its slug in a closure — repaints correctly on its next tick.
function setCardDl(slug, state, pct){
  cardDl.set(slug, state);
  if(state==='busy' && pct!=null) cardDlPct.set(slug, pct); else cardDlPct.delete(slug);
  const b=document.querySelector('.card-dl[data-slug="'+slug+'"]'); if(!b) return;
  b.classList.toggle('busy', state==='busy');
  b.classList.toggle('done', state==='done');
  if(state==='busy' && pct!=null) b.style.setProperty('--p', pct);   // unitless number → conic ring degrees
  b.querySelector('.cdl-ic').innerHTML = icon(state==='done'?'check':'download');
  b.setAttribute('aria-label', t(state==='done'?'dlOneDone':'dlOne'));
}

// A trail is "saved" iff it has a completion manifest record AND that record's probe tiles are all
// still in IndexedDB. The manifest gate stops incidentally-cached tiles from faking a ✓; the probe
// re-check demotes (and forgets) a set that iOS has evicted under the 7-day rule.
async function trailSaved(trail){
  const rec=readManifest()[trail.slug];
  if(!rec || !Array.isArray(rec.probes) || !rec.probes.length) return false;
  for(const u of rec.probes){ if(!(await TileStore.has(u))){ clearSaved(trail.slug); return false; } }
  return true;
}

// On startup (and after a download) set the buttons' states from the manifest+probe truth above:
// each card is 'done' if its set is recorded saved AND its probe tiles are present; the global
// button is 'done' only if EVERY trail is. Runs off the critical path; never blocks first paint. A
// download in flight is left alone (don't stomp a 'busy' card).
async function refreshCacheStatus(){
  if(dlState==='busy' || !('indexedDB'in window)) return;
  try{
    let all=true;
    for(const trail of TRAILS){
      const saved=await trailSaved(trail);
      if(cardDl.get(trail.slug)!=='busy') setCardDl(trail.slug, saved?'done':'idle');
      if(!saved) all=false;
    }
    dlState = all ? 'done' : 'idle';
  }catch(_){}
}

// ════════════════════════════════════════════════════════════
//  Utils
// ════════════════════════════════════════════════════════════
function hav(la1,lo1,la2,lo2){
  const R=6371000,d=Math.PI/180;
  const p1=la1*d,p2=la2*d,dp=(la2-la1)*d,dl=(lo2-lo1)*d;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// redraw profile + refit on rotation/resize. Only re-fit the track on an actual ORIENTATION change —
// on iOS the URL bar / on-screen keyboard fire `resize` constantly, and re-fitting then would yank a
// hiker who has zoomed into their position back out to the whole-track view. A plain size change just
// re-measures and re-clamps the bounds, leaving the user's zoom/pan intact.
let rzT;
window.addEventListener('resize',()=>{ clearTimeout(rzT); rzT=setTimeout(()=>{
  if((curTrail||freeHike) && map){
    map.invalidateSize(); setSheet(sheetState);
    if(freeHike) return;                                 // no track/profile to redraw or re-fit
    drawProfile(); syncGpsCursor(); redrawScrubCursor();
    const o = window.innerWidth > window.innerHeight ? 'l' : 'p';
    if(o !== mapOrient){ mapOrient = o; fitTrack(); }   // orientation flipped → re-fit
    else applyMaxBounds();                               // same orientation → just re-clamp to the (now-resized) viewport
  }
},250); });
