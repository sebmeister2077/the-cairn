// Client-side helpers for the WebCartographer tile service worker
// (`/wc-tile-sw.js`). The SW intercepts cross-origin requests to WC tile
// URLs (`*/data/world/{z}/{x}_{y}.png`) and serves them from a persistent
// Cache Storage bucket; the helpers here register it and notify it when
// the upstream content version changes so it can drop stale tiles.
//
// Only the WebCartographer map source uses this — other map sources
// (Cairn-backed pyramids, etc.) are unaffected because the SW filters by
// URL path and ignores anything that doesn't match the tile pattern.

const SW_PATH = "/wc-tile-sw.js";
/** Must stay in sync with `CACHE_NAME` inside `public/wc-tile-sw.js`. */
const CACHE_NAME = "wc-tiles-v1";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register the WC tile service worker. Idempotent — subsequent calls
 * return the same promise. Resolves to `null` when service workers are
 * unavailable (SSR, insecure context, browsers without SW support) or
 * when registration fails; callers should treat that as "no caching, but
 * not an error" and keep going.
 */
export function registerWCTileServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return Promise.resolve(null);
    }
    if (registrationPromise) return registrationPromise;
    registrationPromise = navigator.serviceWorker
        .register(SW_PATH, { scope: "/" })
        .then((reg) => reg)
        .catch((err) => {
            // Reset so a future call can retry (e.g. user grants permission,
            // network was offline at first attempt).
            registrationPromise = null;
            console.warn("WC tile service worker registration failed", err);
            return null;
        });
    return registrationPromise;
}

async function postToActiveSW(message: unknown): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await registerWCTileServiceWorker();
    if (!reg) return;
    // `ready` resolves once an active worker exists for our scope, so it
    // also covers the very first registration where `reg.active` is still
    // null because the SW is in the `installing` state.
    const ready = await navigator.serviceWorker.ready;
    ready.active?.postMessage(message);
}

/**
 * Tell the SW the current "version" of the upstream tile pyramid. When
 * this differs from what the SW has stored (in IndexedDB), the SW wipes
 * its tile cache so the next request fetches fresh bytes.
 *
 * Callers should derive the version from a stable signal that advances
 * whenever the tile imagery could have changed — typically the
 * `Last-Modified` of `landmarks.geojson` / `translocators.geojson`,
 * combined with the WC `baseUrl` so switching hosts also invalidates.
 */
export function notifyWCTileCacheVersion(version: string): void {
    void postToActiveSW({ type: "WC_SET_VERSION", version });
}

/**
 * Force-clear the SW tile cache regardless of version. Useful from
 * dev tooling or a "Clear cache" admin button.
 */
export function invalidateWCTileCache(): void {
    void postToActiveSW({ type: "WC_INVALIDATE_TILES" });
}

/**
 * Unregister the WC tile service worker and drop its cache. Called when
 * the user disables persistent tile caching from Account → Appearance so
 * subsequent tile requests go straight to the network (and the browser's
 * normal HTTP cache, which only honours WC's `max-age=600`). Safe to
 * call when no SW is registered.
 */
export async function disableWCTileCache(): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Reset our memoised registration promise so a future
    // `registerWCTileServiceWorker()` (user re-enables the toggle) starts
    // fresh instead of returning the now-defunct registration.
    registrationPromise = null;
    try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
            regs
                .filter((r) => r.active?.scriptURL.endsWith(SW_PATH))
                .map((r) => r.unregister()),
        );
    } catch (err) {
        console.warn("WC tile service worker unregister failed", err);
    }
    // `caches` is available in window scope too, so we can wipe the
    // bucket directly without having to message a worker that may have
    // just been unregistered.
    if (typeof caches !== "undefined") {
        try {
            await caches.delete(CACHE_NAME);
        } catch (err) {
            console.warn("WC tile cache delete failed", err);
        }
    }
}
