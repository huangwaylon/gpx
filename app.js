'use strict';

/* ════════════════════════════════════════════════════════════
   Ume-chan's Trails — offline hiking PWA (JA default, EN toggle)
   ════════════════════════════════════════════════════════════ */

const TILE_CACHE = 'wa-trails-tiles-v1';
const DL_ZOOMS   = [10, 11, 12, 13, 14, 15, 16];
// Zoom-aware bbox padding (degrees, ~111 km per °) added around each track when caching
// offline tiles. Generous at overview zooms — where you pan to take in the surrounding
// terrain — and tighter near max detail, since z16 tiles are tiny and a wide z16 frame
// costs a lot of tiles for context you rarely zoom that far in to read.
const padFor = z => z <= 12 ? 0.05 : z <= 14 ? 0.03 : 0.015;
const FT         = 3.28084;
const MI_PER_KM  = 1.609344;

// Elevation-profile SVG geometry. The viewBox is W×PROF_H; PROF_H must match #elev-svg's
// height in app.css, and PROF_PAD_B/T are the px reserved below/above the plotted area.
const PROF_H = 96, PROF_PAD_B = 14, PROF_PAD_T = 12;

// Track / marker palette — mirrors the --red/--green/--blue/--violet/--amber custom properties
// in app.css (SVG strings and Leaflet options can't read CSS vars without getComputedStyle).
// Keep in sync with :root in app.css.
const C = { red:'#ef4444', green:'#22c55e', blue:'#3b82f6', violet:'#d946ef', amber:'#f59e0b' };

// Live-tracking tuning. Per GPS fix we snap the position to the nearest track vertex,
// searching only a forward window around the last snapped index so an out-and-back's
// return leg (which overlaps the outbound leg) can't match the wrong leg.
const SNAP_FWD_M  = 250;   // how far ahead along the track to search (≈ one fix's travel)
const SNAP_BACK_M = 80;    // small backward slack for GPS jitter

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
    maxZoom: 16, leaflet: '地理院タイル © 国土地理院', creditKey: 'attribGsi',
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

// Cached profile elevation bounds (smoothed), computed once per trail in loadTrail.
let eleLo = 0, eleHi = 0, eleRange = 1;
// Downsampled render points for the track polyline, kept WITH cumulative distance .d so the
// green "walked" overlay (live tracking) can be sliced by distance without re-deriving them.
let renderPts = [];
// Far end of the trail = the point of greatest distance from the trailhead. For an out-and-back
// (whose GPX is a closed round trip) this is the turnaround/summit, and progress locks here.
let turnIdx = 0, turnDist = 0, isOutAndBack = false;

// Elevation-scrub state (drag a finger along the profile to inspect a point on the trail).
let scrubbing = false, scrubMk = null, scrubRAF = 0, scrubX = 0, scrubRect = null, scrubCardRect = null;

// Live trail-progress state.
let tracking = false, paused = false;
let trackStartTs = 0, trackElapsedMs = 0, hudTimer = null;
let walkedDist = 0, progIdx = -1;   // monotonic distance-along reached (m); last snapped vertex
let walkedLayer = null;             // green polyline drawn over the red base track

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
  if (curTrail) {            // re-render the open detail view in the new language
    $('#detail-title').textContent = loc(curTrail).name;
    renderPeek(curTrail);
    renderSheetBody(curTrail);
    redrawTrailLabels();
    updateTrackBtn(); updateHUD();   // re-localize the tracking button + HUD message
    syncGpsCursor();
  }
}

// ════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════
window.addEventListener('load', async () => {
  applyStaticI18n();
  renderList();
  bindGlobal();
  await refreshCacheStatus();
  updateDlBtn();                  // reflect detected offline-maps state (idle / done)
  routeFromHash();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
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
    return `
    <article class="card" data-slug="${trail.slug}">
      <div class="card-img-wrap">
        <img class="card-img" src="${trail.img}" alt="${tr.name}" loading="lazy">
        <span class="card-badge-diff ${diffClass(trail.diff)}">${trDiff(trail.diff)}</span>
        <div class="card-titlebar">
          <div class="card-title">${tr.name}</div>
          <div class="card-area">${tr.area}</div>
        </div>
      </div>
      <div class="card-stats">
        <span class="s"><span class="ic">↔</span>${fmtDist(trail.lengthMi)}</span>
        <span class="s"><span class="ic">▲</span>${fmtGain(trail.gainFt)}</span>
        <span class="s"><span class="ic">⟳</span>${trRoute(trail.route)}</span>
        <span class="s star">★ ${trail.rating}</span>
      </div>
    </article>`;
  }).join('');

  $$('#trail-list .card').forEach(c =>
    c.addEventListener('click', () => { location.hash = `#/trail/${c.dataset.slug}`; }));
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
  $('#btn-track').addEventListener('click', toggleTrack);
  $('#th-close').addEventListener('click', stopTracking);
  $('#dl-all').addEventListener('click', downloadAll);

  initSheetDrag();
  initProfileScrub();
}

function showList() {
  $('#detail').hidden = true;
  $('#list').hidden = false;
  if (gpsWatch !== null) stopGPS();
  stopTracking();
  scrubbing = false; clearScrub();
  curTrail = null;
}

// ════════════════════════════════════════════════════════════
//  Detail screen
// ════════════════════════════════════════════════════════════
async function openDetail(trail) {
  curTrail = trail;
  stopTracking(); scrubbing = false;     // fresh per-trail tracking/scrub state
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = loc(trail).name;

  renderPeek(trail);
  renderSheetBody(trail);     // render the body first so setSheet can size the peek to the chart
  setSheet('peek');
  initMap();
  await loadTrail(trail);
}

function renderPeek(trail) {
  const tr = loc(trail);
  $('#pk-title').textContent = tr.name;
  $('#pk-meta').innerHTML =
    `<span>${fmtDist(trail.lengthMi)}</span><span>▲ ${fmtGain(trail.gainFt)}</span>` +
    `<span class="${diffClass(trail.diff)}" style="background:none;padding:0">${trDiff(trail.diff)}</span>` +
    `<span class="star">★ ${trail.rating} (${trail.reviews.toLocaleString()})</span>` +
    `<span>⏱ ${fmtTime(trail.time)}</span>`;
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
      <p style="font-size:11px;color:var(--muted)">${t('attribTrail')} ／ ${t(trailSource(trail).creditKey)}</p>
    </div>
  `;
  drawProfile();
}

// "3 h 17 min" → "3時間17分" (JA); strip spaces in EN as before
function fmtTime(s) {
  if (lang !== 'ja') return s.replace(/ /g,'');
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
        <span class="ic" aria-hidden="true">📅</span>
        <span class="lbl">${t('secPlan')}</span>
        <a class="plan-yamap" href="${plan.url}" target="_blank" rel="noopener"
           aria-label="${t('planYamapAria')}">${t('planYamap')} ↗</a>
      </div>
      <div class="plan-date">${fmtPlanDate(plan.dateISO)}</div>
      <div class="plan-chips">
        <span class="pc">👥 ${tf('planParty')(plan.party)}</span>
        <span class="pc">↔ ${dist}</span>
        <span class="pc">▲ ${gain}</span>
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
    `<span><span aria-hidden="true">🌅</span> ${plan.sunrise}<span class="sr-only"> ${t('schedRise')}</span></span>` +
    `<span><span aria-hidden="true">🌇</span> ${plan.sunset}<span class="sr-only"> ${t('schedSet')}</span></span>` +
    (plan.totalTime ? `<span><span aria-hidden="true">⏱</span> ${plan.totalTime}<span class="sr-only"> ${t('schedTotal')}</span></span>` : '') +
    `</div>`;
  return `<details class="tl-wrap" open>
      <summary class="tl-title">${t('secSchedule')}</summary>
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
  L.tileLayer(src.url, { maxZoom:src.maxZoom, minZoom:8, attribution:src.leaflet, crossOrigin:true }).addTo(map);
  map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
  zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
}

async function loadTrail(trail) {
  trackPts = []; trackWpts = []; totalDist = 0;
  renderPts = []; walkedDist = 0; progIdx = -1;
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

  L.polyline(coords, { color:'#000', weight:7, opacity:0.25, lineJoin:'round' }).addTo(map); // halo
  trackLayer = L.polyline(coords, { color:C.red, weight:4, opacity:0.95, lineJoin:'round' }).addTo(map);

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
      <stop offset="0%" stop-color="${C.blue}" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#1e3a8a" stop-opacity="0.15"/>
    </linearGradient></defs>
    ${wp}
    <path d="${path}" fill="url(#eg)"/>
    <path d="${line}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
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
    `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="#fff" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.85"/>`+
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
  gpsWatch = navigator.geolocation.watchPosition(onPos,onPosErr,{enableHighAccuracy:true,maximumAge:4000,timeout:30000});
}
function stopGPS(){
  if (gpsWatch!==null){ navigator.geolocation.clearWatch(gpsWatch); gpsWatch=null; }
  relWake(); gpsFollow=false; curPos=null;
  if(gpsMk){gpsMk.remove();gpsMk=null;} if(gpsAcc){gpsAcc.remove();gpsAcc=null;}
  $('#btn-gps').classList.remove('on');
  const ep=$('#epos'); if(ep) ep.innerHTML='';
}
function onPos(pos){
  const {latitude:lat,longitude:lon,accuracy}=pos.coords;
  curPos={lat,lon};
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
function onPosErr(err){ if(err.code===1){ alert(t('alertDenied')); stopGPS(); } }

async function reqWake(){ if('wakeLock'in navigator){try{wakeLock=await navigator.wakeLock.request('screen');}catch(_){}}}
async function relWake(){ if(wakeLock){try{await wakeLock.release();}catch(_){}wakeLock=null;} }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && gpsWatch!==null && !wakeLock) reqWake(); });

// ════════════════════════════════════════════════════════════
//  Live trail progress
//  Start a session → each GPS fix snaps to the trail, fills the walked portion green,
//  and the HUD shows percent + elapsed time. Out-and-back progress locks at the far end
//  so the return leg never un-colors the trail.
// ════════════════════════════════════════════════════════════

// FAB tap: start, or toggle pause/resume while a session is running.
function toggleTrack(){
  if(!tracking){ startTracking(); return; }
  paused=!paused;
  if(paused) trackElapsedMs+=Date.now()-trackStartTs;   // bank elapsed, freeze the clock
  else       trackStartTs=Date.now();                   // resume from now
  updateTrackBtn(); updateHUD();
}
function startTracking(){
  if(!navigator.geolocation){ alert(t('alertNoGeo')); return; }
  tracking=true; paused=false;
  trackStartTs=Date.now(); trackElapsedMs=0;
  walkedDist=0; progIdx=-1;
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=null; }
  $('#track-hud').hidden=false;
  if(gpsWatch===null) startGPS();          // tracking needs live fixes
  clearInterval(hudTimer); hudTimer=setInterval(updateHUD,1000);
  updateTrackBtn(); updateHUD();
}
// End the session entirely (HUD ✕). Leaves GPS as-is so the location dot can stay on.
function stopTracking(){
  tracking=false; paused=false;
  clearInterval(hudTimer); hudTimer=null;
  const hud=$('#track-hud'); if(hud) hud.hidden=true;
  if(walkedLayer){ walkedLayer.remove(); walkedLayer=null; }
  walkedDist=0; progIdx=-1; trackElapsedMs=0;
  updateTrackBtn();
}
function updateTrackBtn(){
  const b=$('#btn-track'); if(!b) return;
  const live = tracking && !paused;
  b.classList.toggle('tracking', live);
  b.textContent = live ? '⏸' : '▶';
  b.setAttribute('aria-label', t(live ? 'trackPauseAria' : 'trackStartAria'));
}

// Off-trail gate: reject fixes whose nearest vertex is implausibly far, scaled to the reported
// GPS accuracy (tighter for good fixes, looser under tree cover) and clamped to a sane range.
function offTrailGate(acc){ return Math.max(25, Math.min(60, 2.5*(acc||20))); }

// First fix: among vertices within the gate, take the one with the SMALLEST distance-along, so
// the trailhead/return overlap of an out-and-back can't be mistaken for near-complete progress.
function acquireIdx(lat,lon,gate){
  let bi=-1, bd=Infinity, biDist=Infinity;
  for(let i=0;i<trackPts.length;i++){
    const dd=hav(lat,lon,trackPts[i].lat,trackPts[i].lon);
    if(dd<=gate && trackPts[i].d<bd){ bd=trackPts[i].d; bi=i; biDist=dd; }
  }
  return bi<0 ? nearestIdx(lat,lon) : { idx:bi, dist:biDist };
}
function updateProgress(lat,lon,accuracy){
  const n=trackPts.length; if(n<2) return;
  const gate=offTrailGate(accuracy);
  let r;
  if(progIdx<0){ r=acquireIdx(lat,lon,gate); }      // first fix: whole-track, smallest-d match
  else {
    const avg=totalDist/(n-1)||1;                   // forward window around the last snap
    const from=Math.max(0, progIdx-Math.ceil(SNAP_BACK_M/avg));
    const to  =Math.min(n-1, progIdx+Math.ceil(SNAP_FWD_M/avg));
    r=nearestIdx(lat,lon,from,to);
  }
  if(r.dist>gate) return;                           // off-trail: hold progress
  progIdx=r.idx;
  // Only recolor when the high-water mark actually advances (walkedDist is monotonic), so a
  // stationary or backward-jittering fix doesn't rebuild the polyline for an identical line.
  if(trackPts[r.idx].d>walkedDist){ walkedDist=trackPts[r.idx].d; recolorProgress(); }
  updateHUD();
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
  if(coords.length<2){ if(walkedLayer){ walkedLayer.remove(); walkedLayer=null; } return; }
  if(!walkedLayer) walkedLayer=L.polyline(coords,{ color:C.green, weight:4, opacity:0.97, lineJoin:'round' }).addTo(map);
  else walkedLayer.setLatLngs(coords);
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
  $('.th-time').textContent = fmtElapsed(elapsedMs());
  const msg=$('.th-msg'), m = pct>=100 ? t(isOutAndBack ? 'trackTurnaround' : 'trackComplete') : '';
  msg.textContent=m; msg.hidden=!m;
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

// Every tile URL for one box across DL_ZOOMS, built from that trail's tile template.
// Each zoom expands the box by its own padFor(z), so overview zooms cache wider context.
function tileURLsFor(box, urlTpl){
  const urls=[];
  DL_ZOOMS.forEach(z=>{ const p=padFor(z);
    const r=tRange({ n:box.n+p, s:box.s-p, e:box.e+p, w:box.w-p }, z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++)
      urls.push(urlTpl.replace('{z}',z).replace('{y}',y).replace('{x}',x)); });
  return urls;
}

async function downloadAll(){
  if(dlState==='busy' || !('caches'in window)) return;
  dlState='busy'; updateDlBtn(); updateDlProgress(0,1);
  // Gather every tile URL across all trails (each via its own source), then dedupe.
  let urls=[];
  for(const trail of TRAILS){
    const box=await gpxBox(trail);
    urls.push(...tileURLsFor(box, trailSource(trail).url));
  }
  urls=[...new Set(urls)];
  const total=urls.length || 1; let done=0;
  const cache=await caches.open(TILE_CACHE), BATCH=8;
  for(let i=0;i<urls.length;i+=BATCH){
    await Promise.allSettled(urls.slice(i,i+BATCH).map(async u=>{
      try{ if(!(await cache.match(u))){ const r=await fetch(u,{mode:'cors'}); if(r.ok||r.type==='opaque') await cache.put(u,r); } }catch(_){}
      done++; updateDlProgress(done,total);
    }));
  }
  dlState='done'; updateDlBtn();
}

// Reflect the current state + language on the global download button.
function updateDlBtn(){
  const b=$('#dl-all'); if(!b) return;
  b.classList.toggle('busy', dlState==='busy');
  b.classList.toggle('done', dlState==='done');
  if(dlState==='idle') b.textContent=t('dlAll');
  else if(dlState==='done') b.textContent=t('dlAllDone');
  // 'busy' label is the live percentage, set by updateDlProgress()
}
function updateDlProgress(done,total){
  const b=$('#dl-all'); if(!b) return;
  const pct=Math.round(done/total*100);
  b.style.setProperty('--p', pct+'%');
  if(dlState==='busy') b.textContent=pct+'%';
}

// On startup decide the button state: 'done' only if a sample tile for EVERY trail
// (its z14 center tile, from that trail's own source) is already cached; else 'idle'.
async function refreshCacheStatus(){
  if(dlState==='busy' || !('caches'in window)) return;
  try{
    const cache=await caches.open(TILE_CACHE);
    let all=true;
    for(const trail of TRAILS){
      const {x,y}=ll2t(trail.center[0],trail.center[1],14);
      const u=trailSource(trail).url.replace('{z}',14).replace('{y}',y).replace('{x}',x);
      if(!(await cache.match(u))){ all=false; break; }
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
