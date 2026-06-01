/**
 * Thin client around the TL-routing Web Worker.
 *
 * Owns a single, lazily-instantiated worker shared by all callers. Each
 * `computeRoutesAsync()` call gets a monotonically increasing request id;
 * any pending request is implicitly cancelled when a newer one arrives
 * (we still receive the stale response — we just throw it away).
 *
 * Falls back to a rejected promise if Web Workers are unavailable; the
 * caller (`useTLRoute`) decides whether to retry on the main thread.
 */

import type {
    RouteWorkerRequest,
    RouteWorkerResponse,
} from "@/workers/tl-routing.worker";
import type {
    RendezvousObjective,
    RendezvousResult,
    RouteOptions,
    RouteResult,
    WorldPoint,
} from "@/lib/tl-routing";
import type { WorldLineSegment } from "@/components/MapViewer";

// Vite's `?worker` import returns a constructor for a module worker.
import RouteWorkerCtor from "@/workers/tl-routing.worker?worker";

let worker: Worker | null = null;
let nextRequestId = 1;

type RoutePromiseEntry = {
    kind: "route";
    resolve: (r: { routes: RouteResult[]; elapsedMs: number }) => void;
    reject: (err: Error) => void;
};
type RendezvousPromiseEntry = {
    kind: "rendezvous";
    resolve: (r: { result: RendezvousResult | null; elapsedMs: number }) => void;
    reject: (err: Error) => void;
};
type PendingEntry = RoutePromiseEntry | RendezvousPromiseEntry;

// requestId → resolver. We always settle exactly one entry per response.
const pending = new Map<number, PendingEntry>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new RouteWorkerCtor();
    worker.onmessage = (ev: MessageEvent<RouteWorkerResponse>) => {
        const msg = ev.data;
        const entry = pending.get(msg.requestId);
        if (!entry) return;
        pending.delete(msg.requestId);
        if (msg.kind === "ok" && entry.kind === "route") {
            entry.resolve({ routes: msg.routes, elapsedMs: msg.elapsedMs });
        } else if (msg.kind === "rendezvous-ok" && entry.kind === "rendezvous") {
            entry.resolve({ result: msg.result, elapsedMs: msg.elapsedMs });
        } else if (msg.kind === "error") {
            entry.reject(new Error(msg.message));
        } else {
            // Mismatched response kind — fail loudly so we notice during dev.
            entry.reject(new Error(`Unexpected response kind for request ${msg.requestId}`));
        }
    };
    worker.onerror = (ev) => {
        // Fail all outstanding requests so callers don't hang forever.
        const err = new Error(ev.message || "TL routing worker crashed");
        for (const [, entry] of pending) entry.reject(err);
        pending.clear();
        // Drop the worker so the next call rebuilds a fresh one.
        worker?.terminate();
        worker = null;
    };
    return worker;
}

export function isRouteWorkerAvailable(): boolean {
    return typeof Worker !== "undefined";
}

export interface ComputeRoutesAsyncArgs {
    segments: ReadonlyArray<WorldLineSegment>;
    /** Stable key for the segments payload (e.g. overlay etag or length+ref). */
    segmentsKey: string;
    from: WorldPoint;
    to: WorldPoint;
    opts: RouteOptions;
    /** Stable fingerprint of `opts.confirmedElkEdges` (server etag).
     *  Combined with `opts.elkFriendlyOnly` to invalidate the worker's
     *  cached graph when the elk attestations change. */
    elkSignature?: string;
    numberOfRoutes: number;
    /** Optional AbortSignal — when aborted the returned promise rejects. */
    signal?: AbortSignal;
}

export function computeRoutesAsync(
    args: ComputeRoutesAsyncArgs,
): Promise<{ routes: RouteResult[]; elapsedMs: number }> {
    if (!isRouteWorkerAvailable()) {
        return Promise.reject(new Error("Web Workers are not available"));
    }
    const w = getWorker();
    const requestId = nextRequestId++;
    const promise = new Promise<{ routes: RouteResult[]; elapsedMs: number }>(
        (resolve, reject) => {
            pending.set(requestId, { kind: "route", resolve, reject });
            if (args.signal) {
                if (args.signal.aborted) {
                    pending.delete(requestId);
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                }
                args.signal.addEventListener(
                    "abort",
                    () => {
                        if (pending.delete(requestId)) {
                            reject(new DOMException("Aborted", "AbortError"));
                        }
                    },
                    { once: true },
                );
            }
        },
    );
    const req: RouteWorkerRequest = {
        kind: "route",
        requestId,
        segmentsKey: args.segmentsKey,
        elkSignature: args.elkSignature,
        // Workers structured-clone the payload; cast away `readonly` for postMessage.
        segments: args.segments as WorldLineSegment[],
        from: args.from,
        to: args.to,
        opts: args.opts,
        numberOfRoutes: args.numberOfRoutes,
    };
    w.postMessage(req);
    return promise;
}

export interface ComputeRendezvousAsyncArgs {
    segments: ReadonlyArray<WorldLineSegment>;
    segmentsKey: string;
    players: ReadonlyArray<WorldPoint>;
    opts: RouteOptions;
    objective: RendezvousObjective;
    signal?: AbortSignal;
}

export function computeRendezvousAsync(
    args: ComputeRendezvousAsyncArgs,
): Promise<{ result: RendezvousResult | null; elapsedMs: number }> {
    if (!isRouteWorkerAvailable()) {
        return Promise.reject(new Error("Web Workers are not available"));
    }
    const w = getWorker();
    const requestId = nextRequestId++;
    const promise = new Promise<{ result: RendezvousResult | null; elapsedMs: number }>(
        (resolve, reject) => {
            pending.set(requestId, { kind: "rendezvous", resolve, reject });
            if (args.signal) {
                if (args.signal.aborted) {
                    pending.delete(requestId);
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                }
                args.signal.addEventListener(
                    "abort",
                    () => {
                        if (pending.delete(requestId)) {
                            reject(new DOMException("Aborted", "AbortError"));
                        }
                    },
                    { once: true },
                );
            }
        },
    );
    const req: RouteWorkerRequest = {
        kind: "rendezvous",
        requestId,
        segmentsKey: args.segmentsKey,
        segments: args.segments as WorldLineSegment[],
        players: args.players.map((p) => ({ x: p.x, z: p.z })),
        opts: args.opts,
        objective: args.objective,
    };
    w.postMessage(req);
    return promise;
}
