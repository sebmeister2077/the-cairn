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
    findRendezvous,
    findRoutes,
    type RendezvousObjective,
    type RendezvousResult,
    type RouteOptions,
    type RouteResult,
    type TLGraph,
    type WorldPoint,
} from "@/lib/tl-routing";
import type { WorldLineSegment } from "@/components/MapViewer";

export interface RouteWorkerRouteRequest {
    kind: "route";
    requestId: number;
    /** Stable key for the segments payload — usually the overlay etag. */
    segmentsKey: string;
    segments: WorldLineSegment[];
    from: WorldPoint;
    to: WorldPoint;
    opts: RouteOptions;
    numberOfRoutes: number;
}

export interface RouteWorkerRendezvousRequest {
    kind: "rendezvous";
    requestId: number;
    segmentsKey: string;
    segments: WorldLineSegment[];
    players: WorldPoint[];
    opts: RouteOptions;
    objective: RendezvousObjective;
}

export type RouteWorkerRequest = RouteWorkerRouteRequest | RouteWorkerRendezvousRequest;

export type RouteWorkerResponse =
    | {
        kind: "ok";
        requestId: number;
        routes: RouteResult[];
        /** Time spent inside `findRoutes` (excluding graph build). */
        elapsedMs: number;
    }
    | {
        kind: "rendezvous-ok";
        requestId: number;
        result: RendezvousResult | null;
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
        if (req.kind === "rendezvous") {
            const result = findRendezvous(graph, req.players, req.objective);
            const elapsedMs = performance.now() - t0;
            const response: RouteWorkerResponse = {
                kind: "rendezvous-ok",
                requestId: req.requestId,
                result,
                elapsedMs,
            };
            (self as unknown as Worker).postMessage(response);
        } else {
            const routes = findRoutes(graph, req.from, req.to, req.numberOfRoutes);
            const elapsedMs = performance.now() - t0;
            const response: RouteWorkerResponse = {
                kind: "ok",
                requestId: req.requestId,
                routes,
                elapsedMs,
            };
            (self as unknown as Worker).postMessage(response);
        }
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
