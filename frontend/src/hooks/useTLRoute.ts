// `useTLRoute` — compute routes from the planner's From/To against the
// loaded translocator overlay, with debounced recomputation.
//
// Compute is offloaded to a Web Worker (`tl-routing.worker.ts`) so the
// main thread stays responsive while Yen's / A* run on large graphs. A
// main-thread fallback exists below for emergencies but is gated behind
// `USE_MAIN_THREAD_FALLBACK` (currently disabled) — flip it to `true`
// if the worker path ever proves unstable.

import { useEffect, useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { useActiveTranslocators } from "@/hooks/useActiveTranslocators";
import {
    buildTLGraph,
    findRoutes,
    type RouteOptions,
    type RouteResult,
    type TLGraph,
} from "@/lib/tl-routing";
import { computeRoutesAsync, isRouteWorkerAvailable } from "@/lib/tl-routing-client";
import type { WorldLineSegment } from "@/components/MapViewer";
import {
    setRouteComputing,
    setRoutePlannerError,
    setRoutePlannerRoutes,
} from "@/store/slices/routePlanner";

/**
 * Emergency escape hatch. When `true`, routing runs on the main thread
 * via the legacy code path below. Leave `false` in production — the
 * worker path keeps the UI responsive while Yen's runs.
 */
const USE_MAIN_THREAD_FALLBACK = false;

interface GraphCacheEntry {
    segments: ReadonlyArray<WorldLineSegment>;
    opts: RouteOptions;
    /** Identity fingerprint of `opts.confirmedElkEdges` — the server etag
     *  if available, otherwise the empty string. Without this, switching
     *  elk-friendly on/off or refreshing the elk file would silently hit
     *  the stale cached graph. */
    elkSignature: string;
    graph: TLGraph;
}
let graphCache: GraphCacheEntry | null = null;

function getOrBuildGraph(
    segments: ReadonlyArray<WorldLineSegment>,
    opts: RouteOptions,
    elkSignature: string,
): TLGraph {
    if (
        graphCache &&
        graphCache.segments === segments &&
        graphCache.opts.walkSpeed === opts.walkSpeed &&
        graphCache.opts.tlPenaltySeconds === opts.tlPenaltySeconds &&
        graphCache.opts.kNeighbors === opts.kNeighbors &&
        graphCache.opts.elkFriendlyOnly === opts.elkFriendlyOnly &&
        graphCache.elkSignature === elkSignature
    ) {
        return graphCache.graph;
    }
    const graph = buildTLGraph(segments, opts);
    graphCache = { segments, opts, elkSignature, graph };
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
    const elkFriendlyOnly = useAppSelector((s) => s.routePlanner.elkFriendlyOnly);
    const elkEdges = useAppSelector((s) => s.elkWalkable.edges);
    const elkEtag = useAppSelector((s) => s.elkWalkable.etag);
    const routes = useAppSelector((s) => s.routePlanner.routes);
    const selectedIndex = useAppSelector((s) => s.routePlanner.selectedIndex);
    const isComputing = useAppSelector((s) => s.routePlanner.isComputing);
    const error = useAppSelector((s) => s.routePlanner.error);

    // Pull the segment set that matches the user's selected tile source
    // (cairn vs WebCartographer) so the planner routes through exactly
    // the TLs the map is drawing.
    const { segments, etag: segmentsEtag } = useActiveTranslocators();

    // Materialise the elk edge set as a Set<string> for O(1) lookup
    // inside the graph builder. Only re-derive when the underlying
    // edge map changes; gate it on `elkFriendlyOnly` so paying users
    // who don't care about the feature don't pay the allocation cost.
    const confirmedElkEdges = useMemo<ReadonlySet<string> | undefined>(() => {
        if (Object.keys(elkEdges).length === 0) return undefined;
        return new Set(Object.keys(elkEdges));
    }, [elkEdges]);

    const opts = useMemo<RouteOptions>(
        () => ({
            walkSpeed,
            tlPenaltySeconds,
            kNeighbors,
            elkFriendlyOnly,
            confirmedElkEdges,
        }),
        [walkSpeed, tlPenaltySeconds, kNeighbors, elkFriendlyOnly, confirmedElkEdges],
    );

    // Debounced compute. We carry both a setTimeout handle (for the
    // debounce) and an AbortController (so a stale in-flight worker
    // request gets its promise rejected when a newer one arrives).
    const pendingTimer = useRef<number | null>(null);
    const pendingAbort = useRef<AbortController | null>(null);
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
        if (pendingAbort.current) {
            pendingAbort.current.abort();
            pendingAbort.current = null;
        }
        if (!from || !to || !segments) return;

        dispatch(setRouteComputing(true));

        // Worker path (default). Falls back to the main-thread runner if
        // either the escape-hatch flag is set or the browser lacks
        // Worker support.
        const useWorker = !USE_MAIN_THREAD_FALLBACK && isRouteWorkerAvailable();
        const capturedFrom = from;
        const capturedTo = to;
        const capturedSegments = segments;

        pendingTimer.current = window.setTimeout(() => {
            if (useWorker) {
                const ctrl = new AbortController();
                pendingAbort.current = ctrl;
                computeRoutesAsync({
                    segments: capturedSegments,
                    segmentsKey: segmentsEtag ?? `len:${capturedSegments.length}`,
                    from: capturedFrom.point,
                    to: capturedTo.point,
                    opts,
                    elkSignature: elkEtag,
                    numberOfRoutes: NUMBER_OF_ROUTES,
                    signal: ctrl.signal,
                })
                    .then(({ routes: result, elapsedMs }) => {
                        if (ctrl.signal.aborted) return;
                        if (import.meta.env.DEV) {
                            // eslint-disable-next-line no-console
                            console.debug(
                                `[useTLRoute] (worker) computed ${result.length} route(s) in ${elapsedMs.toFixed(
                                    1,
                                )}ms (segments=${capturedSegments.length})`,
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
                    })
                    .catch((err: unknown) => {
                        if (ctrl.signal.aborted) return;
                        if (err instanceof DOMException && err.name === "AbortError") return;
                        const message = err instanceof Error ? err.message : "Routing failed";
                        dispatch(setRoutePlannerError(message));
                    });
            } else {
                runOnMainThread(capturedSegments, capturedFrom.point, capturedTo.point);
            }
        }, DEBOUNCE_MS);

        // Legacy main-thread path. Identical to the original
        // implementation — kept reachable so flipping
        // `USE_MAIN_THREAD_FALLBACK` is a one-line emergency switch.
        function runOnMainThread(
            segs: ReadonlyArray<WorldLineSegment>,
            fromPt: { x: number; z: number },
            toPt: { x: number; z: number },
        ) {
            const run = () => {
                try {
                    const graph = getOrBuildGraph(segs, opts, elkEtag);
                    const t0 = performance.now();
                    const result = findRoutes(graph, fromPt, toPt, NUMBER_OF_ROUTES);
                    const elapsed = performance.now() - t0;
                    if (import.meta.env.DEV) {
                        // eslint-disable-next-line no-console
                        console.debug(
                            `[useTLRoute] (main) computed ${result.length} route(s) in ${elapsed.toFixed(
                                1,
                            )}ms (segments=${segs.length})`,
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
        }

        return () => {
            if (pendingTimer.current != null) {
                window.clearTimeout(pendingTimer.current);
                pendingTimer.current = null;
            }
            if (pendingAbort.current) {
                pendingAbort.current.abort();
                pendingAbort.current = null;
            }
        };
    }, [dispatch, from, to, segments, segmentsEtag, opts, elkEtag]);

    return { routes, selectedIndex, isComputing, error };
}
