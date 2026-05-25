// `useTLRoute` — compute routes from the planner's From/To against the
// loaded translocator overlay, with debounced recomputation and a memoised
// graph keyed on (segments reference, cost options).
//
// The graph itself is shared module-level so multiple consumers and route
// re-queries reuse the same KD-tree / adjacency lists. We bust the cache
// whenever the underlying segments reference changes (etag-refreshed
// overlay) or any cost-model knob changes (walk speed, TL penalty, K).

import { useEffect, useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import {
    buildTLGraph,
    findRoutes,
    type RouteOptions,
    type RouteResult,
    type TLGraph,
} from "@/lib/tl-routing";
import type { WorldLineSegment } from "@/components/MapViewer";
import {
    setRouteComputing,
    setRoutePlannerError,
    setRoutePlannerRoutes,
} from "@/store/slices/routePlanner";

interface GraphCacheEntry {
    segments: ReadonlyArray<WorldLineSegment>;
    opts: RouteOptions;
    graph: TLGraph;
}
let graphCache: GraphCacheEntry | null = null;

function getOrBuildGraph(
    segments: ReadonlyArray<WorldLineSegment>,
    opts: RouteOptions,
): TLGraph {
    if (
        graphCache &&
        graphCache.segments === segments &&
        graphCache.opts.walkSpeed === opts.walkSpeed &&
        graphCache.opts.tlPenaltySeconds === opts.tlPenaltySeconds &&
        graphCache.opts.kNeighbors === opts.kNeighbors
    ) {
        return graphCache.graph;
    }
    const graph = buildTLGraph(segments, opts);
    graphCache = { segments, opts, graph };
    return graph;
}

const NUMBER_OF_ROUTES = 3;
const DEBOUNCE_MS = 150;

interface UseTLRouteResult {
    routes: RouteResult[];
    selectedIndex: number;
    isComputing: boolean;
    error: string | null;
}

export function useTLRoute(): UseTLRouteResult {
    const dispatch = useAppDispatch();
    const from = useAppSelector((s) => s.routePlanner.from);
    const to = useAppSelector((s) => s.routePlanner.to);
    const walkSpeed = useAppSelector((s) => s.routePlanner.walkSpeed);
    const tlPenaltySeconds = useAppSelector((s) => s.routePlanner.tlPenaltySeconds);
    const kNeighbors = useAppSelector((s) => s.routePlanner.kNeighbors);
    const routes = useAppSelector((s) => s.routePlanner.routes);
    const selectedIndex = useAppSelector((s) => s.routePlanner.selectedIndex);
    const isComputing = useAppSelector((s) => s.routePlanner.isComputing);
    const error = useAppSelector((s) => s.routePlanner.error);

    const translocatorsQuery = useTranslocatorsOverlay();
    const segments = translocatorsQuery.data?.data ?? null;

    const opts = useMemo<RouteOptions>(
        () => ({ walkSpeed, tlPenaltySeconds, kNeighbors }),
        [walkSpeed, tlPenaltySeconds, kNeighbors],
    );

    // Debounced + idle-scheduled compute.
    const pendingTimer = useRef<number | null>(null);
    const pendingIdle = useRef<number | null>(null);

    useEffect(() => {
        if (pendingTimer.current != null) {
            window.clearTimeout(pendingTimer.current);
            pendingTimer.current = null;
        }
        if (pendingIdle.current != null && "cancelIdleCallback" in window) {
            (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(
                pendingIdle.current,
            );
            pendingIdle.current = null;
        }
        if (!from || !to || !segments) return;

        dispatch(setRouteComputing(true));
        pendingTimer.current = window.setTimeout(() => {
            const run = () => {
                try {
                    const graph = getOrBuildGraph(segments, opts);
                    const t0 = performance.now();
                    const result = findRoutes(graph, from.point, to.point, NUMBER_OF_ROUTES);
                    const elapsed = performance.now() - t0;
                    if (import.meta.env.DEV) {
                        // eslint-disable-next-line no-console
                        console.debug(
                            `[useTLRoute] computed ${result.length} route(s) in ${elapsed.toFixed(
                                1,
                            )}ms (segments=${segments.length})`,
                        );
                        (window as unknown as { __lastRouteResult?: unknown }).__lastRouteResult =
                            result;
                    }
                    if (result.length === 0) {
                        dispatch(
                            setRoutePlannerError(
                                "No route found. Try widening neighbour count or moving an endpoint.",
                            ),
                        );
                        dispatch(setRoutePlannerRoutes([]));
                    } else {
                        dispatch(setRoutePlannerRoutes(result));
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Routing failed";
                    dispatch(setRoutePlannerError(message));
                }
            };
            if ("requestIdleCallback" in window) {
                pendingIdle.current = (
                    window as unknown as {
                        requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
                    }
                ).requestIdleCallback(run, { timeout: 500 });
            } else {
                run();
            }
        }, DEBOUNCE_MS);

        return () => {
            if (pendingTimer.current != null) {
                window.clearTimeout(pendingTimer.current);
                pendingTimer.current = null;
            }
        };
    }, [dispatch, from, to, segments, opts]);

    return { routes, selectedIndex, isComputing, error };
}
