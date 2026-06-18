'use strict';

/* ════════════════════════════════════════════════════════════
   Tile store — saved map tiles live in IndexedDB, NOT Cache Storage.
   This file is loaded verbatim by BOTH the page (<script src>) and the
   service worker (importScripts), so they share one store: the SW reads
   tiles to serve them; the page (downloadAll / refreshCacheStatus) writes
   and probes them. Keyed by the full tile URL; value = { body, type }.

   Why not the Cache API (where tiles used to live)?  On WebKit/iOS, opening
   a Cache loads its whole record index, so a cache holding thousands of tiles
   (~5k after a full "Save maps") is slow to open — and that open sits on the
   launch critical path, giving a multi-second black screen on every relaunch.
   IndexedDB does an indexed key lookup instead. With tiles out of Cache
   Storage the app-shell cache stays tiny (~20 files), so the PWA launches fast
   no matter how many tiles are saved, and offline tile reads stay quick too.
   ════════════════════════════════════════════════════════════ */
(function (scope) {
  const DB_NAME = 'wa-trails-tiles', STORE = 'tiles', VERSION = 1;
  let dbPromise = null;

  function db() {
    return dbPromise || (dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);  // out-of-line key = tile URL
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => { dbPromise = null; reject(req.error); };   // null the memo so the next call retries — don't cache a rejected open for the whole session
    }));
  }

  // Run one request inside a fresh transaction; resolve with its result.
  function run(mode, make) {
    return db().then(d => new Promise((resolve, reject) => {
      const req = make(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }));
  }

  scope.TileStore = {
    // Stored bytes for a tile URL → { body:ArrayBuffer, type:string } | undefined.
    get(url)      { return run('readonly',  s => s.get(url)); },
    // Cheap existence probe — counts the key, never deserializes the bytes.
    has(url)      { return run('readonly',  s => s.count(url)).then(n => n > 0); },
    // Store a tile's bytes + content-type under its URL.
    put(url, rec) { return run('readwrite', s => s.put(rec, url)); },
  };
})(self);
