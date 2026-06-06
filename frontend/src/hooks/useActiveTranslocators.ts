// Returns the translocator segment set that matches whatever tile source
// the user has selected in the TOPS map view. The route planner and
// rendezvous solver both need to route against EXACTLY the same TLs the
// map is drawing — otherwise the planner picks routes through TLs that
// aren't visible (or skips ones that are), which is the kind of bug
// nobody notices until someone runs face-first into a missing portal.
//
// In WebCartographer mode we ALSO splice in any backend (user-contributed)
// TL whose `added_at` is newer than the WC export's `Last-Modified` header
// (falling back to the static `TOPS_MAP_LAST_UPDATE` constant if the
// upstream didn't supply one) — the WC export is a periodic snapshot, so
// this keeps freshly-contributed TLs visible (and routable) without
// waiting for the next regen.

import { useMemo } from "react";
import { useAppSelector } from "@/store/hooks";
import type { WorldLineSegment } from "@/components/MapViewer";
import { useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import { useWebCartographerTranslocators } from "@/hooks/useWebCartographerOverlays";
import { TOPS_MAP_LAST_UPDATE } from "@/store/slices/mapView";

export interface ActiveTranslocators {
    segments: WorldLineSegment[] | null;
    /** Stable identifier for the current segment set — used as a cache
     *  key by the routing graph builder. Includes the map source so a
     *  cairn↔WC switch always invalidates the cached graph. */
    etag: string | null;
}

export function useActiveTranslocators(): ActiveTranslocators {
    const mapSource = useAppSelector((s) => s.mapView.mapSource);
    const webCartographerUrl = useAppSelector((s) => s.mapView.webCartographerUrl);
    const usingWebCartographer = mapSource === "webcartographer";

    const backendQuery = useTranslocatorsOverlay();
    const wcQuery = useWebCartographerTranslocators(webCartographerUrl, usingWebCartographer);

    const backendSegments = backendQuery.data?.data ?? null;
    const backendEtag = backendQuery.data?.etag ?? null;
    const wcSegments = wcQuery.data?.data ?? null;
    const wcLastModified = wcQuery.data?.lastModified ?? null;

    const cutoffMs = useMemo(() => {
        // Prefer the WC export's own Last-Modified header (forwarded from
        // the upstream geojson response by our backend proxy). Fall back
        // to the hard-coded constant for the very first paint before the
        // header has been observed, or for hosts that don't supply one.
        const raw = wcLastModified ?? TOPS_MAP_LAST_UPDATE;
        const t = Date.parse(raw);
        return Number.isFinite(t) ? t : null;
    }, [wcLastModified]);

    const wcMerged = useMemo<WorldLineSegment[] | null>(() => {
        if (!usingWebCartographer) return null;
        if (!wcSegments) return null;
        // Splice in user-contributed backend TLs added after the WC
        // export's cutoff. Seed TLs (no `meta.addedAt`) are skipped —
        // they're assumed to be part of the WC snapshot already.
        const recent =
            cutoffMs == null
                ? []
                : (backendSegments ?? []).filter((seg) => {
                    const addedAt = seg.meta?.addedAt;
                    if (!addedAt) return false;
                    const t = Date.parse(addedAt);
                    return Number.isFinite(t) && t > cutoffMs;
                });
        if (recent.length === 0) return [...wcSegments];
        return [...wcSegments, ...recent];
    }, [usingWebCartographer, wcSegments, backendSegments, cutoffMs]);

    if (usingWebCartographer) {
        if (!wcMerged) return { segments: null, etag: null };
        return {
            segments: wcMerged,
            etag: `wc:${webCartographerUrl}:${wcMerged.length}:${wcLastModified ?? TOPS_MAP_LAST_UPDATE}`,
        };
    }

    if (!backendSegments) return { segments: null, etag: null };
    return {
        segments: backendSegments as WorldLineSegment[],
        etag: `cairn:${backendEtag ?? `len:${backendSegments.length}`}`,
    };
}
