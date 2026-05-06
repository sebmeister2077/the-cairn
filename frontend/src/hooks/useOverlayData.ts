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
import { getLandmarksUrl, getTranslocatorsUrl, type MarkerFileUrlResponse } from "@/lib/api";
import type {
    LandmarkProperty,
    WorldLineSegment,
    WorldPointMarker,
} from "@/components/MapViewer";

export interface CachedOverlay<T> {
    etag: string;
    /** Epoch ms after which we should re-call the URL endpoint. */
    expiresAt: number;
    data: T;
}

export const LANDMARKS_QUERY_KEY = ["overlay", "landmarks"] as const;
export const TRANSLOCATORS_QUERY_KEY = ["overlay", "translocators"] as const;

// Refresh ~1 minute before the server says the URL expires so the in-flight
// fetch can't race the deadline.
const EXPIRY_GUARD_MS = 60_000;

function parseLandmarks(json: unknown): WorldPointMarker[] {
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

        const props = (f?.properties ?? {}) as LandmarkProperty;
        if (props.type === "Misc") continue;

        points.push({
            x,
            // Server stores +Z = south; the viewer uses +Z = north, so flip.
            z: -z,
            label: typeof props.label === "string" ? props.label : undefined,
            kind: typeof props.type === "string" ? props.type : undefined,
        });
    }

    return points;
}

function parseTranslocators(json: unknown): WorldLineSegment[] {
    const features = Array.isArray((json as { features?: unknown })?.features)
        ? ((json as { features: unknown[] }).features)
        : [];
    const segments: WorldLineSegment[] = [];

    for (const feature of features) {
        const f = feature as { geometry?: { type?: string; coordinates?: unknown } };
        const geometry = f?.geometry;
        if (!geometry || geometry.type !== "LineString") continue;
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
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
                segments.push({ x1, z1, x2, z2 });
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
