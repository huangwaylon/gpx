'use strict';

/* ════════════════════════════════════════════════════════════
   Ume-chan's Trails — offline hiking PWA (JA default, EN toggle)
   ════════════════════════════════════════════════════════════ */

const TILE_URL   = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const TILE_CACHE = 'wa-trails-tiles-v1';
const DL_ZOOMS   = [10, 11, 12, 13, 14, 15, 16];
const PAD        = 0.01;          // bbox padding in degrees for tile download
const FT         = 3.28084;

// ── App state ──
let map = null, curTrail = null, trackLayer = null;
let trackPts = [], trackWpts = [];
let totalDist = 0, gpsWatch = null, gpsMk = null, gpsAcc = null, gpsFollow = false;
let curPos = null, wakeLock = null;
let sheetState = 'peek';          // 'peek' | 'full'
const cacheStatus = {};           // slug -> bool (tiles cached)

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
  renderList();                   // re-render with offline badges
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

function diffClass(d) {
  return { 'Easy':'d-easy','Moderate':'d-moderate','Hard':'d-hard','Very Hard':'d-veryhard' }[d] || 'd-moderate';
}
function diffKey(d) {
  return { 'Easy':'easy','Moderate':'moderate','Hard':'hard','Very Hard':'veryhard' }[d];
}
// Distance/elevation units: miles+feet in EN, km+meters in JA
function fmtDist(mi) { return lang === 'ja' ? `${(mi*1.609344).toFixed(1)} km` : `${mi} mi`; }
function fmtGain(ft) { return lang === 'ja' ? `${Math.round(ft/FT).toLocaleString()} m` : `${ft.toLocaleString()} ft`; }

function renderList() {
  const wrap = $('#trail-list');
  let trails = TRAILS.slice();
  if (listFilter !== 'all') trails = trails.filter(x => diffKey(x.diff) === listFilter);
  if (listSort === 'dist') trails.sort((a,b) => a.lengthMi - b.lengthMi);
  if (listSort === 'gain') trails.sort((a,b) => a.gainFt - b.gainFt);

  wrap.innerHTML = trails.map(trail => {
    const tr = loc(trail);
    const offIcon = cacheStatus[trail.slug]
      ? `<div class="card-offline ready" title="${t('dlSaved')}">✓</div>` : '';
    return `
    <article class="card" data-slug="${trail.slug}">
      <div class="card-img-wrap">
        <img class="card-img" src="${trail.img}" alt="${tr.name}" loading="lazy">
        <span class="card-badge-diff ${diffClass(trail.diff)}">${trDiff(trail.diff)}</span>
        ${offIcon}
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

  initSheetDrag();

  $('#dl-cancel').addEventListener('click', () => { $('#dl-modal').hidden = true; });
  $('#dl-go').addEventListener('click', startDownload);
}

function showList() {
  $('#detail').hidden = true;
  $('#list').hidden = false;
  if (gpsWatch !== null) stopGPS();
  curTrail = null;
}

// ════════════════════════════════════════════════════════════
//  Detail screen
// ════════════════════════════════════════════════════════════
async function openDetail(trail) {
  curTrail = trail;
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = loc(trail).name;

  setSheet('peek');
  renderPeek(trail);
  renderSheetBody(trail);
  initMap();
  await loadTrail(trail);
}

function renderPeek(trail) {
  const tr = loc(trail);
  $('#pk-title').textContent = tr.name;
  $('#pk-meta').innerHTML =
    `<span>${fmtDist(trail.lengthMi)}</span><span>▲ ${fmtGain(trail.gainFt)}</span>` +
    `<span class="${diffClass(trail.diff)}" style="background:none;padding:0">${trDiff(trail.diff)}</span>` +
    `<span class="star">★ ${trail.rating} (${trail.reviews.toLocaleString()})</span>`;
}

function renderSheetBody(trail) {
  const tr = loc(trail);
  const cached = cacheStatus[trail.slug];
  // Stat boxes: km/m in JA, mi/k-ft in EN
  const distV = lang==='ja' ? (trail.lengthMi*1.609344).toFixed(1) : trail.lengthMi;
  const distL = lang==='ja' ? '距離 (km)' : t('statDistance');
  const gainV = lang==='ja' ? Math.round(trail.gainFt/FT).toLocaleString() : (trail.gainFt/1000).toFixed(trail.gainFt>=1000?1:0)+'k';
  const gainL = lang==='ja' ? '登り (m)' : 'Ft Gain';
  $('#sheet-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="v">${distV}</div><div class="l">${distL}</div></div>
      <div class="stat-box"><div class="v">${gainV}</div><div class="l">${gainL}</div></div>
      <div class="stat-box"><div class="v" style="font-size:13px">${trDiff(trail.diff)}</div><div class="l">${t('statDifficulty')}</div></div>
      <div class="stat-box"><div class="v" style="font-size:13px">${fmtTime(trail.time)}</div><div class="l">${t('statTime')}</div></div>
    </div>

    <div id="elev-card">
      <div class="hd"><span class="t">${t('elevation')}</span><span class="r" id="elev-range"></span></div>
      <svg id="elev-svg" preserveAspectRatio="none"></svg>
    </div>

    <button class="dl-btn ${cached?'ready':''}" id="sheet-dl">
      ${cached ? t('dlSaved') : t('dlDownload')}
    </button>
    <div class="dl-prog" id="sheet-dl-prog"><i></i></div>

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
      <p style="font-size:11px;color:var(--muted)">${t('attribution')}</p>
    </div>
  `;
  $('#sheet-dl').addEventListener('click', () => openDownloadModal(trail));
  drawProfile();
}

// "3 h 17 min" → "3時間17分" (JA); strip spaces in EN as before
function fmtTime(s) {
  if (lang !== 'ja') return s.replace(/ /g,'');
  return s.replace(/~/g,'約').replace(/(\d+)\s*h(?:r)?/g,'$1時間').replace(/(\d+)\s*min/g,'$1分')
          .replace(/\s*[–-]\s*/g,'～').replace(/時間(?=～|$)/,'時間').replace(/ /g,'');
}

// ── Map ──
function initMap() {
  if (map) { map.remove(); map = null; }
  map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
  const zoom = L.control.zoom({ position:'topright' }).addTo(map);
  L.tileLayer(TILE_URL, { maxZoom:16, minZoom:8, attribution:'© USGS', crossOrigin:true }).addTo(map);
  map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
  zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
}

async function loadTrail(trail) {
  trackPts = []; trackWpts = []; totalDist = 0;
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

  trackWpts.forEach(w => {
    let best=Infinity;
    trackPts.forEach(p => { const dd=hav(w.lat,w.lon,p.lat,p.lon); if(dd<best){best=dd;w.d=p.d;} });
  });

  drawTrack();
  drawProfile();
}

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
  const coords = trackPts.filter((_,i)=>i%step===0||i===trackPts.length-1).map(p=>[p.lat,p.lon]);

  L.polyline(coords, { color:'#000', weight:7, opacity:0.25, lineJoin:'round' }).addTo(map); // halo
  trackLayer = L.polyline(coords, { color:'#ef4444', weight:4, opacity:0.95, lineJoin:'round' }).addTo(map);

  if (trackPts.length) {
    endMarker(trackPts[0], '#22c55e', 'markerTrailhead');
    const last = trackPts[trackPts.length-1];
    const isLoop = curTrail.route === 'Loop' || hav(trackPts[0].lat,trackPts[0].lon,last.lat,last.lon) < 120;
    if (!isLoop) endMarker(last, '#ef4444', 'markerEnd');
  }
  trackWpts.forEach(w => {
    w._marker = L.marker([w.lat,w.lon], { icon:dotIcon('#f59e0b',11) })
      .bindPopup(`<div class="wp-pop">${trWpt(w.name)}</div>`, {maxWidth:240})
      .addTo(map);
  });

  map.fitBounds(trackLayer.getBounds(), { paddingTopLeft:[30,70], paddingBottomRight:[30, sheetPeekHeight()+30] });
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
function drawProfile() {
  const svg = $('#elev-svg'); if (!svg || trackPts.length<2) return;
  const W = svg.clientWidth || 340, H = 96;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const eles = trackPts.map(p=>p.se);
  const lo=Math.min(...eles), hi=Math.max(...eles), range=hi-lo||1;
  const step=Math.max(1,Math.floor(trackPts.length/500));
  const sub=trackPts.filter((_,i)=>i%step===0||i===trackPts.length-1);
  const X=dd=>(dd/totalDist)*W, Y=e=>H-14-((e-lo)/range)*(H-26);

  let path=`M0,${H}`;
  sub.forEach(p=>{ path+=` L${X(p.d).toFixed(1)},${Y(p.se).toFixed(1)}`; });
  path+=` L${W},${H}Z`;
  let line=`M0,${Y(sub[0].se).toFixed(1)}`;
  sub.forEach(p=>{ line+=` L${X(p.d).toFixed(1)},${Y(p.se).toFixed(1)}`; });

  const wp = trackWpts.filter(w=>w.d!=null).map(w=>{
    const x=X(w.d).toFixed(1);
    return `<line x1="${x}" y1="4" x2="${x}" y2="${H}" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>`;
  }).join('');

  svg.innerHTML = `
    <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#1e3a8a" stop-opacity="0.15"/>
    </linearGradient></defs>
    ${wp}
    <path d="${path}" fill="url(#eg)"/>
    <path d="${line}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
    <g id="epos"></g>`;
  $('#elev-range').textContent = fmtElevRange(lo, hi);
}

// Profile axis labels: feet in EN, meters in JA
function fmtElevRange(loM, hiM) {
  if (lang === 'ja') return `${Math.round(loM).toLocaleString()}～${Math.round(hiM).toLocaleString()} m`;
  return `${Math.round(loM*FT).toLocaleString()}–${Math.round(hiM*FT).toLocaleString()} ft`;
}

function updateProfilePos(idx){
  const svg=$('#elev-svg'); if(!svg) return;
  const g=$('#epos'); if(!g) return;
  const W=svg.viewBox.baseVal.width||340, H=96;
  const eles=trackPts.map(p=>p.se);
  const lo=Math.min(...eles), hi=Math.max(...eles), range=hi-lo||1;
  const p=trackPts[idx];
  const x=((p.d/totalDist)*W).toFixed(1);
  const y=(H-14-((p.se-lo)/range)*(H-26)).toFixed(1);
  g.innerHTML=`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#fff" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.8"/>
    <circle cx="${x}" cy="${y}" r="4.5" fill="#3b82f6" stroke="#fff" stroke-width="2"/>`;
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
    gpsAcc=L.circle([lat,lon],{radius:accuracy,fillColor:'#3b82f6',fillOpacity:0.08,color:'#3b82f6',weight:1}).addTo(map);
  } else { gpsMk.setLatLng([lat,lon]); gpsAcc.setLatLng([lat,lon]); gpsAcc.setRadius(accuracy); }
  if(gpsFollow) map.setView([lat,lon], Math.max(map.getZoom(),15), {animate:true});
  if(trackPts.length){
    let best=Infinity,idx=0;
    trackPts.forEach((p,i)=>{const dd=hav(lat,lon,p.lat,p.lon);if(dd<best){best=dd;idx=i;}});
    updateProfilePos(idx);
  }
}
function onPosErr(err){ if(err.code===1){ alert(t('alertDenied')); stopGPS(); } }

async function reqWake(){ if('wakeLock'in navigator){try{wakeLock=await navigator.wakeLock.request('screen');}catch(_){}}}
async function relWake(){ if(wakeLock){try{await wakeLock.release();}catch(_){}wakeLock=null;} }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && gpsWatch!==null && !wakeLock) reqWake(); });

// ════════════════════════════════════════════════════════════
//  Bottom sheet drag
// ════════════════════════════════════════════════════════════
function sheetPeekHeight(){ return Math.round(window.innerHeight*0.16); }
function setSheet(state){
  sheetState=state;
  const sheet=$('#sheet');
  const fab=$('#btn-gps');
  if (matchMedia('(orientation:landscape) and (max-height:560px)').matches){
    sheet.style.height='';
    if(fab) fab.style.bottom = `calc(20px + var(--safe-b))`;
    return;
  }
  if(state==='peek') sheet.style.height = sheetPeekHeight()+'px';
  else if(state==='full') sheet.style.height = '90dvh';
  if(fab) fab.style.bottom = `calc(${sheetPeekHeight()}px + 14px)`;
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
//  Tile download (offline)
// ════════════════════════════════════════════════════════════
let dlTrail=null, dlRunning=false;
function openDownloadModal(trail){
  dlTrail=trail;
  const n=countTiles(trail);
  $('#dl-desc').textContent=tf('dlDesc')(loc(trail).name, n);
  $('#dl-bar').style.width='0%'; $('#dl-status').textContent=tf('dlTiles')(n);
  $('#dl-go').textContent=t('dlGo'); $('#dl-go').disabled=false;
  $('#dl-modal').hidden=false;
}
function trailBox(trail){
  let n=-90,s=90,e=-180,w=180;
  if(trackPts.length && trail===curTrail){
    trackPts.forEach(p=>{ n=Math.max(n,p.lat);s=Math.min(s,p.lat);e=Math.max(e,p.lon);w=Math.min(w,p.lon); });
  } else {
    n=trail.center[0]+0.02; s=trail.center[0]-0.02; e=trail.center[1]+0.02; w=trail.center[1]-0.02;
  }
  return { n:n+PAD, s:s-PAD, e:e+PAD, w:w-PAD };
}
function countTiles(trail){
  let n=0; const b=trailBox(trail);
  DL_ZOOMS.forEach(z=>{ const r=tRange(b,z); n+=(r.x1-r.x0+1)*(r.y1-r.y0+1); });
  return n;
}
function tileURLs(trail){
  const urls=[]; const b=trailBox(trail);
  DL_ZOOMS.forEach(z=>{ const r=tRange(b,z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++)
      urls.push(TILE_URL.replace('{z}',z).replace('{y}',y).replace('{x}',x)); });
  return urls;
}
function tRange(b,z){ const a=ll2t(b.s,b.w,z), c=ll2t(b.n,b.e,z);
  return {x0:Math.min(a.x,c.x),x1:Math.max(a.x,c.x),y0:Math.min(a.y,c.y),y1:Math.max(a.y,c.y)}; }
function ll2t(lat,lon,z){ const n=1<<z; const x=Math.floor(n*(lon+180)/360);
  const r=lat*Math.PI/180; const y=Math.floor(n*(1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2);
  return {x,y}; }

async function startDownload(){
  if(dlRunning||!dlTrail) return;
  dlRunning=true;
  $('#dl-go').disabled=true; $('#dl-go').textContent=t('dlDownloading');
  const urls=tileURLs(dlTrail), total=urls.length; let done=0;
  const cache=await caches.open(TILE_CACHE), BATCH=8;
  for(let i=0;i<urls.length;i+=BATCH){
    await Promise.allSettled(urls.slice(i,i+BATCH).map(async u=>{
      try{ if(!(await cache.match(u))){ const r=await fetch(u,{mode:'cors'}); if(r.ok||r.type==='opaque') await cache.put(u,r); } }catch(_){}
      done++;
      const pct=Math.round(done/total*100);
      $('#dl-bar').style.width=pct+'%'; $('#dl-status').textContent=tf('dlProgress')(done,total,pct);
    }));
  }
  dlRunning=false;
  $('#dl-status').textContent=tf('dlDone')(done);
  $('#dl-go').textContent=t('dlDoneBtn');
  cacheStatus[dlTrail.slug]=true;
  const b=$('#sheet-dl'); if(b){ b.classList.add('ready'); b.textContent=t('dlSaved'); }
  renderList();
  setTimeout(()=>{ $('#dl-modal').hidden=true; }, 1400);
}

async function refreshCacheStatus(){
  if(!('caches'in window)) return;
  try{
    const cache=await caches.open(TILE_CACHE);
    for(const trail of TRAILS){
      const z=14, {x,y}=ll2t(trail.center[0],trail.center[1],z);
      const u=TILE_URL.replace('{z}',z).replace('{y}',y).replace('{x}',x);
      cacheStatus[trail.slug] = !!(await cache.match(u));
    }
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
  if(curTrail && map){ map.invalidateSize(); setSheet(sheetState); drawProfile();
    if(trackLayer) map.fitBounds(trackLayer.getBounds(),{paddingTopLeft:[30,70],paddingBottomRight:[30,sheetPeekHeight()+30]}); }
},250); });
