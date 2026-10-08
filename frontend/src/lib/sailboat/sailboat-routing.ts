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
    landPenalty: 15,
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
            for (;;) {
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
    loadTileMask: LoadTileMask,
    options: SailboatRouteOptions = DEFAULT_SAILBOAT_OPTIONS,
    onProgress?: (p: SailboatProgress) => void,
): Promise<SailboatRouteResult> {
    const tiles = new Map<string, Uint8Array | null>();
    const ensuredNbhd = new Set<number>();

    async function ensureTile(cx: number, cy: number): Promise<Uint8Array | null> {
        if (cx < 0 || cy < 0) return null;
        const k = `${cx}_${cy}`;
        const hit = tiles.get(k);
        if (hit !== undefined) return hit;
        if (tiles.size >= options.maxTiles) return null; // budget exhausted
        const mask = await loadTileMask(cx, cy);
        tiles.set(k, mask);
        // Invalidate the cellState tile cache so a previously-sampled "no
        // data" result for this tile can't shadow the freshly-loaded mask.
        lastTileCx = -1;
        lastTileCy = -1;
        lastTileMask = null;
        return mask;
    }

    /** Load the 3×3 tile block around (cx, cy) so every 8-neighbour of any
     *  pixel in (cx, cy) is resolvable without further awaits. */
    async function ensureNeighborhood(cx: number, cy: number): Promise<void> {
        const nk = cy * 100000 + cx;
        if (ensuredNbhd.has(nk)) return;
        ensuredNbhd.add(nk);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                await ensureTile(cx + dx, cy + dy);
            }
        }
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

    // Make sure the start/dest neighbourhoods are loaded before we classify.
    await ensureNeighborhood(sgx >> 8, sgz >> 8);
    await ensureNeighborhood(dgx >> 8, dgz >> 8);
    if (cellState(sgx, sgz) === 2) return emptyFailure("no_data_at_start", tiles.size);
    if (cellState(dgx, dgz) === 2) return emptyFailure("no_data_at_dest", tiles.size);

    // Build boat-TL portal edges between the two endpoint pixels. Endpoints
    // are used as-is (no snapping) — the walk legs on either side handle any
    // short hop onto water.
    const portals = new Map<number, Array<{ to: number; id: string }>>();
    for (const tl of boatTLs) {
        const a = worldToGlobalPixel(Math.round(tl.a.x), Math.round(tl.a.z));
        const b = worldToGlobalPixel(Math.round(tl.b.x), Math.round(tl.b.z));
        const aKey = keyOf(a.gx, a.gz);
        const bKey = keyOf(b.gx, b.gz);
        if (aKey === bKey) continue;
        addPortal(portals, aKey, bKey, tl.id);
        addPortal(portals, bKey, aKey, tl.id);
    }

    // ── Dijkstra over water (×1) + terrain (×landPenalty) + TL portals ───────
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    const viaTL = new Set<number>();
    const heap = new MinHeap();
    dist.set(startKey, 0);
    heap.push(0, startKey);
    let visited = 0;
    const landPenalty = Math.max(1, options.landPenalty);
    let lastReportedTiles = -1;

    while (heap.size > 0) {
        const popped = heap.pop()!;
        const u = popped.node;
        if (popped.cost > (dist.get(u) ?? Infinity)) continue;
        if (u === destKey) break;

        visited++;
        if (visited > options.maxVisited) {
            return emptyFailure("search_exhausted", tiles.size);
        }

        const ux = gxOf(u);
        const uz = gzOf(u);
        await ensureNeighborhood(ux >> 8, uz >> 8);

        // Emit progress on a steady cadence AND whenever a new tile loads, so
        // the admin debug overlay can highlight scanned chunks as they stream.
        if (onProgress && ((visited & 8191) === 0 || tiles.size !== lastReportedTiles)) {
            lastReportedTiles = tiles.size;
            onProgress({
                visited,
                tilesLoaded: tiles.size,
                tiles: Array.from(tiles.keys()),
            });
        }

        const baseCost = dist.get(u)!;
        for (let i = 0; i < NEIGHBORS.length; i++) {
            const nx = ux + NEIGHBORS[i][0];
            const nz = uz + NEIGHBORS[i][1];
            const state = cellState(nx, nz);
            if (state === 2) continue; // impassable (no data)
            const v = keyOf(nx, nz);
            // Terrain blocks cost the full penalty; a diagonal step onto
            // terrain costs √2 × penalty.
            const stepMult = state === 1 ? landPenalty : 1;
            const nd = baseCost + NEIGHBORS[i][2] * stepMult;
            if (nd < (dist.get(v) ?? Infinity)) {
                dist.set(v, nd);
                prev.set(v, u);
                viaTL.delete(v);
                heap.push(nd, v);
            }
        }

        // Portal (boat-TL) edges out of u.
        const outs = portals.get(u);
        if (outs) {
            for (const edge of outs) {
                const nd = baseCost + options.tlHopCost;
                if (nd < (dist.get(edge.to) ?? Infinity)) {
                    dist.set(edge.to, nd);
                    prev.set(edge.to, u);
                    viaTL.add(edge.to);
                    heap.push(nd, edge.to);
                }
            }
        }
    }

    if (!dist.has(destKey)) {
        return emptyFailure("unreachable", tiles.size);
    }

    // ── Reconstruct ──────────────────────────────────────────────────────────
    const chain: number[] = [];
    const tlFlags: boolean[] = [];
    let cur: number | undefined = destKey;
    while (cur !== undefined) {
        chain.push(cur);
        tlFlags.push(viaTL.has(cur));
        if (cur === startKey) break;
        cur = prev.get(cur);
    }
    chain.reverse();
    tlFlags.reverse();

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
