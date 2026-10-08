// Sailboat route planner Web Worker.
//
// Runs the water-mask flood-fill / Dijkstra off the main thread, loading WC
// tiles on demand through the backend proxy. Protocol: one request → progress
// ticks → one final response. Requests carry a `requestId` so the client can
// ignore stale replies (cancellation is cooperative).

import {
    findSailboatRoute,
    DEFAULT_SAILBOAT_OPTIONS,
    type SailboatPoint,
    type SailboatRouteOptions,
    type SailboatRouteResult,
    type SailboatTL,
} from "@/lib/sailboat/sailboat-routing";
import { createProxyTileSource } from "@/lib/sailboat/tile-loader";
import type { WaterColor } from "@/lib/sailboat/water-mask";

export interface SailboatWorkerRequest {
    requestId: number;
    proxyBase: string;
    baseUrl: string;
    ext: "png" | "webp";
    start: SailboatPoint;
    dest: SailboatPoint;
    boatTLs: SailboatTL[];
    options?: Partial<SailboatRouteOptions>;
    colors?: WaterColor[];
    tolerance?: number;
}

export type SailboatWorkerResponse =
    | { kind: "progress"; requestId: number; visited: number; tilesLoaded: number; tiles: string[] }
    | {
          kind: "ok";
          requestId: number;
          result: SailboatRouteResult;
          elapsedMs: number;
      }
    | { kind: "error"; requestId: number; message: string };

self.onmessage = async (ev: MessageEvent<SailboatWorkerRequest>) => {
    const req = ev.data;
    const post = (msg: SailboatWorkerResponse) => (self as unknown as Worker).postMessage(msg);
    try {
        const source = createProxyTileSource({
            proxyBase: req.proxyBase,
            baseUrl: req.baseUrl,
            ext: req.ext,
            colors: req.colors,
            tolerance: req.tolerance,
        });
        const options: SailboatRouteOptions = { ...DEFAULT_SAILBOAT_OPTIONS, ...req.options };
        const started = performance.now();
        const result = await findSailboatRoute(
            req.start,
            req.dest,
            req.boatTLs,
            source,
            options,
            (p) => post({ kind: "progress", requestId: req.requestId, visited: p.visited, tilesLoaded: p.tilesLoaded, tiles: p.tiles }),
        );
        post({ kind: "ok", requestId: req.requestId, result, elapsedMs: performance.now() - started });
    } catch (err) {
        post({
            kind: "error",
            requestId: req.requestId,
            message: err instanceof Error ? err.message : String(err),
        });
    }
};
