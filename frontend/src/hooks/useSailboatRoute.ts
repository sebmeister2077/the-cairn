// `useSailboatRoute` — drives the sailboat routing worker from the planner's
// From/To endpoints. Compute is explicit (the panel calls `compute()`) because
// each run streams tile fetches through the proxy and we don't want to fire on
// every endpoint tweak.

import { useCallback, useEffect, useRef } from "react";
import { API_BASE, routeAnalytics, type SavedRouteLeg } from "@/lib/api";
import { computeSailboatRouteAsync } from "@/lib/sailboat/sailboat-client";
import {
    DEFAULT_SAILBOAT_OPTIONS,
    type SailboatRouteResult,
    type SailboatTL,
    type SailboatWaypoint,
} from "@/lib/sailboat/sailboat-routing";
import { WC_MAX_ZOOM } from "@/lib/tops-map-view/wc-tiles";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import type { EndpointPick } from "@/store/slices/routePlanner";
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

/**
 * Sailboats have no physical time model (cost is distance- and penalty-based),
 * but the shared route-analytics `/plan` schema needs a positive duration and
 * per-leg seconds. Synthesize a plausible time from distance using a rough
 * open-sail cruising speed so the stored totals are sane without pretending to
 * be exact. Only the geometry (blocks / TL hops) is authoritative for sailboat.
 */
const SAILBOAT_BLOCKS_PER_SECOND = 8;
const SAILBOAT_TL_HOP_SECONDS = 2;

const roundPoint = (p: SailboatWaypoint | EndpointPick["point"]) => ({
    x: Math.round(p.x),
    z: Math.round(p.z),
});

/**
 * Collapse the per-pixel sailboat waypoint chain into a compact leg list for
 * analytics: consecutive water/terrain hops fold into a single "walk" leg,
 * split only at boat-TL hops (which become "tl" legs). This keeps the leg
 * count tiny and stable (≈ 2·tlHops + 1) regardless of path length, matching
 * the walk/tl leg shape the `/route-analytics/plan` endpoint expects.
 */
function buildSailboatLegs(waypoints: SailboatWaypoint[]): SavedRouteLeg[] {
    const legs: SavedRouteLeg[] = [];
    if (waypoints.length < 2) return legs;

    let spanStart = waypoints[0];
    let spanBlocks = 0;
    let prev = waypoints[0];

    const pushWalk = (to: SailboatWaypoint) => {
        legs.push({
            kind: "walk",
            from: roundPoint(spanStart),
            to: roundPoint(to),
            seconds: Math.round(spanBlocks / SAILBOAT_BLOCKS_PER_SECOND),
            blocks: Math.round(spanBlocks),
        });
    };

    for (let i = 1; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (wp.tl) {
            if (spanBlocks > 0) pushWalk(prev);
            legs.push({
                kind: "tl",
                from: roundPoint(prev),
                to: roundPoint(wp),
                seconds: SAILBOAT_TL_HOP_SECONDS,
            });
            spanStart = wp;
            spanBlocks = 0;
        } else {
            spanBlocks += Math.hypot(wp.x - prev.x, wp.z - prev.z);
        }
        prev = wp;
    }
    if (spanBlocks > 0 || legs.length === 0) pushWalk(prev);
    return legs;
}

/** Fire a best-effort "sailboat" plan analytics event for a found route. The
 *  explicit compute button means one event per successful computation; the
 *  backend's 24h soft-dedup collapses repeats of the same route. */
function reportSailboatPlan(params: {
    from: EndpointPick;
    to: EndpointPick;
    landPenalty: number;
    tlHopCost: number;
    searchDetail: SailboatSearchDetail;
    result: SailboatRouteResult;
}) {
    const { from, to, landPenalty, tlHopCost, searchDetail, result } = params;
    if (!result.found) return;

    const walkBlocks = result.waterBlocks + result.terrainBlocks;
    const totalSeconds = Math.max(
        1,
        Math.round(walkBlocks / SAILBOAT_BLOCKS_PER_SECOND) +
            result.tlHops * SAILBOAT_TL_HOP_SECONDS,
    );
    const legs = buildSailboatLegs(result.waypoints);
    if (legs.length === 0) return;

    const settings: Record<string, number | string> = {};
    if (landPenalty !== DEFAULT_SAILBOAT_OPTIONS.landPenalty)
        settings.land_penalty = landPenalty;
    if (tlHopCost !== DEFAULT_SAILBOAT_OPTIONS.tlHopCost)
        settings.tl_hop_cost = tlHopCost;
    if (searchDetail !== "auto") settings.search_detail = searchDetail;

    routeAnalytics
        .plan({
            mode: "sailboat",
            from: roundPoint(from.point),
            to: roundPoint(to.point),
            from_label: from.label ?? null,
            to_label: to.label ?? null,
            from_source: from.source ?? null,
            to_source: to.source ?? null,
            legs,
            total_seconds: totalSeconds,
            walk_blocks: Math.round(walkBlocks),
            tl_hops: result.tlHops,
            settings,
        })
        .catch(() => {
            /* analytics are best-effort */
        });
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
            if (result.found) {
                reportSailboatPlan({
                    from,
                    to,
                    landPenalty,
                    tlHopCost,
                    searchDetail,
                    result,
                });
            }
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
