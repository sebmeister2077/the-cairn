// Thin client around the sailboat routing worker. Mirrors
// `tl-routing-client.ts`: one in-flight-friendly worker, requestId-keyed
// settling, progress fan-out, and crash recovery.

import SailboatWorkerCtor from "@/workers/sailboat-routing.worker?worker";
import type {
    SailboatWorkerRequest,
    SailboatWorkerResponse,
} from "@/workers/sailboat-routing.worker";
import type {
    SailboatPoint,
    SailboatRouteOptions,
    SailboatRouteResult,
    SailboatTL,
} from "@/lib/sailboat/sailboat-routing";
import type { WaterColor } from "@/lib/sailboat/water-mask";

let worker: Worker | null = null;
let nextRequestId = 1;

interface PendingEntry {
    resolve: (r: { result: SailboatRouteResult; elapsedMs: number }) => void;
    reject: (err: Error) => void;
    onProgress?: (p: { visited: number; tilesLoaded: number; tiles: string[]; fraction: number; zoom: number }) => void;
}

const pending = new Map<number, PendingEntry>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new SailboatWorkerCtor();
    worker.onmessage = (ev: MessageEvent<SailboatWorkerResponse>) => {
        const msg = ev.data;
        const entry = pending.get(msg.requestId);
        if (!entry) return;
        if (msg.kind === "progress") {
            entry.onProgress?.({ visited: msg.visited, tilesLoaded: msg.tilesLoaded, tiles: msg.tiles, fraction: msg.fraction, zoom: msg.zoom });
            return;
        }
        pending.delete(msg.requestId);
        if (msg.kind === "ok") {
            entry.resolve({ result: msg.result, elapsedMs: msg.elapsedMs });
        } else {
            entry.reject(new Error(msg.message));
        }
    };
    worker.onerror = (ev) => {
        const err = new Error(ev.message || "Sailboat routing worker crashed");
        for (const [, entry] of pending) entry.reject(err);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

export function isSailboatWorkerAvailable(): boolean {
    return typeof Worker !== "undefined";
}

export interface ComputeSailboatRouteArgs {
    proxyBase: string;
    baseUrl: string;
    ext: "png" | "webp";
    start: SailboatPoint;
    dest: SailboatPoint;
    boatTLs: SailboatTL[];
    options?: Partial<SailboatRouteOptions>;
    colors?: WaterColor[];
    tolerance?: number;
    signal?: AbortSignal;
    onProgress?: (p: { visited: number; tilesLoaded: number; tiles: string[]; fraction: number; zoom: number }) => void;
}

export function computeSailboatRouteAsync(
    args: ComputeSailboatRouteArgs,
): Promise<{ result: SailboatRouteResult; elapsedMs: number }> {
    if (!isSailboatWorkerAvailable()) {
        return Promise.reject(new Error("Web Workers are not available"));
    }
    const w = getWorker();
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
        if (args.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        pending.set(requestId, { resolve, reject, onProgress: args.onProgress });
        args.signal?.addEventListener(
            "abort",
            () => {
                if (pending.has(requestId)) {
                    pending.delete(requestId);
                    reject(new DOMException("Aborted", "AbortError"));
                }
            },
            { once: true },
        );
        const req: SailboatWorkerRequest = {
            requestId,
            proxyBase: args.proxyBase,
            baseUrl: args.baseUrl,
            ext: args.ext,
            start: args.start,
            dest: args.dest,
            boatTLs: args.boatTLs,
            options: args.options,
            colors: args.colors,
            tolerance: args.tolerance,
        };
        w.postMessage(req);
    });
}
