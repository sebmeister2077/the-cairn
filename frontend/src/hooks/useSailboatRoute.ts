// `useSailboatRoute` — drives the sailboat routing worker from the planner's
// From/To endpoints. Compute is explicit (the panel calls `compute()`) because
// each run streams tile fetches through the proxy and we don't want to fire on
// every endpoint tweak.

import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "@/lib/api";
import { computeSailboatRouteAsync } from "@/lib/sailboat/sailboat-client";
import type { SailboatRouteResult, SailboatTL } from "@/lib/sailboat/sailboat-routing";
import { WC_MAX_ZOOM } from "@/lib/tops-map-view/wc-tiles";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import type { SailboatSearchDetail } from "@/store/slices/sailboatRoute";
import {
    setSailboatComputing,
    setSailboatError,
    setSailboatProgress,
    setSailboatRoute,
    setSailboatScannedTiles,
} from "@/store/slices/sailboatRoute";

export interface UseSailboatRouteArgs {
    baseUrl: string;
    ext: "png" | "webp";
    boatTLs: SailboatTL[];
}

/** Coarser pyramid levels for the medium/low presets (1 block/px at
 *  WC_MAX_ZOOM; ×4 and ×8 blocks/px below). */
const MEDIUM_ZOOM = WC_MAX_ZOOM - 2; // 4 blocks/px
const LOW_ZOOM = WC_MAX_ZOOM - 3; // 8 blocks/px

/** Resolve the pyramid level to search at from the user's detail preference.
 *  `auto` scales with the straight-line crossing distance: short routes stay
 *  per-block exact, long open-water hops drop to a coarser level so far fewer
 *  tiles/cells are loaded. */
function resolveZoom(detail: SailboatSearchDetail, straightLineBlocks: number): number {
    switch (detail) {
        case "high":
            return WC_MAX_ZOOM;
        case "medium":
            return MEDIUM_ZOOM;
        case "low":
            return LOW_ZOOM;
        case "auto":
        default:
            if (straightLineBlocks < 1500) return WC_MAX_ZOOM;
            if (straightLineBlocks < 6000) return MEDIUM_ZOOM;
            return LOW_ZOOM;
    }
}

export function useSailboatRoute({ baseUrl, ext, boatTLs }: UseSailboatRouteArgs) {
    const dispatch = useAppDispatch();
    const from = useAppSelector((s) => s.sailboatRoute.from);
    const to = useAppSelector((s) => s.sailboatRoute.to);
    const landPenalty = useAppSelector((s) => s.sailboatRoute.landPenalty);
    const tlHopCost = useAppSelector((s) => s.sailboatRoute.tlHopCost);
    const maxTiles = useAppSelector((s) => s.sailboatRoute.maxTiles);
    const maxVisited = useAppSelector((s) => s.sailboatRoute.maxVisited);
    const searchDetail = useAppSelector((s) => s.sailboatRoute.searchDetail);
    const abortRef = useRef<AbortController | null>(null);

    const cancel = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const compute = useCallback(async () => {
        if (!from || !to) return;
        if (!baseUrl) {
            dispatch(setSailboatError("No map source available for water detection."));
            return;
        }
        cancel();
        const controller = new AbortController();
        abortRef.current = controller;
        dispatch(setSailboatComputing(true));

        const dx = from.point.x - to.point.x;
        const dz = from.point.z - to.point.z;
        const straightLine = Math.hypot(dx, dz);
        const chosenZoom = resolveZoom(searchDetail, straightLine);

        const runOnce = (zoom: number): Promise<SailboatRouteResult> =>
            computeSailboatRouteAsync({
                proxyBase: API_BASE,
                baseUrl,
                ext,
                start: { x: from.point.x, z: from.point.z },
                dest: { x: to.point.x, z: to.point.z },
                boatTLs,
                options: { landPenalty, tlHopCost, maxTiles, maxVisited, zoom },
                signal: controller.signal,
                onProgress: (p) => {
                    dispatch(
                        setSailboatProgress({
                            visited: p.visited,
                            fraction: p.fraction,
                            zoom: p.zoom,
                        }),
                    );
                    dispatch(setSailboatScannedTiles(p.tiles));
                },
            }).then((r) => r.result);

        try {
            let result = await runOnce(chosenZoom);
            // A coarse zoom can blur a canal mouth into "land" and miss a route
            // that the per-block level would find. When Auto picked a coarse
            // level and came up empty, retry once at the finest level.
            if (
                !controller.signal.aborted &&
                searchDetail === "auto" &&
                chosenZoom < WC_MAX_ZOOM &&
                !result.found
            ) {
                result = await runOnce(WC_MAX_ZOOM);
            }
            if (controller.signal.aborted) return;
            dispatch(setSailboatRoute(result));
        } catch (err) {
            if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                return;
            }
            dispatch(setSailboatError(err instanceof Error ? err.message : String(err)));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
    }, [
        from,
        to,
        baseUrl,
        ext,
        boatTLs,
        landPenalty,
        tlHopCost,
        maxTiles,
        maxVisited,
        searchDetail,
        cancel,
        dispatch,
    ]);

    // Abort any in-flight compute on unmount.
    useEffect(() => () => cancel(), [cancel]);

    return { compute, cancel };
}
