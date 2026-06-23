/* eslint-disable */
// WebCartographer tile cache service worker.
//
// Intercepts cross-origin requests to WebCartographer-style tile URLs
// (any host, path matching `/data/world/{z}/{x}_{y}.png`) and serves them
// from a persistent Cache Storage bucket. The WC host (e.g.
// map.tops.vintagestory.at) does not send CORS headers, so the page's JS
// can't `fetch()` the tiles — but a service worker CAN, by issuing the
// request in `no-cors` mode and storing the resulting opaque response.
// `<img src="…">` happily renders an opaque cached response served back
// by the SW, just as if it had come from the network.
//
// The browser's HTTP cache only honours WC's `max-age=600` (10 min) and
// then revalidates on every reload, which still costs a request per tile.
// This SW keeps the bytes locally indefinitely. Invalidation is driven by
// the page: when the upstream `landmarks.geojson` / `translocators.geojson`
// `Last-Modified` advances, the page posts `{ type: 'WC_SET_VERSION',
// version }`. If the version differs from what's stored in the SW's
// IndexedDB, the cache is wiped before the next request lands.
//
// Same-origin requests and any URL that doesn't match the WC tile pattern
// pass through untouched.

const CACHE_NAME = "wc-tiles-v1";
const VERSION_DB = "wc-tile-sw";
const VERSION_STORE = "kv";
const VERSION_KEY = "version";

const TILE_RE = /\/data\/world\/\d+\/\d+_\d+\.(?:png|webp)(?:\?.*)?$/;

self.addEventListener("install", () => {
  // Take over the page on first load instead of waiting for the next
  // navigation — caching only kicks in once the SW controls the client,
  // and we want that to be true for the very session that registered it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!TILE_RE.test(url.pathname)) return;

  event.respondWith(handleTileFetch(req));
});

async function handleTileFetch(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;

  try {
    // `no-cors` produces an opaque response. We can't inspect it, but we
    // can store it and `<img>` can render it — that's all we need.
    // `cache: 'default'` lets the browser's HTTP cache contribute when
    // it has a fresh copy (max-age=600), saving a network round-trip on
    // the very first request after install.
    const fresh = await fetch(req, { mode: "no-cors", credentials: "omit" });
    // Opaque responses report status 0 / ok=false even on a real 200, so
    // treat `type === 'opaque'` as success. We deliberately do NOT cache
    // genuine 404s (sparse WC pyramids 404 on every unexplored cell) —
    // those return type="basic" with ok=false here only if CORS happens
    // to allow it, which won't be the case for WC, so opaque is the
    // expected success path.
    if (fresh && (fresh.type === "opaque" || fresh.ok)) {
      // `cache.put` clones the response internally, so we can return the
      // original. Failures (quota, abort) are swallowed — the user still
      // gets the tile this load, we just won't serve it from cache next
      // time.
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "WC_INVALIDATE_TILES") {
    event.waitUntil(caches.delete(CACHE_NAME));
    return;
  }
  if (data.type === "WC_SET_VERSION" && typeof data.version === "string") {
    event.waitUntil(maybeInvalidateForVersion(data.version));
  }
});

async function maybeInvalidateForVersion(nextVersion) {
  let stored;
  try {
    stored = await idbGet(VERSION_KEY);
  } catch {
    stored = undefined;
  }
  if (stored === nextVersion) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // Ignore — worst case the next request rewrites a stale entry.
  }
  try {
    await idbSet(VERSION_KEY, nextVersion);
  } catch {
    // Ignore — losing the version means we'll wipe the cache once more
    // on the next mismatch, which is harmless.
  }
}

// Tiny IndexedDB-backed kv store. Service workers don't have access to
// localStorage, so persistent state has to live in IDB or Cache Storage.
function openVersionDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VERSION_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VERSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openVersionDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VERSION_STORE, "readonly");
    const req = tx.objectStore(VERSION_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openVersionDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VERSION_STORE, "readwrite");
    tx.objectStore(VERSION_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
