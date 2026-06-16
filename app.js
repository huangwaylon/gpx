'use strict';

/* ════════════════════════════════════════════════════════════
   Washington Trails — offline hiking PWA
   ════════════════════════════════════════════════════════════ */

const TILE_URL   = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const TILE_CACHE = 'wa-trails-tiles-v1';
const DL_ZOOMS   = [10, 11, 12, 13, 14, 15, 16];
const PAD        = 0.01;          // bbox padding in degrees for tile download
const FT         = 3.28084;
const MI         = 1609.344;

// ── App state ──
let map = null, curTrail = null;
let trackLayer = null, markerLayer = null, gpsLayer = null;
let trackPts = [], trackWpts = [];
let totalDist = 0, gpsWatch = null, gpsMk = null, gpsAcc = null, gpsFollow = false;
let curPos = null, wakeLock = null;
let sheetState = 'peek';          // 'peek' | 'full' | 'hidden'
const cacheStatus = {};           // slug -> bool (tiles cached)

const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// ════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════
window.addEventListener('load', async () => {
  renderList();
  bindGlobal();
  checkInstall();
  await refreshCacheStatus();
  renderList();                   // re-render with offline badges
  routeFromHash();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
});
window.addEventListener('hashchange', routeFromHash);

function routeFromHash() {
  const m = location.hash.match(/^#\/trail\/([\w-]+)/);
  if (m) {
    const t = TRAILS.find(x => x.slug === m[1]);
    if (t) { openDetail(t); return; }
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

function renderList() {
  const wrap = $('#trail-list');
  let trails = TRAILS.slice();
  if (listFilter !== 'all') trails = trails.filter(t => diffKey(t.diff) === listFilter);
  if (listSort === 'dist') trails.sort((a,b) => a.lengthMi - b.lengthMi);
  if (listSort === 'gain') trails.sort((a,b) => a.gainFt - b.gainFt);

  wrap.innerHTML = trails.map(t => {
    const cached = cacheStatus[t.slug];
    const offIcon = cached
      ? '<div class="card-offline ready" title="Available offline">✓</div>'
      : '';
    return `
    <article class="card" data-slug="${t.slug}">
      <div class="card-img-wrap">
        <img class="card-img" src="${t.img}" alt="${t.name}" loading="lazy">
        <span class="card-badge-diff ${diffClass(t.diff)}">${t.diff}</span>
        ${offIcon}
        <div class="card-titlebar">
          <div class="card-title">${t.name}</div>
          <div class="card-area">${t.area}</div>
        </div>
      </div>
      <div class="card-stats">
        <span class="s"><span class="ic">↔</span>${t.lengthMi} mi</span>
        <span class="s"><span class="ic">▲</span>${t.gainFt.toLocaleString()} ft</span>
        <span class="s"><span class="ic">⟳</span>${t.route}</span>
        <span class="s star">★ ${t.rating}</span>
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

  $('#btn-back').addEventListener('click', () => { location.hash = ''; });
  $('#btn-gps').addEventListener('click', toggleGPS);

  // sheet drag
  initSheetDrag();

  // install
  $('#install-x').addEventListener('click', () => { $('#install').hidden = true; localStorage.installDismiss = '1'; });

  // download modal
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
async function openDetail(t) {
  curTrail = t;
  $('#list').hidden = true;
  $('#detail').hidden = false;
  $('#detail-title').textContent = t.name;

  // reset sheet to peek
  setSheet('peek');
  $('#pk-title').textContent = t.name;
  $('#pk-meta').innerHTML =
    `<span>${t.lengthMi} mi</span><span>▲ ${t.gainFt.toLocaleString()} ft</span>` +
    `<span class="${diffClass(t.diff)}" style="background:none;padding:0">${t.diff}</span>` +
    `<span class="star">★ ${t.rating} (${t.reviews.toLocaleString()})</span>`;

  renderSheetBody(t);
  initMap();
  await loadTrail(t);
}

function renderSheetBody(t) {
  const cached = cacheStatus[t.slug];
  $('#sheet-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="v">${t.lengthMi}</div><div class="l">Miles</div></div>
      <div class="stat-box"><div class="v">${(t.gainFt/1000).toFixed(t.gainFt>=1000?1:0)}k</div><div class="l">Ft Gain</div></div>
      <div class="stat-box"><div class="v" style="font-size:13px">${t.diff}</div><div class="l">Difficulty</div></div>
      <div class="stat-box"><div class="v" style="font-size:13px">${t.time.replace(/ /g,'')}</div><div class="l">Time</div></div>
    </div>

    <div id="elev-card">
      <div class="hd"><span class="t">Elevation</span><span class="r" id="elev-range"></span></div>
      <svg id="elev-svg" preserveAspectRatio="none"></svg>
    </div>

    <button class="dl-btn ${cached?'ready':''}" id="sheet-dl">
      ${cached ? '✓ Map saved for offline' : '⬇ Download map for offline'}
    </button>
    <div class="dl-prog" id="sheet-dl-prog"><i></i></div>

    <div class="section">
      <h3>Overview</h3>
      <p>${t.summary}</p>
    </div>
    <div class="section">
      <h3>The hike</h3>
      <p>${t.description}</p>
    </div>
    <div class="section">
      <h3>Tips & need-to-know</h3>
      <ul class="tips">${t.tips.map(x=>`<li>${x}</li>`).join('')}</ul>
    </div>
    <div class="section">
      <h3>Details</h3>
      <dl class="facts">
        <dt>Route type</dt><dd>${t.route}</dd>
        <dt>Best season</dt><dd>${t.season}</dd>
        <dt>Dogs</dt><dd>${t.dogs}</dd>
        <dt>Permit</dt><dd>${t.permit}</dd>
        <dt>Location</dt><dd>${t.area}</dd>
      </dl>
    </div>
    <div class="section">
      <p style="font-size:11px;color:var(--muted)">
        Trail info &amp; photo via AllTrails. Map © USGS National Map.
      </p>
    </div>
  `;
  $('#sheet-dl').addEventListener('click', () => openDownloadModal(t));
}

// ── Map ──
function initMap() {
  if (map) { map.remove(); map = null; }
  map = L.map('map', { zoomControl:false, attributionControl:true, center:curTrail.center, zoom:13, tap:true });
  const zoom = L.control.zoom({ position:'topright' }).addTo(map);
  L.tileLayer(TILE_URL, { maxZoom:16, minZoom:8, attribution:'© USGS', crossOrigin:true }).addTo(map);
  map.on('dragstart', () => { gpsFollow = false; $('#btn-gps').classList.remove('on'); });
  // nudge zoom control below header
  zoom.getContainer().style.marginTop = 'calc(54px + env(safe-area-inset-top,0px))';
}

async function loadTrail(t) {
  trackPts = []; trackWpts = []; totalDist = 0;
  let text;
  try { text = await (await fetch(t.gpx)).text(); }
  catch(e) { console.error('GPX load failed', e); return; }
  const xml = new DOMParser().parseFromString(text, 'text/xml');

  // waypoints
  xml.querySelectorAll('wpt').forEach(w => {
    const lat=+w.getAttribute('lat'), lon=+w.getAttribute('lon');
    const name=(w.querySelector('name')?.textContent||'').trim().replace(/\s+/g,' ');
    trackWpts.push({ lat, lon, name, d:null });
  });

  // track
  let pLat=null,pLon=null,d=0;
  xml.querySelectorAll('trkpt').forEach(n => {
    const lat=+n.getAttribute('lat'), lon=+n.getAttribute('lon');
    const ele=+(n.querySelector('ele')?.textContent ?? 0);
    if (pLat!==null) d += hav(pLat,pLon,lat,lon);
    trackPts.push({ lat, lon, ele, d });
    pLat=lat; pLon=lon;
  });
  totalDist = d;

  // smooth elevations for display
  smoothEle();

  // snap waypoints to track distance
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

  // endpoints
  if (trackPts.length) {
    endMarker(trackPts[0], '#22c55e', 'Trailhead');
    const last = trackPts[trackPts.length-1];
    const isLoop = curTrail.route === 'Loop' || hav(trackPts[0].lat,trackPts[0].lon,last.lat,last.lon) < 120;
    if (!isLoop) endMarker(last, '#ef4444', 'End');
  }
  // waypoints
  trackWpts.forEach(w => {
    L.marker([w.lat,w.lon], { icon:dotIcon('#f59e0b',11) })
      .bindPopup(`<div class="wp-pop">${w.name}</div>`, {maxWidth:240})
      .addTo(map);
  });

  map.fitBounds(trackLayer.getBounds(), { paddingTopLeft:[30,70], paddingBottomRight:[30, sheetPeekHeight()+30] });
}

function endMarker(p,color,label){
  L.marker([p.lat,p.lon], { icon:dotIcon(color,15) })
    .bindPopup(`<div class="wp-pop">${label}</div>`).addTo(map);
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
  const X=d=>(d/totalDist)*W, Y=e=>H-14-((e-lo)/range)*(H-26);

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
  $('#elev-range').textContent = `${Math.round(lo*FT).toLocaleString()}–${Math.round(hi*FT).toLocaleString()} ft`;
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
  if (!navigator.geolocation){ alert('Geolocation not available on this device.'); return; }
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
function onPosErr(err){ if(err.code===1){ alert('Location access denied. Enable it in Settings → Privacy → Location Services → Safari.'); stopGPS(); } }

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
  // GPS fab sits just above the peek sheet; hidden behind sheet when expanded
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
  // tap peek toggles
  peek.addEventListener('click',()=>{ if(!dragging) setSheet(sheetState==='peek'?'full':'peek'); });
}

// ════════════════════════════════════════════════════════════
//  Tile download (offline)
// ════════════════════════════════════════════════════════════
let dlTrail=null, dlRunning=false;
function openDownloadModal(t){
  dlTrail=t;
  const n=countTiles(t);
  $('#dl-desc').textContent=`Save ~${n} map tiles for "${t.name}" so it works without service. Stored on your phone.`;
  $('#dl-bar').style.width='0%'; $('#dl-status').textContent=`${n} tiles`;
  $('#dl-go').textContent='Download'; $('#dl-go').disabled=false;
  $('#dl-modal').hidden=false;
}
function trailBox(t){
  let n=-90,s=90,e=-180,w=180;
  // prefer track bounds; fall back to center
  if(trackPts.length && t===curTrail){
    trackPts.forEach(p=>{ n=Math.max(n,p.lat);s=Math.min(s,p.lat);e=Math.max(e,p.lon);w=Math.min(w,p.lon); });
  } else {
    n=t.center[0]+0.02; s=t.center[0]-0.02; e=t.center[1]+0.02; w=t.center[1]-0.02;
  }
  return { n:n+PAD, s:s-PAD, e:e+PAD, w:w-PAD };
}
function countTiles(t){
  let n=0; const b=trailBox(t);
  DL_ZOOMS.forEach(z=>{ const r=tRange(b,z); n+=(r.x1-r.x0+1)*(r.y1-r.y0+1); });
  return n;
}
function tileURLs(t){
  const urls=[]; const b=trailBox(t);
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
  $('#dl-go').disabled=true; $('#dl-go').textContent='Downloading…';
  const urls=tileURLs(dlTrail), total=urls.length; let done=0;
  const cache=await caches.open(TILE_CACHE), BATCH=8;
  for(let i=0;i<urls.length;i+=BATCH){
    await Promise.allSettled(urls.slice(i,i+BATCH).map(async u=>{
      try{ if(!(await cache.match(u))){ const r=await fetch(u,{mode:'cors'}); if(r.ok||r.type==='opaque') await cache.put(u,r); } }catch(_){}
      done++;
      const pct=Math.round(done/total*100);
      $('#dl-bar').style.width=pct+'%'; $('#dl-status').textContent=`${done} / ${total} (${pct}%)`;
    }));
  }
  dlRunning=false;
  $('#dl-status').textContent=`Done — saved ${done} tiles.`;
  $('#dl-go').textContent='Done';
  cacheStatus[dlTrail.slug]=true;
  // update sheet button + list badge
  const b=$('#sheet-dl'); if(b){ b.classList.add('ready'); b.textContent='✓ Map saved for offline'; }
  renderList();
  setTimeout(()=>{ $('#dl-modal').hidden=true; }, 1400);
}

// Determine which trails already have tiles cached (sample center tile per zoom 14)
async function refreshCacheStatus(){
  if(!('caches'in window)) return;
  try{
    const cache=await caches.open(TILE_CACHE);
    for(const t of TRAILS){
      const z=14, {x,y}=ll2t(t.center[0],t.center[1],z);
      const u=TILE_URL.replace('{z}',z).replace('{y}',y).replace('{x}',x);
      cacheStatus[t.slug] = !!(await cache.match(u));
    }
  }catch(_){}
}

// ════════════════════════════════════════════════════════════
//  Install banner
// ════════════════════════════════════════════════════════════
function checkInstall(){
  const standalone = window.navigator.standalone || matchMedia('(display-mode:standalone)').matches;
  if(!standalone && !localStorage.installDismiss) $('#install').hidden=false;
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
