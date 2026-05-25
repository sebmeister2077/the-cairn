/**
 * TL-routing Web Worker.
 *
 * Runs `buildTLGraph` + `findRoutes` off the main thread so the UI stays
 * responsive while we compute alternates. The worker maintains its own
 * graph cache keyed on the segment payload's identity (per-message
 * `segmentsKey`) and on the cost-model knobs, mirroring the cache that
 * used to live in `useTLRoute.ts`.
 *
 * Protocol: one request → one response. Requests carry a `requestId` that
 * the client uses to ignore stale responses (cancellation is cooperative —
 * we always reply, the client throws away anything that isn't the latest).
 */

import {
    buildTLGraph,
    findRoutes,
    type RouteOptions,
    type RouteResult,
    type TLGraph,
    type WorldPoint,
} from "@/lib/tl-routing";
import type { WorldLineSegment } from "@/components/MapViewer";

export interface RouteWorkerRequest {
    requestId: number;
    /** Stable key for the segments payload — usually the overlay etag. */
    segmentsKey: string;
    segments: WorldLineSegment[];
    from: WorldPoint;
    to: WorldPoint;
    opts: RouteOptions;
    numberOfRoutes: number;
}

export type RouteWorkerResponse =
    | {
        kind: "ok";
        requestId: number;
        routes: RouteResult[];
        /** Time spent inside `findRoutes` (excluding graph build). */
        elapsedMs: number;
    }
    | { kind: "error"; requestId: number; message: string };

interface CacheEntry {
    segmentsKey: string;
    opts: RouteOptions;
    graph: TLGraph;
}
let cache: CacheEntry | null = null;

function getOrBuildGraph(
    segmentsKey: string,
    segments: WorldLineSegment[],
    opts: RouteOptions,
): TLGraph {
    if (
        cache &&
        cache.segmentsKey === segmentsKey &&
        cache.opts.walkSpeed === opts.walkSpeed &&
        cache.opts.tlPenaltySeconds === opts.tlPenaltySeconds &&
        cache.opts.kNeighbors === opts.kNeighbors
    ) {
        return cache.graph;
    }
    const graph = buildTLGraph(segments, opts);
    cache = { segmentsKey, opts, graph };
    return graph;
}

self.onmessage = (ev: MessageEvent<RouteWorkerRequest>) => {
    const req = ev.data;
    try {
        const graph = getOrBuildGraph(req.segmentsKey, req.segments, req.opts);
        const t0 = performance.now();
        const routes = findRoutes(graph, req.from, req.to, req.numberOfRoutes);
        const elapsedMs = performance.now() - t0;
        const response: RouteWorkerResponse = {
            kind: "ok",
            requestId: req.requestId,
            routes,
            elapsedMs,
        };
        (self as unknown as Worker).postMessage(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : "Routing failed";
        const response: RouteWorkerResponse = {
            kind: "error",
            requestId: req.requestId,
            message,
        };
        (self as unknown as Worker).postMessage(response);
    }
};
