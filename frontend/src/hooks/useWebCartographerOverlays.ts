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
//
// The GeoJSON feature format matches what `parseLandmarks` /
// `parseTranslocators` already accept (Z is south-positive in the file and
// gets flipped on parse), so we reuse those parsers verbatim.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorldLineSegment, WorldPointMarker } from "@/components/MapViewer";
import { API_BASE } from "@/lib/api";
import { parseLandmarks, parseTranslocators } from "./useOverlayData";

const STALE_MS = 30 * 60_000; // 30 min — WC exports are infrequent.

function normaliseBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

async function fetchGeoJson<T>(
    baseUrl: string,
    kind: "translocators" | "landmarks",
    parse: (json: unknown) => T,
): Promise<T> {
    const proxied = `${API_BASE}/webcartographer/geojson?base_url=${encodeURIComponent(baseUrl)}&kind=${kind}`;
    const res = await fetch(proxied);
    if (!res.ok) {
        // 404 is normal for hosts that haven't exported structures; treat as
        // empty rather than surfacing an error to the UI. The backend also
        // collapses upstream 404s to an empty FeatureCollection, so this
        // branch mostly catches proxy-side errors.
        if (res.status === 404) return parse({ features: [] });
        throw new Error(`WebCartographer overlay fetch failed (${res.status})`);
    }
    const json: unknown = await res.json();
    return parse(json);
}

export function useWebCartographerTranslocators(
    baseUrl: string,
    enabled: boolean,
): UseQueryResult<WorldLineSegment[]> {
    const normalised = normaliseBaseUrl(baseUrl);
    return useQuery<WorldLineSegment[]>({
        queryKey: ["overlay", "wc-translocators", normalised],
        queryFn: () => fetchGeoJson(normalised, "translocators", parseTranslocators),
        enabled: enabled && normalised.length > 0,
        staleTime: STALE_MS,
        meta: { persist: true },
    });
}

export function useWebCartographerLandmarks(
    baseUrl: string,
    enabled: boolean,
): UseQueryResult<WorldPointMarker[]> {
    const normalised = normaliseBaseUrl(baseUrl);
    return useQuery<WorldPointMarker[]>({
        queryKey: ["overlay", "wc-landmarks", normalised],
        queryFn: () => fetchGeoJson(normalised, "landmarks", parseLandmarks),
        enabled: enabled && normalised.length > 0,
        staleTime: STALE_MS,
        meta: { persist: true },
    });
}
