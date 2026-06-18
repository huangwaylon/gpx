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
let trackPts = [], trackWpts = [];
let totalDist = 0, gpsWatch = null, gpsMk = null, gpsAcc = null, gpsFollow = false;
let curPos = null, wakeLock = null;
let sheetState = 'peek';          // 'peek' | 'full'
let dlState = 'idle';             // global offline-maps download: 'idle' | 'busy' | 'done'
const cardDl = new Map();         // per-trail download state by slug: 'idle' | 'busy' | 'done' (survives list re-renders)

// Cached profile elevation bounds (smoothed), computed once per trail in loadTrail.
let eleLo = 0, eleHi = 0, eleRange = 1;
// Downsampled render points for the track polyline, kept WITH cumulative distance .d so the
// green "walked" overlay (live tracking) can be sliced by distance without re-deriving them.
let renderPts = [];
// Far end of the trail = the point of greatest distance from the trailhead. For an out-and-back
// (whose GPX is a closed round trip) this is the turnaround/summit, and progress locks here.
let turnDist = 0, isOutAndBack = false;

// Elevation-scrub state (drag a finger along the profile to inspect a point on the trail).
let scrubbing = false, scrubMk = null, scrubRAF = 0, scrubX = 0, scrubRect = null, scrubCardRect = null;

// Live trail-progress state.
let tracking = false, paused = false;
let trackStartTs = 0, trackElapsedMs = 0, hudTimer = null, hudTicks = 0;
let walkedDist = 0, progIdx = -1;   // monotonic distance-along reached (m); last snapped vertex
let walkedLayer = null, walkedHalo = null, walkedLine = null;   // green "walked" overlay: white halo + green line (a layerGroup), drawn over the red base track
let reacqMiss = 0;                  // consecutive off-window fixes (triggers a full re-acquire)
let pendingResume = null;           // a saved session offered for resume on the current trail
let resumeOnOpen = false;           // bootRoute (cold relaunch) or the list "resume hike" banner → auto-resume on open
let gpsWasHidden = false;           // GPS was live when last backgrounded (→ refresh fix on return)
let gpsWakePending = false;         // a wake-time getCurrentPosition is in flight (dedupes rapid visibility flips)
let locatingTimer = null;           // safety auto-hide for the "locating…" indicator
let booting = true;                 // true until just after first load — bootRoute owns the initial resume; onWake stands down

// A tracking session is mirrored to localStorage so it survives a page reload / iOS tab eviction
// (progress + an absolute start timestamp, so the elapsed clock keeps counting across the gap).
// Reopening the trail offers to restore it. Only the HUD ✕ (endTracking) forgets it.
const SESSION_KEY = 'trackSession';
const SESSION_MAX_AGE_MS = 18 * 3600 * 1000;   // discard a saved session older than this (stale)
const RESUME_MIN_MS = 20000;                   // ignore trivially-short sessions (accidental starts) when offering/auto-resuming

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
    redrawTrailLabels();
    updateTrackUI(); updateHUD();   // re-localize the tracking controls + HUD message
    if(pendingResume) renderResumePrompt();
    syncGpsCursor();
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
    const want = '#/trail/' + s.slug;
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
    return `
    <div class="card-wrap">
      <a class="card" href="#/trail/${trail.slug}">
        <div class="card-img-wrap">
          <img class="card-img" src="${trail.img}" alt="${tr.name}" loading="lazy">
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
              aria-label="${t(dl==='done'?'dlOneDone':'dlOne')}">
        <span class="cdl-ic" aria-hidden="true">${icon(dl==='done'?'check':'download')}</span>
      </button>
    </div>`;
  }).join('');
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
      renderList();
    });
  });

  $('#lang-toggle').addEventListener('click', () => setLang(lang === 'ja' ? 'en' : 'ja'));
  $('#btn-back').addEventListener('click', () => { location.hash = ''; });
  $('#btn-gps').addEventListener('click', toggleGPS);
  $('#btn-track').addEventListener('click', onTrackFab);
  $('#th-pause').addEventListener('click', togglePause);
  $('#th-close').addEventListener('click', endTracking);
  $('#tr-resume').addEventListener('click', () => { const s=pendingResume; hideResumePrompt(); if(s) resumeSession(s); });
  $('#tr-dismiss').addEventListener('click', () => { clearSession(); hideResumePrompt(); });
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
    resumeOnOpen = true; location.hash = '#/trail/' + slug;
  });

  initSheetDrag();
  initProfileScrub();
}

function showList() {
  $('#detail').hidden = true;
  $('#list').hidden = false;
  if (gpsWatch !== null) stopGPS();
  stopTracking(); hideResumePrompt();
  scrubbing = false; clearScrub();
  curTrail = null; resumeOnOpen = false;
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
  curTrail = trail;
  stopTracking(); hideResumePrompt(); scrubbing = false;   // fresh per-trail tracking/scrub state
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = loc(trail).name;

  renderPeek(trail);
  renderSheetBody(trail);     // render the body first so setSheet can size the peek to the chart
  setSheet('peek');
  initMap();
  await loadTrail(trail);
  if (curTrail !== trail) return;   // a newer navigation superseded this one mid-load — don't touch its map/session
  if(resumeThis){             // arrived via cold-relaunch auto-route (bootRoute), wake-resume, or the list banner → resume straight away
    const s=readSession();
    if(freshResumable(s) && s.slug===trail.slug) resumeSession(s);
    else maybeOfferResume(trail);
  } else {
    maybeOfferResume(trail);  // a saved session for this trail (survived a reload) can be resumed
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
  const rows = it.map((s, i) => {
    const stay = s.depart ? hm(s.depart) - hm(s.time) : 0;
    const badge = stay
      ? `<span class="tl-stay">${lang==='ja' ? '滞在 '+fmtDur(stay) : fmtDur(stay)+' rest'}</span>`
      : '';
    const stop = `<li class="tl-stop tl-${s.type}"><span class="tl-dot"></span>` +
      `<span class="tl-time">${s.time}</span>` +
      `<span class="tl-name">${s.name[lang] || s.name.en}${badge}</span></li>`;
    if (i === it.length - 1) return stop;
    const leg = hm(it[i+1].time) - (s.depart ? hm(s.depart) : hm(s.time));
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
function initMap() {
  if (map) { map.remove(); map = null; }
  // map.remove() drops all layers; clear stale references so onPos/scrub recreate them fresh.
  trackLayer = walkedLayer = scrubMk = gpsMk = gpsAcc = null; endMarker._all = [];
  const src = trailSource(curTrail);
  map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
  const zoom = L.control.zoom({ position:'topright' }).addTo(map);
  // minZoom = DL_MIN_Z: the map can't zoom out past the cached overview level, so there's no blank-
  // tile band offline (offline pre-cache starts at z10; allowing z8–9 showed gray tiles with no data).
  L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:DL_MIN_Z, attribution:src.leaflet, crossOrigin:true }).addTo(map);
  map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
  zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
}

async function loadTrail(trail) {
  trackPts = []; trackWpts = []; totalDist = 0;
  renderPts = []; walkedDist = 0; progIdx = -1; reacqMiss = 0;
  let text;
  try { text = await (await fetch(trail.gpx)).text(); }
  catch(e) { console.error('GPX load failed', e); return; }
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
  const p0 = trackPts[0]; let far = -1, turnIdx = 0;
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
function fitTrack() {
  if (map && trackLayer) map.fitBounds(trackLayer.getBounds(), { paddingTopLeft:[30,70], paddingBottomRight:[30, sheetPeekHeight()+30] });
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
  const svg = $('#elev-svg'); if (!svg || trackPts.length<2) return;
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

// Single point's elevation / distance-along, in the active language's units.
function fmtElev(m){ return lang==='ja' ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m*FT).toLocaleString()} ft`; }
function fmtDistAlong(m){ return lang==='ja' ? `${(m/1000).toFixed(1)} km` : `${(m/(MI_PER_KM*1000)).toFixed(1)} mi`; }

// Draw the profile cursor (vertical line + dot) for point p={d,se}. When `scrub` is true the dot
// is violet (matching the map marker) and the floating readout pill is shown; otherwise it's the
// blue GPS-position dot. Shared by GPS (onPos) and scrubbing.
function drawProfileCursor(p, scrub){
  const svg=$('#elev-svg'), g=$('#epos'); if(!svg||!g||!p) return;
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
// profile SVG is rebuilt or a scrub ends). onPos draws its own cursor from the fresh fix.
function syncGpsCursor(){
  if(curPos && trackPts.length && !scrubbing)
    drawProfileCursor(trackPts[nearestIdx(curPos.lat,curPos.lon).idx], false);
}

// ── Elevation scrubbing ──
// Bound once (from bindGlobal) via delegation, since the profile SVG is rebuilt on every
// language switch / sheet re-render. touch-action:none on #elev-svg keeps the drag from
// scrolling the sheet; window-level move/up listeners track the finger past the SVG edge.
function initProfileScrub(){
  document.addEventListener('pointerdown', e=>{
    if(!e.target.closest || !e.target.closest('#elev-svg') || trackPts.length<2) return;
    scrubbing=true;
    const svg=$('#elev-svg');
    scrubRect=svg.getBoundingClientRect();
    scrubCardRect=svg.closest('#elev-card').getBoundingClientRect();   // cached for the readout pill
    applyScrub(e.clientX);
    window.addEventListener('pointermove', onScrubMove);
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    e.preventDefault();
  });
}
function onScrubMove(e){ scrubX=e.clientX; if(!scrubRAF) scrubRAF=requestAnimationFrame(()=>{ scrubRAF=0; applyScrub(scrubX); }); }
function applyScrub(clientX){
  const rect=scrubRect; if(!rect) return;
  let f=(clientX-rect.left)/rect.width; f=Math.max(0,Math.min(1,f));
  const p=pointAtDistance(f*totalDist); if(!p) return;
  drawProfileCursor(p, true);
  if(!scrubMk){
    scrubMk=L.marker([p.lat,p.lon], { interactive:false, zIndexOffset:900,
      icon:L.divIcon({ className:'', html:'<div class="scrub-dot"></div>', iconSize:[16,16], iconAnchor:[8,8] }) }).addTo(map);
  } else scrubMk.setLatLng([p.lat,p.lon]);
}
function endScrub(){
  scrubbing=false;
  window.removeEventListener('pointermove', onScrubMove);
  window.removeEventListener('pointerup', endScrub);
  window.removeEventListener('pointercancel', endScrub);
  if(scrubRAF){ cancelAnimationFrame(scrubRAF); scrubRAF=0; }
  clearScrub();
}
// Remove the scrub marker + readout, and restore the profile cursor to the GPS position (if any).
function clearScrub(){
  if(scrubMk){ scrubMk.remove(); scrubMk=null; }
  const tip=$('#scrub-tip'); if(tip) tip.hidden=true;
  const g=$('#epos'); if(g) g.innerHTML='';
  syncGpsCursor();
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
    gpsMk=L.marker([lat,lon],{icon:L.divIcon({className:'',html:'<div class="gps-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]}),zIndexOffset:1000}).addTo(map);
    gpsAcc=L.circle([lat,lon],{radius:accuracy,fillColor:C.blue,fillOpacity:0.08,color:C.blue,weight:1}).addTo(map);
  } else { gpsMk.setLatLng([lat,lon]); gpsAcc.setLatLng([lat,lon]); gpsAcc.setRadius(accuracy); }
  if(gpsFollow) map.setView([lat,lon], Math.max(map.getZoom(),15), {animate:true});
  if(tracking && !paused) updateProgress(lat,lon,accuracy);
  if(trackPts.length && !scrubbing){
    // While tracking, reuse the windowed snap index (cheaper than a full-track scan, and it
    // won't jump the cursor to the wrong overlapping leg of an out-and-back); else scan fully.
    const i = (tracking && !paused && progIdx>=0) ? progIdx : nearestIdx(lat,lon).idx;
    drawProfileCursor(trackPts[i], false);
  }
}
function onPosErr(err){ setLocating(false); if(err.code===1){ alert(t('alertDenied')); stopGPS(); } }

// "Locating…" indicator — shown while waiting for a fresh fix (GPS start, or a screen-on refresh),
// hidden the moment a fix lands or the attempt errors. A safety timer hides it if neither fires.
function setLocating(on){
  const el=$('#gps-locating'); if(!el) return;
  clearTimeout(locatingTimer); locatingTimer=null;
  if(on){ el.hidden=false; locatingTimer=setTimeout(()=>{ el.hidden=true; }, 30000); }
  else el.hidden=true;
}

async function reqWake(){ if('wakeLock'in navigator){try{wakeLock=await navigator.wakeLock.request('screen');}catch(_){}}}
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
  reacqMiss = REACQUIRE_AFTER;
  setLocating(true);
  restartWatch();
  navigator.geolocation.getCurrentPosition(
    p =>{ gpsWakePending=false; onPos(p); },
    () =>{ gpsWakePending=false; setLocating(false); },
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
function onHide(){ persistSession(); gpsWasHidden = gpsWatch!==null; gpsWakePending=false; }

function onWake(){
  updateListResume();                  // keep the list's "resume hike" banner current after a resident wake
  // On a trail screen but not tracking, with a resumable session for THIS trail and no prompt up yet,
  // re-surface the resume offer (covers a resident wake where the offer was never shown). bootRoute
  // owns the initial-load resume, so skip while still booting to avoid a flash.
  if(!booting && !tracking && curTrail && !pendingResume){
    const s=readSession();
    if(freshResumable(s) && s.slug===curTrail.slug) maybeOfferResume(curTrail);
  }
  if(tracking) updateHUD();             // repaint the clock now (the 1s interval was suspended while hidden)
  if(gpsWatch!==null){
    // iOS auto-releases the screen Wake Lock every time the page hides, but leaves our sentinel
    // reference truthy (only its .released flips). Re-acquire when there's no LIVE lock — testing
    // .released as well as null is what makes this fire on the 2nd+ screen-on (a bare !wakeLock
    // guard saw the stale released sentinel and never re-locked, so the screen auto-locked for the
    // rest of the hike).
    if(!wakeLock || wakeLock.released) reqWake();
    if(gpsWasHidden) refreshGpsAfterGap();
  }
  gpsWasHidden=false;
}

document.addEventListener('visibilitychange',()=>{ if(document.hidden) onHide(); else onWake(); });
window.addEventListener('pagehide', onHide);
window.addEventListener('pageshow', onWake);

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
  if(paused) trackElapsedMs+=Date.now()-trackStartTs;   // bank elapsed, freeze the clock
  else { trackStartTs=Date.now(); if(gpsWatch===null) startGPS(); }   // resume from now; ensure fixes
  updateTrackUI(); updateHUD();
  persistSession();
}
// 1 s HUD clock; also re-persists every ~30 s so `savedAt` stays fresh near the 18 h window even
// during a long GPS-quiet stretch (localStorage writes are synchronous, so this is cheap).
function startHudTimer(){
  clearInterval(hudTimer); hudTicks=0;
  hudTimer=setInterval(()=>{ updateHUD(); if(tracking && !paused && (++hudTicks%30===0)) persistSession(); }, 1000);
}
function startTracking(){
  if(!navigator.geolocation){ alert(t('alertNoGeo')); return; }
  hideResumePrompt();                      // starting fresh overrides any offered resume
  tracking=true; paused=false;
  trackStartTs=Date.now(); trackElapsedMs=0;
  walkedDist=0; progIdx=-1; reacqMiss=0;
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=walkedHalo=walkedLine=null; }
  $('#track-hud').hidden=false;
  if(gpsWatch===null) startGPS();          // tracking needs live fixes
  startHudTimer();
  updateTrackUI(); updateHUD();
  persistSession();
}
// Reset the in-memory session (used on navigation / trail-switch). Leaves the saved session in
// localStorage intact so reopening the trail can still offer a resume; only endTracking() forgets it.
function stopTracking(){
  tracking=false; paused=false; reacqMiss=0;
  clearInterval(hudTimer); hudTimer=null;
  const hud=$('#track-hud'); if(hud) hud.hidden=true;
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=walkedHalo=walkedLine=null; }
  walkedDist=0; progIdx=-1; trackElapsedMs=0;
  updateTrackUI();
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
    fab.setAttribute('aria-label', t('trackStartAria'));
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
function acquireIdx(lat,lon,gate,near=0){
  let bi=-1, bd=Infinity, biDist=Infinity;
  for(let i=0;i<trackPts.length;i++){
    const dd=hav(lat,lon,trackPts[i].lat,trackPts[i].lon);
    if(dd<=gate){ const key=Math.abs(trackPts[i].d-near); if(key<bd){ bd=key; bi=i; biDist=dd; } }
  }
  return bi<0 ? nearestIdx(lat,lon) : { idx:bi, dist:biDist };
}
function updateProgress(lat,lon,accuracy){
  const n=trackPts.length; if(n<2) return;
  const gate=offTrailGate(accuracy);
  let r;
  if(progIdx<0 || reacqMiss>=REACQUIRE_AFTER){      // first fix, OR the window went stale (repeated
    r=acquireIdx(lat,lon,gate,walkedDist);          // misses): re-acquire whole-track, nearest the
                                                    // progress already reached (keeps the right leg)
  } else {
    const avg=totalDist/(n-1)||1;                   // forward window around the last snap
    const from=Math.max(0, progIdx-Math.ceil(SNAP_BACK_M/avg));
    const to  =Math.min(n-1, progIdx+Math.ceil(SNAP_FWD_M/avg));
    r=nearestIdx(lat,lon,from,to);
  }
  if(r.dist>gate){ reacqMiss++; return; }           // off-trail/out-of-window: hold, count the miss
  reacqMiss=0;
  progIdx=r.idx;
  // Only recolor when the high-water mark actually advances (walkedDist is monotonic), so a
  // stationary or backward-jittering fix doesn't rebuild the polyline for an identical line.
  if(trackPts[r.idx].d>walkedDist){ walkedDist=trackPts[r.idx].d; recolorProgress(); }
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

function elapsedMs(){ return trackElapsedMs + ((tracking && !paused) ? Date.now()-trackStartTs : 0); }
function fmtElapsed(ms){
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  const pad=x=>String(x).padStart(2,'0');
  return (h ? `${h}:${pad(m)}` : `${m}`) + ':' + pad(sec);
}
function updateHUD(){
  const hud=$('#track-hud'); if(!hud || hud.hidden) return;
  // Out-and-back % is measured to the far end (turnDist) so reaching it reads 100%; loop and
  // point-to-point measure against the full length.
  const total = isOutAndBack ? turnDist : totalDist;
  const pct = total>0 ? Math.min(100, Math.round(walkedDist/total*100)) : 0;
  $('.th-fill').style.width = pct+'%';
  $('.th-pct').textContent = pct+'%';
  $('.th-num').textContent = fmtElapsed(elapsedMs());
  // Paused takes precedence so the frozen clock is explained; else the turnaround/complete cue.
  const m = paused ? t('trackPaused')
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
  if(!tracking || !curTrail) return;
  try{
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      slug:curTrail.slug, walkedDist, progIdx,
      trackStartTs, trackElapsedMs, paused, savedAt:Date.now(),
    }));
  }catch(_){}
}
function readSession(){ try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(_){ return null; } }
function clearSession(){ try{ localStorage.removeItem(SESSION_KEY); }catch(_){} }

// Elapsed for a saved session, computed live (running → keeps counting wall-clock since its
// absolute start; paused → frozen at its banked total) — same rule as elapsedMs().
function savedElapsedMs(s){ return s.trackElapsedMs + (s.paused ? 0 : Date.now()-s.trackStartTs); }

// Is a saved session worth auto-resuming/offering? The single shared predicate for every resume
// path (boot, wake, open-trail, list banner). Fresh = its trail exists and savedAt is within the
// staleness window. A RUNNING session must also clear the short-session floor (filters accidental
// starts); a PAUSED session is exempt — pausing is deliberate, so honor it however short.
function freshResumable(s){
  return !!s && TRAILS.some(x => x.slug === s.slug)
    && (Date.now() - (s.savedAt || 0) <= SESSION_MAX_AGE_MS)
    && (s.paused || savedElapsedMs(s) >= RESUME_MIN_MS);
}

// On opening a trail, offer to resume a saved session for it (unless it's gone stale/trivial).
function maybeOfferResume(trail){
  const s=readSession();
  if(!s || s.slug!==trail.slug) return;                              // none, or it's another trail's
  if(Date.now()-(s.savedAt||0) > SESSION_MAX_AGE_MS){ clearSession(); return; }   // too old
  if(!s.paused && savedElapsedMs(s) < RESUME_MIN_MS) return;         // running & trivially short — skip (paused is always offered)
  pendingResume=s;
  renderResumePrompt();
  $('#track-resume').hidden=false;
  updateTrackUI();                                                   // hide the start FAB while the prompt owns the choice
}
function renderResumePrompt(){
  const s=pendingResume; if(!s) return;
  const total = isOutAndBack ? turnDist : totalDist;
  const pct = total>0 ? Math.min(100, Math.round(s.walkedDist/total*100)) : 0;
  $('#tr-msg').textContent = `${t('trackResumeMsg')} · ${pct}% · ${fmtElapsed(savedElapsedMs(s))}`;
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
  walkedDist=s.walkedDist||0; progIdx=(s.progIdx>=0)?s.progIdx:-1; reacqMiss=0;
  $('#track-hud').hidden=false;
  recolorProgress();
  if(gpsWatch===null && !paused) startGPS();        // resume live fixes
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
  const trail = freshResumable(s) ? TRAILS.find(x=>x.slug===s.slug) : null;
  if(!trail){ el.hidden=true; delete el.dataset.slug; return; }
  el.querySelector('.lr-ic').innerHTML = ICON_PLAY;
  el.querySelector('.lr-label').textContent = t('resumeHike');
  el.querySelector('.lr-trail').textContent = loc(trail).name;
  el.querySelector('.lr-time').textContent = fmtElapsed(savedElapsedMs(s));
  el.dataset.slug = trail.slug;
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
  let gpsBottom;
  if (matchMedia('(orientation:landscape) and (max-height:560px)').matches){
    sheet.style.height='';
    gpsBottom = 'calc(20px + var(--safe-b))';
  } else {
    if(state==='peek') sheet.style.height = sheetPeekHeight()+'px';
    else if(state==='full') sheet.style.height = '90dvh';
    gpsBottom = `calc(${sheetPeekHeight()}px + 14px)`;
  }
  if(gps) gps.style.bottom = gpsBottom;
  if(track) track.style.bottom = `calc(${gpsBottom} + 58px)`;   // stacked above the GPS FAB
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
// later in tileURLsFor() via padFor().
async function gpxBox(trail){
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
  return { n, s, e, w };
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
// idempotent duplicate, not a 2nd fetch). Returns {ok, fail}; reports progress via onProgress.
async function saveTiles(urls, onProgress){
  urls=[...new Set(urls)];
  const total=urls.length || 1; let done=0, ok=0, fail=0; const BATCH=8;
  for(let i=0;i<urls.length;i+=BATCH){
    await Promise.allSettled(urls.slice(i,i+BATCH).map(async u=>{
      try{
        if(await TileStore.has(u)){ ok++; }                 // already committed
        else{
          const r=await fetch(u,{mode:'cors'});
          if(r.ok){ const type=r.headers.get('Content-Type')||'image/png'; await TileStore.put(u,{body:await r.arrayBuffer(), type}); ok++; }
          else fail++;                                      // 404 / the SW's offline 503 → a real miss
        }
      }catch(_){ fail++; }
      done++; if(onProgress) onProgress(done,total);
    }));
  }
  return {ok, fail};
}
// Every tile URL for one trail (its box across its source's zoom range). The tile math is already
// shared (tileURLsFor/gpxBox/trailSource), so the global and per-trail paths build URLs identically.
async function trailTileURLs(trail){ return tileURLsFor(await gpxBox(trail), trailSource(trail)); }

// Global "save all maps": every trail's tiles across both sources, in one deduped pass.
async function downloadAll(){
  if(dlState==='busy' || !('indexedDB'in window)) return;
  // No connection → nothing can be fetched. Bail with a clear message instead of animating to a
  // false "✓ saved". navigator.onLine===false reliably catches the genuinely-offline trail case.
  if(!navigator.onLine){ alert(t('dlOffline')); return; }
  dlState='busy'; updateDlBtn(); updateDlProgress(0,1);
  let urls=[];
  for(const trail of TRAILS) urls.push(...await trailTileURLs(trail));
  const {ok}=await saveTiles(urls, updateDlProgress);
  // Provisional feedback, then reconcile to the honest "all trails saved?" state (and paint each
  // card's status) — the global ✓ should mean every trail is saved, not just that some tiles landed.
  dlState = ok>0 ? 'done' : 'idle'; updateDlBtn();
  refreshCacheStatus().then(updateDlBtn);
}

// Per-trail "save this map" (the card button). Same engine + offline guard as the global button,
// scoped to one trail; state is tracked per-slug in cardDl so it survives list re-renders.
async function downloadOne(slug){
  if(cardDl.get(slug)==='busy' || !('indexedDB'in window)) return;
  if(!navigator.onLine){ alert(t('dlOffline')); return; }
  const trail=TRAILS.find(x=>x.slug===slug); if(!trail) return;
  setCardDl(slug,'busy',0);
  const {ok}=await saveTiles(await trailTileURLs(trail), (d,total)=>setCardDl(slug,'busy',Math.round(d/total*100)));
  setCardDl(slug, ok>0?'done':'idle');
  if(ok>0) refreshCacheStatus().then(updateDlBtn);          // this trail done may complete the global "✓ saved"
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

// Paint one card's per-trail download button (idle/busy/done + busy %). cardDl is the source of
// truth; the button DOM is rebuilt by renderList (filter/sort/lang) and re-reads cardDl, so a
// running download — which holds its slug in a closure — repaints correctly on its next tick.
function setCardDl(slug, state, pct){
  cardDl.set(slug, state);
  const b=document.querySelector('.card-dl[data-slug="'+slug+'"]'); if(!b) return;
  b.classList.toggle('busy', state==='busy');
  b.classList.toggle('done', state==='done');
  if(state==='busy' && pct!=null) b.style.setProperty('--p', pct);   // unitless number → conic ring degrees
  b.querySelector('.cdl-ic').innerHTML = icon(state==='done'?'check':'download');
  b.setAttribute('aria-label', t(state==='done'?'dlOneDone':'dlOne'));
}

// Sample tile (z14 center, from the trail's own source) used to decide "saved". One probe, two
// consumers: the per-trail card state and the global button (all trails saved).
async function trailSaved(trail){
  const {x,y}=ll2t(trail.center[0],trail.center[1],14);
  const u=trailSource(trail).url.replace('{z}',14).replace('{y}',y).replace('{x}',x);
  return TileStore.has(u);
}

// On startup (and after a download) decide the buttons' states from what's actually in IndexedDB:
// each card is 'done' if its sample tile is present; the global button is 'done' only if EVERY
// trail's is. Runs off the critical path; never blocks first paint. A download in flight is left
// alone (don't stomp a 'busy' card).
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

// redraw profile + refit on rotation/resize
let rzT;
window.addEventListener('resize',()=>{ clearTimeout(rzT); rzT=setTimeout(()=>{
  if(curTrail && map){ map.invalidateSize(); setSheet(sheetState); drawProfile(); syncGpsCursor(); fitTrack(); }
},250); });
