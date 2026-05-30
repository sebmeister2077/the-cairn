// Returns the translocator segment set that matches whatever tile source
// the user has selected in the TOPS map view. The route planner and
// rendezvous solver both need to route against EXACTLY the same TLs the
// map is drawing — otherwise the planner picks routes through TLs that
// aren't visible (or skips ones that are), which is the kind of bug
// nobody notices until someone runs face-first into a missing portal.

import { useAppSelector } from "@/store/hooks";
import type { WorldLineSegment } from "@/components/MapViewer";
import { useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import { useWebCartographerTranslocators } from "@/hooks/useWebCartographerOverlays";

export interface ActiveTranslocators {
    segments: ReadonlyArray<WorldLineSegment> | null;
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

    if (usingWebCartographer) {
        const segments = wcQuery.data ?? null;
        return {
            segments,
            etag: segments ? `wc:${webCartographerUrl}:${segments.length}` : null,
        };
    }

    const segments = backendQuery.data?.data ?? null;
    const backendEtag = backendQuery.data?.etag ?? null;
    return {
        segments,
        etag: segments ? `cairn:${backendEtag ?? `len:${segments.length}`}` : null,
    };
}
