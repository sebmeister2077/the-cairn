// Sailboat route planner — core pathfinding.
//
// Finds a water route between two world points by running Dijkstra over the
// per-block water mask at the finest pyramid level, loading tiles on demand as
// the frontier expands (start chunk → neighbours → water check → expand).
// Boat-friendly translocators act as portals that connect otherwise-disjoint
// water bodies.
//
// The engine is pure: it takes an injected async `loadTileMask(cx, cy)` so it
// can be unit-tested with synthetic tiles and reused from a Web Worker with a
// real proxy-fetch loader.

import {
    globalPixelToWorld,
    worldToGlobalPixel,
} from "./tile-coords";
import { WC_TILE_SIZE_PX } from "@/lib/tops-map-view/wc-tiles";

export interface SailboatPoint {
    x: number;
    z: number;
}

/** A boat-friendly translocator: both endpoints in world coords + its id. */
export interface SailboatTL {
    id: string;
    a: SailboatPoint;
    b: SailboatPoint;
}

export interface SailboatRouteOptions {
    /** Max distinct tiles the search may load before giving up. Bounds both
     *  memory and runtime for short/medium routes. */
    maxTiles: number;
    /** Max settled pixels before giving up. */
    maxVisited: number;
    /** Cost multiplier for traversing a non-water (terrain) block. Water is
     *  the baseline (×1); terrain is far more expensive so the planner only
     *  crosses land for short gaps — narrow isthmuses, tunnels, bridged
     *  canals — while still preferring an all-water path when one exists. */
    landPenalty: number;
    /** Extra cost (in block-equivalents) added for taking a boat TL hop. */
    tlHopCost: number;
}

export const DEFAULT_SAILBOAT_OPTIONS: SailboatRouteOptions = {
    maxTiles: 400,
    maxVisited: 3_000_000,
    landPenalty: 10,
    tlHopCost: 20,
};

export interface SailboatWaypoint {
    x: number;
    z: number;
    /** True when this waypoint is the exit of a boat-TL hop (the segment
     *  arriving here is a translocator jump, drawn as a TL link). */
    tl?: boolean;
    /** True when the segment arriving at this waypoint crosses terrain
     *  (non-water) — drawn as a dotted line to show a land/tunnel crossing. */
    terrain?: boolean;
}

export type SailboatRouteFailure =
    | "no_data_at_start"
    | "no_data_at_dest"
    | "unreachable"
    | "search_exhausted";

export interface SailboatRouteResult {
    found: boolean;
    reason?: SailboatRouteFailure;
    waypoints: SailboatWaypoint[];
    /** Sum of water-leg distances in blocks (excludes TL hops + terrain). */
    waterBlocks: number;
    /** Sum of terrain (land/tunnel) crossing distances in blocks. */
    terrainBlocks: number;
    /** Number of boat-TL hops used. */
    tlHops: number;
    /** Distinct tiles the search loaded (telemetry / debugging). */
    tilesLoaded: number;
}

/** Loader: resolve a tile's water mask (Uint8, len WC_TILE_SIZE_PX²), or null
 *  when the tile is missing from the sparse pyramid (404). A tile that exists
 *  but contains no water resolves to an all-zero mask (traversable terrain),
 *  NOT null — null means "no data / impassable". */
export type LoadTileMask = (cx: number, cy: number) => Promise<Uint8Array | null>;

/** A tile's pyramid coordinate (finest level). */
export interface TileCoord {
    cx: number;
    cy: number;
}

/** Bulk tile source. The engine prefetches a square block of tiles around each
 *  search frontier and resolves them in one call so many HTTP round-trips can
 *  collapse into a single batched request. The returned array is parallel to
 *  `coords`; each entry is that tile's water mask, or null for a missing /
 *  no-data tile. */
export interface TileSource {
    loadBatch(coords: ReadonlyArray<TileCoord>): Promise<Array<Uint8Array | null>>;
}

export interface SailboatProgress {
    visited: number;
    tilesLoaded: number;
    /** Keys (`"cx_cy"`, finest level) of every tile the search has loaded so
     *  far — used by the admin debug overlay to highlight scanned chunks. */
    tiles: string[];
}

const TILE = WC_TILE_SIZE_PX; // 256
// Global-pixel key packing. gz is < ~1.03e6, so gz*STRIDE + gx stays within
// Number.MAX_SAFE_INTEGER.
const STRIDE = 2_000_000;

function keyOf(gx: number, gz: number): number {
    return gz * STRIDE + gx;
}
function gxOf(key: number): number {
    return key % STRIDE;
}
function gzOf(key: number): number {
    return Math.floor(key / STRIDE);
}

// ── Minimal binary min-heap keyed by numeric cost ───────────────────────────
class MinHeap {
    private cost: number[] = [];
    private node: number[] = [];

    get size(): number {
        return this.cost.length;
    }

    /** Minimum cost on the heap, or Infinity when empty. */
    topCost(): number {
        return this.cost.length > 0 ? this.cost[0] : Infinity;
    }

    push(cost: number, node: number): void {
        const c = this.cost;
        const n = this.node;
        c.push(cost);
        n.push(node);
        let i = c.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (c[parent] <= c[i]) break;
            const tc = c[parent];
            c[parent] = c[i];
            c[i] = tc;
            const tn = n[parent];
            n[parent] = n[i];
            n[i] = tn;
            i = parent;
        }
    }

    pop(): { cost: number; node: number } | undefined {
        const c = this.cost;
        const n = this.node;
        if (c.length === 0) return undefined;
        const top = { cost: c[0], node: n[0] };
        const lastC = c.pop()!;
        const lastN = n.pop()!;
        if (c.length > 0) {
            c[0] = lastC;
            n[0] = lastN;
            let i = 0;
            const len = c.length;
            for (; ;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let smallest = i;
                if (l < len && c[l] < c[smallest]) smallest = l;
                if (r < len && c[r] < c[smallest]) smallest = r;
                if (smallest === i) break;
                const tc = c[smallest];
                c[smallest] = c[i];
                c[i] = tc;
                const tn = n[smallest];
                n[smallest] = n[i];
                n[i] = tn;
                i = smallest;
            }
        }
        return top;
    }
}

const SQRT2 = Math.SQRT2;
// 8-connected neighbour offsets + step cost.
const NEIGHBORS: Array<[number, number, number]> = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, SQRT2],
    [1, -1, SQRT2],
    [-1, 1, SQRT2],
    [-1, -1, SQRT2],
];

/** Octile distance — the exact minimum cost of an 8-connected unit-grid path
 *  (diagonal = √2). Used as the A* heuristic's all-water lower bound. */
function octile(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return dx < dz ? SQRT2 * dx + (dz - dx) : SQRT2 * dz + (dx - dz);
}

/**
 * Compute a sailboat route. Prefers water, but will cross terrain (land /
 * tunnels / bridged canals) at a penalty so a route is still found when the
 * water isn't perfectly continuous. Terrain crossings are flagged on the
 * returned waypoints so the UI can draw them as a dotted line. Resolves even
 * on failure (with `found: false` + a reason) so callers can show a precise
 * message.
 */
export async function findSailboatRoute(
    start: SailboatPoint,
    dest: SailboatPoint,
    boatTLs: SailboatTL[],
    source: TileSource,
    options: SailboatRouteOptions = DEFAULT_SAILBOAT_OPTIONS,
    onProgress?: (p: SailboatProgress) => void,
): Promise<SailboatRouteResult> {
    const tiles = new Map<string, Uint8Array | null>();
    const requested = new Set<string>();
    const ensuredCenter = new Set<number>();

    // Prefetch a (2·PREFETCH_RADIUS+1)² block of tiles around each frontier
    // tile in ONE batched request. Radius ≥ 1 guarantees every 8-neighbour of
    // any pixel in the centre tile is resolvable; a larger radius trades a
    // little over-fetch for far fewer HTTP round-trips (bulk loading).
    const PREFETCH_RADIUS = 2;

    async function ensureRegion(cx: number, cy: number): Promise<void> {
        const ck = cy * 100000 + cx;
        if (ensuredCenter.has(ck)) return;
        ensuredCenter.add(ck);
        const want: TileCoord[] = [];
        for (let dy = -PREFETCH_RADIUS; dy <= PREFETCH_RADIUS; dy++) {
            for (let dx = -PREFETCH_RADIUS; dx <= PREFETCH_RADIUS; dx++) {
                const tx = cx + dx;
                const ty = cy + dy;
                if (tx < 0 || ty < 0) continue;
                const key = `${tx}_${ty}`;
                if (requested.has(key)) continue;
                if (tiles.size + want.length >= options.maxTiles) break; // budget
                requested.add(key);
                want.push({ cx: tx, cy: ty });
            }
        }
        if (want.length === 0) return;
        const masks = await source.loadBatch(want);
        for (let i = 0; i < want.length; i++) {
            tiles.set(`${want[i].cx}_${want[i].cy}`, masks[i] ?? null);
        }
        // Invalidate the cellState tile cache so a previously-sampled "no data"
        // result can't shadow a freshly-loaded mask.
        lastTileCx = -1;
        lastTileCy = -1;
        lastTileMask = null;
    }

    /** Cell classification: 0 = water, 1 = terrain (traversable at penalty),
     *  2 = no data (missing tile / out of bounds → impassable). Caches the
     *  last-resolved tile so the 8-neighbour hot loop (which mostly samples
     *  within one tile) avoids repeated string-key map lookups. */
    let lastTileCx = -1;
    let lastTileCy = -1;
    let lastTileMask: Uint8Array | null = null;
    function cellState(gx: number, gz: number): 0 | 1 | 2 {
        if (gx < 0 || gz < 0) return 2;
        const cx = gx >> 8;
        const cy = gz >> 8;
        let mask: Uint8Array | null;
        if (cx === lastTileCx && cy === lastTileCy) {
            mask = lastTileMask;
        } else {
            mask = tiles.get(`${cx}_${cy}`) ?? null;
            lastTileCx = cx;
            lastTileCy = cy;
            lastTileMask = mask;
        }
        if (mask === null) return 2;
        const px = gx & (TILE - 1);
        const py = gz & (TILE - 1);
        return mask[py * TILE + px] === 1 ? 0 : 1;
    }

    const { gx: sgx, gz: sgz } = worldToGlobalPixel(Math.round(start.x), Math.round(start.z));
    const { gx: dgx, gz: dgz } = worldToGlobalPixel(Math.round(dest.x), Math.round(dest.z));
    const startKey = keyOf(sgx, sgz);
    const destKey = keyOf(dgx, dgz);

    // Make sure the start/dest regions are loaded before we classify.
    await ensureRegion(sgx >> 8, sgz >> 8);
    await ensureRegion(dgx >> 8, dgz >> 8);
    if (cellState(sgx, sgz) === 2) return emptyFailure("no_data_at_start", tiles.size);
    if (cellState(dgx, dgz) === 2) return emptyFailure("no_data_at_dest", tiles.size);

    // Build boat-TL portal edges between the two endpoint pixels. Endpoints
    // are used as-is (no snapping) — the walk legs on either side handle any
    // short hop onto water. We also collect the endpoint global coords for
    // the A* heuristics so they can "see through" a TL shortcut.
    const portals = new Map<number, Array<{ to: number; id: string }>>();
    const epX: number[] = [];
    const epZ: number[] = [];
    for (const tl of boatTLs) {
        const a = worldToGlobalPixel(Math.round(tl.a.x), Math.round(tl.a.z));
        const b = worldToGlobalPixel(Math.round(tl.b.x), Math.round(tl.b.z));
        const aKey = keyOf(a.gx, a.gz);
        const bKey = keyOf(b.gx, b.gz);
        if (aKey === bKey) continue;
        addPortal(portals, aKey, bKey, tl.id);
        addPortal(portals, bKey, aKey, tl.id);
        epX.push(a.gx, b.gx);
        epZ.push(a.gz, b.gz);
    }

    const tlHopCost = options.tlHopCost;
    const K = epX.length; // 2 × number of boat-TLs
    const landPenalty = Math.max(1, options.landPenalty);

    // ── A* heuristic (per target) ────────────────────────────────────────────
    // Octile distance is the exact minimum cost of an all-water 8-connected
    // path (water = ×1), so it's an admissible lower bound on the true cost
    // (terrain only ever costs more). With boat-TLs the straight-line bound
    // could overestimate (a TL teleports for a flat cost), so we precompute,
    // over a tiny abstract graph (TL endpoints + target), the cheapest
    // optimistic cost from each endpoint to the target and let the heuristic
    // route "through" a TL when that's cheaper. This keeps h a true lower
    // bound for any number of TL hops. We build one heuristic toward the
    // destination (forward search) and one toward the start (backward search).
    function makeHeuristic(tgx: number, tgz: number): (gx: number, gz: number) => number {
        const bestFromEndpoint = new Array<number>(K).fill(Infinity);
        if (K > 0) {
            const TGT = K;
            const adist = new Array<number>(K + 1).fill(Infinity);
            const adone = new Array<boolean>(K + 1).fill(false);
            adist[TGT] = 0;
            const ax = (i: number) => (i === TGT ? tgx : epX[i]);
            const az = (i: number) => (i === TGT ? tgz : epZ[i]);
            for (let iter = 0; iter <= K; iter++) {
                let u = -1;
                let ud = Infinity;
                for (let i = 0; i <= K; i++) {
                    if (!adone[i] && adist[i] < ud) {
                        ud = adist[i];
                        u = i;
                    }
                }
                if (u < 0) break;
                adone[u] = true;
                const ux = ax(u);
                const uz = az(u);
                for (let v = 0; v <= K; v++) {
                    if (v === u) continue;
                    let w = octile(ux, uz, ax(v), az(v));
                    if (u < K && v < K && (u >> 1) === (v >> 1) && (u ^ v) === 1) {
                        if (tlHopCost < w) w = tlHopCost;
                    }
                    const nd = adist[u] + w;
                    if (nd < adist[v]) adist[v] = nd;
                }
            }
            for (let i = 0; i < K; i++) bestFromEndpoint[i] = adist[i];
        }
        return (gx: number, gz: number): number => {
            let h = octile(gx, gz, tgx, tgz);
            for (let i = 0; i < K; i++) {
                const c = octile(gx, gz, epX[i], epZ[i]) + bestFromEndpoint[i];
                if (c < h) h = c;
            }
            return h;
        };
    }

    const hToDest = makeHeuristic(dgx, dgz);
    const hToStart = makeHeuristic(sgx, sgz);

    // ── Bidirectional ("double") A* ──────────────────────────────────────────
    // A forward search grows from the start toward the destination; a backward
    // search grows from the destination toward the start (over the reverse
    // graph). They meet in the middle, so each explores far fewer nodes than a
    // single-ended search — and, crucially, the backward frontier crosses a
    // short land/tunnel gap near the goal itself instead of forcing the forward
    // search to first exhaust every cheaper patch of water around the start.
    //
    // Edge costs are asymmetric (a step costs by the cell it ENTERS: terrain
    // ×landPenalty, water ×1). The forward search prices a step by the entered
    // neighbour; the backward (reverse-graph) search prices it by the cell it
    // leaves, which is exactly the entered cell of the corresponding forward
    // edge. TL portals are symmetric (flat `tlHopCost`). `mu`/`meetNode` track
    // the best complete path found through any node reached from both sides.
    interface Dir {
        g: Map<number, number>;
        prev: Map<number, number>;
        viaTL: Set<number>;
        heap: MinHeap;
        h: (gx: number, gz: number) => number;
        forward: boolean;
    }
    const fwd: Dir = {
        g: new Map(),
        prev: new Map(),
        viaTL: new Set(),
        heap: new MinHeap(),
        h: hToDest,
        forward: true,
    };
    const bwd: Dir = {
        g: new Map(),
        prev: new Map(),
        viaTL: new Set(),
        heap: new MinHeap(),
        h: hToStart,
        forward: false,
    };
    fwd.g.set(startKey, 0);
    fwd.heap.push(hToDest(sgx, sgz), startKey);
    bwd.g.set(destKey, 0);
    bwd.heap.push(hToStart(dgx, dgz), destKey);

    let mu = Infinity;
    let meetNode = -1;
    if (startKey === destKey) {
        mu = 0;
        meetNode = startKey;
    }
    let visited = 0;
    let lastReportedTiles = -1;

    async function expand(dir: Dir, other: Dir): Promise<SailboatRouteFailure | null> {
        const popped = dir.heap.pop()!;
        const u = popped.node;
        const ux = gxOf(u);
        const uz = gzOf(u);
        const gu = dir.g.get(u) ?? Infinity;
        // Skip stale heap entries (a cheaper path to u was found after this
        // entry was pushed).
        if (popped.cost > gu + dir.h(ux, uz) + 1e-6) return null;

        visited++;
        if (visited > options.maxVisited) return "search_exhausted";

        await ensureRegion(ux >> 8, uz >> 8);

        // Emit progress on a steady cadence AND whenever a new tile loads, so
        // the debug overlay can highlight scanned chunks as they stream.
        if (onProgress && ((visited & 8191) === 0 || tiles.size !== lastReportedTiles)) {
            lastReportedTiles = tiles.size;
            onProgress({
                visited,
                tilesLoaded: tiles.size,
                tiles: Array.from(tiles.keys()),
            });
        }

        const uState = cellState(ux, uz); // backward prices steps by the cell left

        for (let i = 0; i < NEIGHBORS.length; i++) {
            const nx = ux + NEIGHBORS[i][0];
            const nz = uz + NEIGHBORS[i][1];
            const vState = cellState(nx, nz);
            if (vState === 2) continue; // impassable (no data)
            const v = keyOf(nx, nz);
            const enteredLand = dir.forward ? vState === 1 : uState === 1;
            const stepMult = enteredLand ? landPenalty : 1;
            const nd = gu + NEIGHBORS[i][2] * stepMult;
            if (nd < (dir.g.get(v) ?? Infinity)) {
                dir.g.set(v, nd);
                dir.prev.set(v, u);
                dir.viaTL.delete(v);
                dir.heap.push(nd + dir.h(nx, nz), v);
                const og = other.g.get(v);
                if (og !== undefined && nd + og < mu) {
                    mu = nd + og;
                    meetNode = v;
                }
            }
        }

        // Portal (boat-TL) edges — symmetric, so usable by both directions.
        const outs = portals.get(u);
        if (outs) {
            for (const edge of outs) {
                const nd = gu + tlHopCost;
                if (nd < (dir.g.get(edge.to) ?? Infinity)) {
                    dir.g.set(edge.to, nd);
                    dir.prev.set(edge.to, u);
                    dir.viaTL.add(edge.to);
                    dir.heap.push(nd + dir.h(gxOf(edge.to), gzOf(edge.to)), edge.to);
                    const og = other.g.get(edge.to);
                    if (og !== undefined && nd + og < mu) {
                        mu = nd + og;
                        meetNode = edge.to;
                    }
                }
            }
        }
        return null;
    }

    // Expand the frontier with the smaller top f-value; stop once neither side
    // can possibly beat the best meeting found (both top f ≥ mu) or both are
    // exhausted. An empty heap reports Infinity, so a one-sided dead end lets
    // the other side keep improving mu until it too is spent.
    for (;;) {
        const topF = fwd.heap.topCost();
        const topB = bwd.heap.topCost();
        if (Math.min(topF, topB) >= mu) break;
        if (topF === Infinity && topB === Infinity) break;
        const fail = topF <= topB ? await expand(fwd, bwd) : await expand(bwd, fwd);
        if (fail) return emptyFailure(fail, tiles.size);
    }

    if (meetNode < 0 || mu === Infinity) {
        return emptyFailure("unreachable", tiles.size);
    }

    // ── Reconstruct ──────────────────────────────────────────────────────────
    // Forward half: start → meetNode (via fwd.prev). Backward half: meetNode →
    // dest (via bwd.prev, which already points toward the destination).
    const fPart: number[] = [];
    let cur: number | undefined = meetNode;
    while (cur !== undefined) {
        fPart.push(cur);
        if (cur === startKey) break;
        cur = fwd.prev.get(cur);
    }
    fPart.reverse(); // start … meetNode

    const bPart: number[] = [];
    const bTLFlags: boolean[] = [];
    cur = meetNode;
    while (cur !== destKey) {
        const nxt = bwd.prev.get(cur);
        if (nxt === undefined) break;
        bPart.push(nxt);
        // viaTL on the backward node marks the (forward-oriented) edge cur→nxt
        // as a TL hop.
        bTLFlags.push(bwd.viaTL.has(cur));
        cur = nxt;
    }

    const chain: number[] = fPart.concat(bPart);
    const tlFlags: boolean[] = new Array(chain.length).fill(false);
    for (let i = 1; i < fPart.length; i++) tlFlags[i] = fwd.viaTL.has(fPart[i]);
    for (let j = 0; j < bPart.length; j++) tlFlags[fPart.length + j] = bTLFlags[j];

    const result = buildWaypoints(chain, tlFlags, cellState);
    return {
        found: true,
        waypoints: result.waypoints,
        waterBlocks: result.waterBlocks,
        terrainBlocks: result.terrainBlocks,
        tlHops: result.tlHops,
        tilesLoaded: tiles.size,
    };
}

function emptyFailure(reason: SailboatRouteFailure, tilesLoaded: number): SailboatRouteResult {
    return {
        found: false,
        reason,
        waypoints: [],
        waterBlocks: 0,
        terrainBlocks: 0,
        tlHops: 0,
        tilesLoaded,
    };
}

function addPortal(
    portals: Map<number, Array<{ to: number; id: string }>>,
    from: number,
    to: number,
    id: string,
): void {
    const arr = portals.get(from);
    if (arr) arr.push({ to, id });
    else portals.set(from, [{ to, id }]);
}

/** Turn the global-pixel chain into simplified world waypoints, classifying
 *  each segment as water / terrain / TL-hop. Collinear runs of the same class
 *  are collapsed; class boundaries, TL hops and corners are kept as hard
 *  waypoints. `terrain` on a waypoint marks the segment *arriving* at it as a
 *  land crossing (drawn dotted). */
function buildWaypoints(
    chain: number[],
    tlFlags: boolean[],
    cellState: (gx: number, gz: number) => 0 | 1 | 2,
): { waypoints: SailboatWaypoint[]; waterBlocks: number; terrainBlocks: number; tlHops: number } {
    const waypoints: SailboatWaypoint[] = [];
    let waterBlocks = 0;
    let terrainBlocks = 0;
    let tlHops = 0;

    const pts = chain.map((k) => globalPixelToWorld(gxOf(k), gzOf(k)));
    // Segment class arriving at index i (i>=1): "tl" | "terrain" | "water".
    const segClass: Array<"tl" | "terrain" | "water"> = new Array(chain.length);
    for (let i = 1; i < chain.length; i++) {
        if (tlFlags[i]) {
            segClass[i] = "tl";
            tlHops++;
        } else {
            const aLand = cellState(gxOf(chain[i - 1]), gzOf(chain[i - 1])) === 1;
            const bLand = cellState(gxOf(chain[i]), gzOf(chain[i])) === 1;
            const terrain = aLand || bLand;
            segClass[i] = terrain ? "terrain" : "water";
            const dx = pts[i].x - pts[i - 1].x;
            const dz = pts[i].z - pts[i - 1].z;
            const d = Math.hypot(dx, dz);
            if (terrain) terrainBlocks += d;
            else waterBlocks += d;
        }
    }

    for (let i = 0; i < chain.length; i++) {
        const arriving = i > 0 ? segClass[i] : undefined;
        const next = i + 1 < chain.length ? segClass[i + 1] : undefined;
        // Keep endpoints, any node where the segment class changes, and
        // corners within a run. This preserves dotted/solid boundaries.
        const hard =
            i === 0 ||
            i === chain.length - 1 ||
            arriving === "tl" ||
            next === "tl" ||
            (arriving !== undefined && next !== undefined && arriving !== next);
        const keep =
            hard ||
            i === 0 ||
            i === chain.length - 1 ||
            !isCollinear(pts[i - 1], pts[i], pts[i + 1]);
        if (!keep) continue;
        waypoints.push({
            x: pts[i].x,
            z: pts[i].z,
            tl: arriving === "tl" ? true : undefined,
            terrain: arriving === "terrain" ? true : undefined,
        });
    }

    return { waypoints, waterBlocks, terrainBlocks, tlHops };
}

function isCollinear(a: SailboatPoint, b: SailboatPoint, c: SailboatPoint): boolean {
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    return Math.abs(cross) < 1e-6;
}
