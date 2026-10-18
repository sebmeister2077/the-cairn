// Runtime loader for the recorded map-features datasets (broken translocators,
// traders, trader claims, player claims). These are produced by the VSProxy
// `--map-export` writer, contributed to the backend, merged across all
// contributors, and published to the public R2 bucket as one self-describing
// envelope per category (`map-features.<category>.json`).
//
// When `VITE_PUBLIC_BUCKET_ORIGIN` is set we fetch the merged files straight
// from R2 at runtime (no commit / redeploy needed to refresh the map);
// otherwise we fall back to the committed static bundle under
// `src/assets/MapFeaturesJson/` for local dev.
//
// Cache invalidation mirrors the Auction House loader: the data files are
// uploaded `immutable`, so we bust their cache with `?v=<version>` read from
// `map-features/manifest.json` (uploaded `no-cache`). A republish flips the
// version → every data URL changes → old cached copies are dropped.

const publicBucketOrigin = import.meta.env.VITE_PUBLIC_BUCKET_ORIGIN?.replace(/\/+$/, "");
const USE_R2 = Boolean(publicBucketOrigin);
const MAP_FEATURES_BASE = `${publicBucketOrigin}/map-features`;

/** Categories the frontend consumes (a subset of what the proxy exports). */
export type MapFeatureCategory =
    | "translocators"
    | "traders"
    | "rapids"
    | "traderclaims"
    | "playerclaims";

/** The self-describing per-category envelope. Only `features[]` is consumed. */
export interface MapFeatureFile<T> {
    features?: T[];
}

interface MapFeaturesManifest {
    version: string;
    generatedUtc?: string;
    files?: string[];
}

// Committed fallback bundle (local dev, or if R2 is unreachable). The paths are
// static literals so Vite can code-split them into lazily-loaded chunks.
const BUNDLED: Record<MapFeatureCategory, () => Promise<{ default: unknown }>> = {
    translocators: () => import("@/assets/MapFeaturesJson/map-features.translocators.json"),
    traders: () => import("@/assets/MapFeaturesJson/map-features.traders.json"),
    rapids: () => import("@/assets/MapFeaturesJson/map-features.rapids.json"),
    traderclaims: () => import("@/assets/MapFeaturesJson/map-features.traderclaims.json"),
    playerclaims: () => import("@/assets/MapFeaturesJson/map-features.playerclaims.json"),
};

// Shared manifest pointer, refreshed at most once a minute across all category
// loads. Not tied to any single request's AbortSignal.
let _manifestPromise: Promise<MapFeaturesManifest | null> | null = null;
let _manifestFetchedAt = 0;
const MANIFEST_TTL_MS = 60_000;

async function currentVersion(): Promise<string | undefined> {
    if (!USE_R2) return undefined;
    const now = Date.now();
    if (!_manifestPromise || now - _manifestFetchedAt > MANIFEST_TTL_MS) {
        _manifestFetchedAt = now;
        _manifestPromise = fetch(`${MAP_FEATURES_BASE}/manifest.json`, { cache: "no-store" })
            .then((r) => (r.ok ? (r.json() as Promise<MapFeaturesManifest>) : null))
            .catch(() => null);
    }
    const m = await _manifestPromise;
    return m?.version;
}

async function loadFromBundle<T>(category: MapFeatureCategory): Promise<T[]> {
    const mod = (await BUNDLED[category]()) as { default: MapFeatureFile<T> };
    return mod.default?.features ?? [];
}

/**
 * Load the `features[]` for one category — from the public R2 bucket when a
 * bucket origin is configured (cache-busted by the manifest version), else from
 * the committed bundle. Missing-safe: any R2 error falls back to the bundle.
 */
export async function loadMapFeatures<T>(
    category: MapFeatureCategory,
    signal?: AbortSignal,
): Promise<T[]> {
    if (USE_R2) {
        try {
            const version = await currentVersion();
            const url = version
                ? `${MAP_FEATURES_BASE}/map-features.${category}.json?v=${version}`
                : `${MAP_FEATURES_BASE}/map-features.${category}.json`;
            const res = await fetch(url, { signal });
            if (res.ok) {
                const file = (await res.json()) as MapFeatureFile<T>;
                return file.features ?? [];
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            // fall through to the committed bundle on any other R2 failure
        }
    }
    return loadFromBundle<T>(category);
}
