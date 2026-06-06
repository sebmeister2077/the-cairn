// Fetches translocators + landmarks GeoJSON for a WebCartographer
// (https://gitlab.com/th3dilli_vintagestory/WebCartographer) host so the WC
// map source can be rendered with its own waypoints instead of our
// backend's. WC exports these files alongside the tile pyramid:
//   ${baseUrl}/data/geojson/translocators.geojson
//   ${baseUrl}/data/geojson/landmarks.geojson
//
// We can't `fetch()` them directly from the browser because WC's webserver
// doesn't send CORS headers (PNG tiles work over `<img>` which bypasses
// CORS, but JSON has to be read by JS). Instead we route through our own
// backend proxy at `/api/webcartographer/geojson` which forwards the
// request server-side and returns the JSON with our normal CORS policy.
// The proxy also forwards the upstream `Last-Modified` response header so
// callers can use the export's snapshot date as a freshness cutoff (e.g.
// when merging in user-contributed TLs added after the last regen).
//
// The GeoJSON feature format matches what `parseLandmarks` /
// `parseTranslocators` already accept (Z is south-positive in the file and
// gets flipped on parse), so we reuse those parsers verbatim.
//
// Caching: these exports are regenerated infrequently, so we keep entries
// in the persisted query cache for ~3 months and always refetch on mount.
// If the upstream `Last-Modified` hasn't advanced the payload is identical
// anyway; if it has, the cache is transparently replaced.

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { WorldLineSegment, WorldPointMarker } from "@/components/MapViewer";
import { API_BASE } from "@/lib/api";
import { parseLandmarks, parseTranslocators } from "./useOverlayData";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

/** Parsed WC overlay data plus the upstream export's `Last-Modified` header
 *  (RFC 1123, e.g. "Fri, 29 May 2026 12:44:24 GMT"), or `null` if absent. */
export interface WebCartographerOverlayPayload<T> {
    data: T;
    lastModified: string | null;
}

function normaliseBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

async function fetchGeoJson<T>(
    baseUrl: string,
    kind: "translocators" | "landmarks",
    parse: (json: unknown) => T,
): Promise<WebCartographerOverlayPayload<T>> {
    const proxied = `${API_BASE}/webcartographer/geojson?base_url=${encodeURIComponent(baseUrl)}&kind=${kind}`;
    const res = await fetch(proxied);
    if (!res.ok) {
        // 404 is normal for hosts that haven't exported structures; treat as
        // empty rather than surfacing an error to the UI. The backend also
        // collapses upstream 404s to an empty FeatureCollection, so this
        // branch mostly catches proxy-side errors.
        if (res.status === 404) return { data: parse({ features: [] }), lastModified: null };
        throw new Error(`WebCartographer overlay fetch failed (${res.status})`);
    }
    const json: unknown = await res.json();
    return { data: parse(json), lastModified: res.headers.get("Last-Modified") };
}

export function useWebCartographerTranslocators(
    baseUrl: string,
    enabled: boolean,
): UseQueryResult<WebCartographerOverlayPayload<WorldLineSegment[]>> {
    const normalised = normaliseBaseUrl(baseUrl);
    const queryClient = useQueryClient();
    const queryKey = ["overlay", "wc-translocators", normalised];
    return useQuery<WebCartographerOverlayPayload<WorldLineSegment[]>>({
        queryKey,
        queryFn: async () => {
            const previous = queryClient.getQueryData<
                WebCartographerOverlayPayload<WorldLineSegment[]>
            >(queryKey);
            const next = await fetchGeoJson(normalised, "translocators", parseTranslocators);
            // Prefer the cached Last-Modified if the upstream omitted one
            // on this refetch, so the cutoff stays stable across visits.
            if (!next.lastModified && previous?.lastModified) {
                return { ...next, lastModified: previous.lastModified };
            }
            return next;
        },
        enabled: enabled && normalised.length > 0,
        staleTime: 0,
        gcTime: THREE_MONTHS_MS,
        refetchOnMount: "always",
        meta: { persist: true },
    });
}

export function useWebCartographerLandmarks(
    baseUrl: string,
    enabled: boolean,
): UseQueryResult<WebCartographerOverlayPayload<WorldPointMarker[]>> {
    const normalised = normaliseBaseUrl(baseUrl);
    const queryClient = useQueryClient();
    const queryKey = ["overlay", "wc-landmarks", normalised];
    return useQuery<WebCartographerOverlayPayload<WorldPointMarker[]>>({
        queryKey,
        queryFn: async () => {
            const previous = queryClient.getQueryData<
                WebCartographerOverlayPayload<WorldPointMarker[]>
            >(queryKey);
            const next = await fetchGeoJson(normalised, "landmarks", parseLandmarks);
            if (!next.lastModified && previous?.lastModified) {
                return { ...next, lastModified: previous.lastModified };
            }
            return next;
        },
        enabled: enabled && normalised.length > 0,
        staleTime: 0,
        gcTime: THREE_MONTHS_MS,
        refetchOnMount: "always",
        meta: { persist: true },
    });
}
