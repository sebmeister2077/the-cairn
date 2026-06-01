// React Query–backed loaders for the landmarks / translocators overlay
// GeoJSON files. These files are large-ish (hundreds of KB), so we want to:
//
//   1. Persist the parsed result via the global React Query persister
//      (`meta.persist: true`) so reloads don't re-download or re-parse.
//   2. Avoid hammering R2 even when the URL endpoint says the presigned URL
//      expired — the underlying file rarely changes. The URL endpoint
//      returns an `etag` that mirrors the R2 object's ETag; if the cached
//      etag matches we keep the parsed payload and just refresh the
//      expiry timestamp.
//   3. Treat `expires_in_seconds` as the freshness window. We refresh a
//      minute early so an in-flight request can't end up holding a URL
//      that's already invalid.

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { getLandmarksUrl, getTranslocatorsUrl, getTradersUrl, type MarkerFileUrlResponse, type TradersUrlResponse } from "@/lib/api";
import type {
    LandmarkProperty,
    WorldLineSegment,
    WorldPointMarker,
} from "@/components/MapViewer";
import { TRADER_TYPE_COLORS, isTraderType, type TraderType } from "@/lib/trader-types";

export interface CachedOverlay<T> {
    etag: string;
    /** Epoch ms after which we should re-call the URL endpoint. */
    expiresAt: number;
    data: T;
}

export const LANDMARKS_QUERY_KEY = ["overlay", "landmarks"] as const;
// Bump the version suffix whenever `parseTranslocators` starts producing
// new fields — the persister replays the previously-parsed payload as
// long as the etag matches, so without a key change old clients keep
// seeing pre-change data forever.
export const TRANSLOCATORS_QUERY_KEY = ["overlay", "translocators", "v3"] as const;
export const TRADERS_QUERY_KEY = ["overlay", "traders"] as const;

// Refresh ~1 minute before the server says the URL expires so the in-flight
// fetch can't race the deadline.
const EXPIRY_GUARD_MS = 60_000;

export function parseLandmarks(json: unknown): WorldPointMarker[] {
    const features = Array.isArray((json as { features?: unknown })?.features)
        ? ((json as { features: unknown[] }).features)
        : [];
    const points: WorldPointMarker[] = [];

    for (const feature of features) {
        const f = feature as { geometry?: { type?: string; coordinates?: unknown }; properties?: unknown };
        const geometry = f?.geometry;
        if (!geometry || geometry.type !== "Point") continue;
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        const [x, z] = coords as [number, number];
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

        const props = (f?.properties ?? {}) as LandmarkProperty & { origin?: unknown };
        if (props.type === "Misc") continue;

        points.push({
            x,
            // Server stores +Z = south; the viewer uses +Z = north, so flip.
            z: -z,
            label: typeof props.label === "string" ? props.label : undefined,
            kind: typeof props.type === "string" ? props.type : undefined,
            origin: props.origin === "user" ? "user" : undefined,
        });
    }

    return points;
}

export function parseTranslocators(json: unknown): WorldLineSegment[] {
    const features = Array.isArray((json as { features?: unknown })?.features)
        ? ((json as { features: unknown[] }).features)
        : [];
    const segments: WorldLineSegment[] = [];

    for (const feature of features) {
        const f = feature as {
            geometry?: { type?: string; coordinates?: unknown };
            properties?: Record<string, unknown>;
        };
        const geometry = f?.geometry;
        if (!geometry || geometry.type !== "LineString") continue;
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        const props = f.properties ?? {};
        // User-contributed segments are stamped with `origin: "user"` (chat
        // log) or `"user_manual"` (manual entry) and carry per-segment audit
        // info on the feature itself, so the map hover can show "added by
        // … at …" without an extra fetch.
        const isUser = props.origin === "user" || props.origin === "user_manual";
        const kind: WorldLineSegment["kind"] = isUser ? "user" : "default";
        const segmentId = typeof props.id === "string" ? props.id : undefined;
        const addedBy = typeof props.added_by === "string" ? props.added_by : undefined;
        const addedAt = typeof props.added_at === "string" ? props.added_at : undefined;
        const meta: WorldLineSegment["meta"] | undefined = isUser
            ? { segmentId, addedBy, addedAt }
            : undefined;
        const depth1 = typeof props.depth1 === "number" ? props.depth1 : undefined;
        const depth2 = typeof props.depth2 === "number" ? props.depth2 : undefined;
        for (let i = 1; i < coords.length; i++) {
            const [x1, z1raw] = (coords[i - 1] ?? []) as [number, number];
            const [x2, z2raw] = (coords[i] ?? []) as [number, number];
            const z1 = -z1raw;
            const z2 = -z2raw;
            if (
                Number.isFinite(x1) &&
                Number.isFinite(z1) &&
                Number.isFinite(x2) &&
                Number.isFinite(z2)
            ) {
                segments.push({
                    x1,
                    z1,
                    x2,
                    z2,
                    y1: Number.isFinite(depth1) ? depth1 : undefined,
                    y2: Number.isFinite(depth2) ? depth2 : undefined,
                    id: segmentId,
                    kind,
                    meta,
                });
            }
        }
    }

    return segments;
}

/**
 * Generic helper that wires a presigned-URL endpoint + parser into a single
 * React Query whose `data` is `{ etag, expiresAt, data }`. Re-uses cached
 * `data` when the server reports the same etag, even if the URL itself
 * rotated.
 */
function useOverlayFile<T>(
    queryKey: readonly string[],
    fetchUrlInfo: () => Promise<MarkerFileUrlResponse>,
    parse: (json: unknown) => T,
): UseQueryResult<CachedOverlay<T>> {
    const queryClient = useQueryClient();

    return useQuery<CachedOverlay<T>>({
        queryKey: [...queryKey],
        queryFn: async () => {
            const info = await fetchUrlInfo();
            const expiresAt =
                Date.now() + Math.max(0, info.expires_in_seconds * 1000 - EXPIRY_GUARD_MS);

            const cached = queryClient.getQueryData<CachedOverlay<T>>([...queryKey]);
            if (cached && cached.etag === info.etag) {
                // Underlying file hasn't changed — keep the parsed payload
                // and just refresh the validity window.
                return { etag: info.etag, expiresAt, data: cached.data };
            }

            const res = await fetch(info.url);
            if (!res.ok) {
                throw new Error(`Failed to load overlay data (${res.status})`);
            }
            const json: unknown = await res.json();
            return { etag: info.etag, expiresAt, data: parse(json) };
        },
        staleTime: 0
        //     ({ state }) => {
        //     const d = state.data as CachedOverlay<T> | undefined;
        //     if (!d) return 0;
        //     return Math.max(0, d.expiresAt - Date.now());
        // }
        ,
        // Opt into the global persister (see App.tsx). Combined with the
        // `staleTime` above this means: persisted data is replayed on
        // mount, and we only call the URL endpoint again once its embedded
        // expiry has elapsed.
        meta: { persist: true },
    });
}

export function useLandmarksOverlay(): UseQueryResult<CachedOverlay<WorldPointMarker[]>> {
    return useOverlayFile(LANDMARKS_QUERY_KEY, getLandmarksUrl, parseLandmarks);
}

export function useTranslocatorsOverlay(): UseQueryResult<CachedOverlay<WorldLineSegment[]>> {
    return useOverlayFile(TRANSLOCATORS_QUERY_KEY, getTranslocatorsUrl, parseTranslocators);
}

/**
 * Each trader feature in the geojson carries
 *   ``properties: { trader_id, trader_type, label?, ... }``
 * and a Point geometry whose Z follows the server (south-positive) convention.
 * We flip Z to match the on-screen +Z = north convention and tag the marker
 * with the per-type color so MapViewer can render it without re-importing
 * the palette.
 */
export interface TraderMarker extends WorldPointMarker {
    id: string;
    trader_type: TraderType;
}

function parseTraders(json: unknown): TraderMarker[] {
    const features = Array.isArray((json as { features?: unknown })?.features)
        ? ((json as { features: unknown[] }).features)
        : [];
    const out: TraderMarker[] = [];
    for (const feature of features) {
        const f = feature as {
            geometry?: { type?: string; coordinates?: unknown };
            properties?: Record<string, unknown>;
        };
        const geometry = f?.geometry;
        if (!geometry || geometry.type !== "Point") continue;
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        const [x, z] = coords as [number, number];
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const props = f.properties ?? {};
        const traderId = typeof props.id === "string" ? props.id : null;
        const traderType = props.trader_type;
        if (!traderId || !isTraderType(traderType)) continue;
        out.push({
            x,
            z: -z,
            label: typeof props.label === "string" ? props.label : undefined,
            kind: "Trader",
            color: TRADER_TYPE_COLORS[traderType],
            id: traderId,
            trader_type: traderType,
        });
    }
    return out;
}

/**
 * Traders overlay. Distinct from landmarks/translocators because the
 * URL endpoint may legitimately return ``{url: null, disabled|empty: true}``
 * — in that case we yield an empty marker list with a synthetic etag so
 * the persister can still cache the "nothing to show" state cheaply.
 */
export function useTradersOverlay(): UseQueryResult<CachedOverlay<TraderMarker[]>> {
    const queryClient = useQueryClient();

    return useQuery<CachedOverlay<TraderMarker[]>>({
        queryKey: [...TRADERS_QUERY_KEY],
        queryFn: async () => {
            const info: TradersUrlResponse = await getTradersUrl();
            // No file (flag off or no contributions yet) → return empty
            // overlay; refresh every 5 min so contributions become visible
            // without forcing a page reload.
            if (!info.url) {
                return {
                    etag: info.disabled ? "__disabled__" : "__empty__",
                    expiresAt: Date.now() + 5 * 60_000,
                    data: [] as TraderMarker[],
                };
            }
            const expiresAt =
                Date.now() + Math.max(0, (info.expires_in_seconds ?? 3600) * 1000 - EXPIRY_GUARD_MS);
            const etag = info.etag ?? "";
            const cached = queryClient.getQueryData<CachedOverlay<TraderMarker[]>>([
                ...TRADERS_QUERY_KEY,
            ]);
            if (cached && etag && cached.etag === etag) {
                return { etag, expiresAt, data: cached.data };
            }
            const res = await fetch(info.url);
            if (!res.ok) {
                throw new Error(`Failed to load traders overlay (${res.status})`);
            }
            const json: unknown = await res.json();
            return { etag, expiresAt, data: parseTraders(json) };
        },
        staleTime: 0,
        meta: { persist: true },
    });
}
