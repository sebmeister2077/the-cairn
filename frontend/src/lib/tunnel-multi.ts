// Multi-endpoint tunnel logic. Layered on top of `tunnel-pattern.ts`:
// this module only knows about endpoints, topologies, segment specs,
// and cost metrics. Segment generation itself still goes through
// `generateTunnelPath`.
//
// Three topologies are supported:
//   - `pairs` : render a tunnel for every enabled un-ordered pair
//     (with N=2 this is the legacy single-tunnel case).
//   - `tour`  : visit every endpoint in an optimised order; render
//     N-1 consecutive segments.
//   - `hub`   : solve for one integer-block junction and render N
//     branches (one per endpoint → junction).
//
// Per-segment `SegmentSpec` (mode + pattern) is stored against an
// `EdgeKey` so each branch keeps its own configuration even as the
// junction moves or the endpoint list shifts.

import {
    DEFAULT_PADDING,
    DEFAULT_PADDING_DIAGONAL,
    DEFAULT_SEQUENCE,
    DEFAULT_USE_SLABS,
    autoFitPattern,
    generateTunnelPath,
    pathBounds,
    pathStats,
    type PathBlock,
    type PathBounds,
    type PathStats,
    type TunnelMode,
    type TunnelPattern,
} from "./tunnel-pattern";
import type { Block3 } from "./tunnel-share";

export type Topology = "pairs" | "tour" | "hub";
export type CostMetric = "total" | "minimax" | "manhattan";

export const TOPOLOGIES: ReadonlyArray<Topology> = ["pairs", "tour", "hub"];
export const COST_METRICS: ReadonlyArray<CostMetric> = ["total", "minimax", "manhattan"];

/** A user-defined endpoint. `id` is stable across renders so the
 *  segment registry keys don't break when coords are edited. */
export interface TLEndpoint {
    id: string;
    coord: Block3;
    label?: string;
}

/** Per-segment configuration (mode + pattern). One entry per active
 *  edge. The map is keyed by `EdgeKey`. */
export interface SegmentSpec {
    mode: TunnelMode;
    pattern: TunnelPattern;
}

/** Sorted "a|b" identifier so hub-and-spoke edges and pairwise edges
 *  share the same key space. The literal string `"hub"` is reserved
 *  as one half of every hub branch's key. */
export type EdgeKey = string;

export const HUB_ID = "hub";

/** Endpoint cap above which `solveTour` falls back to NN + 2-opt and
 *  `solveHub` skips the grid search (centroid only). Held-Karp is
 *  O(N² · 2^N) — past 10 it stops being interactive. */
export const MULTI_TUNNEL_SOFT_CAP = 10;

const DEFAULT_MODE: TunnelMode = "bresenham";
const HUB_GRID_RADIUS = 6;
const HUB_GRID_MAX_CANDIDATES = 4096;

// ---------------------------------------------------------------------------
// Edge keys + segment registry
// ---------------------------------------------------------------------------

export function edgeKey(a: string, b: string): EdgeKey {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function isHubEdge(key: EdgeKey): boolean {
    const [a, b] = key.split("|");
    return a === HUB_ID || b === HUB_ID;
}

/** Return the endpoint ID participating in a hub edge (or null). */
export function hubEdgeOwner(key: EdgeKey): string | null {
    const [a, b] = key.split("|");
    if (a === HUB_ID) return b;
    if (b === HUB_ID) return a;
    return null;
}

/** Default `SegmentSpec` for a fresh edge. Mirrors the single-tunnel
 *  defaults from `autoFitPattern`. */
export function defaultSegmentSpec(from: Block3, to: Block3): SegmentSpec {
    return { mode: DEFAULT_MODE, pattern: autoFitPattern(from, to) };
}

/** Stable shallow-copy `Map` setter. Returns a new map with the entry
 *  set so React state updates trigger re-renders. */
export function setSegment(
    segments: Map<EdgeKey, SegmentSpec>,
    key: EdgeKey,
    spec: SegmentSpec,
): Map<EdgeKey, SegmentSpec> {
    const next = new Map(segments);
    next.set(key, spec);
    return next;
}

/** Return spec for a key, falling back to a fresh auto-fit if missing.
 *  The fallback is **not** persisted — use `setSegment` to persist. */
export function getSegmentOrDefault(
    segments: Map<EdgeKey, SegmentSpec>,
    key: EdgeKey,
    from: Block3,
    to: Block3,
): SegmentSpec {
    const existing = segments.get(key);
    if (existing) return existing;
    return defaultSegmentSpec(from, to);
}

/** Drop entries that reference an endpoint that no longer exists. */
export function pruneSegments(
    segments: Map<EdgeKey, SegmentSpec>,
    endpointIds: ReadonlySet<string>,
): Map<EdgeKey, SegmentSpec> {
    const next = new Map<EdgeKey, SegmentSpec>();
    for (const [key, spec] of segments) {
        const [a, b] = key.split("|");
        const aOk = a === HUB_ID || endpointIds.has(a);
        const bOk = b === HUB_ID || endpointIds.has(b);
        if (aOk && bOk) next.set(key, spec);
    }
    return next;
}

// ---------------------------------------------------------------------------
// Cost metrics
// ---------------------------------------------------------------------------

function manhattan(a: Block3, b: Block3): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

/** Cost of a single segment under a given metric. `total` and `minimax`
 *  use real path length (the segment spec affects geometry); `manhattan`
 *  is closed-form and ignores the spec. */
export function segmentCost(
    from: Block3,
    to: Block3,
    spec: SegmentSpec,
    metric: CostMetric,
): number {
    if (metric === "manhattan") return manhattan(from, to);
    const path = generateTunnelPath(from, to, spec.pattern, spec.mode);
    return Math.max(0, path.length - 1);
}

/** Aggregate a batch of segment costs under the chosen metric. */
export function aggregateCost(costs: ReadonlyArray<number>, metric: CostMetric): number {
    if (costs.length === 0) return 0;
    if (metric === "minimax") {
        let m = costs[0];
        for (let i = 1; i < costs.length; i++) if (costs[i] > m) m = costs[i];
        return m;
    }
    let sum = 0;
    for (const c of costs) sum += c;
    return sum;
}

// ---------------------------------------------------------------------------
// Pairwise + tour
// ---------------------------------------------------------------------------

export function pairwiseEdgeKeys(endpoints: ReadonlyArray<TLEndpoint>): EdgeKey[] {
    const out: EdgeKey[] = [];
    for (let i = 0; i < endpoints.length; i++) {
        for (let j = i + 1; j < endpoints.length; j++) {
            out.push(edgeKey(endpoints[i].id, endpoints[j].id));
        }
    }
    return out;
}

/** Visit-order optimiser. Starts at endpoint 0 and returns IDs in
 *  visit order. Uses Held-Karp DP for N ≤ MULTI_TUNNEL_SOFT_CAP and a
 *  nearest-neighbour + 2-opt heuristic above. */
export function solveTour(
    endpoints: ReadonlyArray<TLEndpoint>,
    segments: Map<EdgeKey, SegmentSpec>,
    metric: CostMetric,
): string[] {
    const n = endpoints.length;
    if (n <= 1) return endpoints.map((e) => e.id);
    if (n === 2) return [endpoints[0].id, endpoints[1].id];

    // Pre-compute pairwise edge cost (symmetric).
    const cost: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = endpoints[i].coord;
            const b = endpoints[j].coord;
            const key = edgeKey(endpoints[i].id, endpoints[j].id);
            const spec = getSegmentOrDefault(segments, key, a, b);
            const c = segmentCost(a, b, spec, metric);
            cost[i][j] = c;
            cost[j][i] = c;
        }
    }

    if (n <= MULTI_TUNNEL_SOFT_CAP) return heldKarpOpenPath(cost).map((i) => endpoints[i].id);
    return nearestNeighbour2Opt(cost).map((i) => endpoints[i].id);
}

/** Held-Karp open-path shortest-Hamiltonian. Returns an index order
 *  visiting every node starting at 0. O(n² · 2^n). */
function heldKarpOpenPath(cost: number[][]): number[] {
    const n = cost.length;
    if (n <= 1) return n === 1 ? [0] : [];
    const fullMask = (1 << n) - 1;
    // dp[mask][i] = min cost to visit `mask` (must contain 0 and i)
    // ending at i.
    const dp: Float64Array[] = [];
    const parent: Int32Array[] = [];
    for (let m = 0; m <= fullMask; m++) {
        const arr = new Float64Array(n);
        const par = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = Infinity;
            par[i] = -1;
        }
        dp.push(arr);
        parent.push(par);
    }
    dp[1 | 0][0] = 0;
    for (let mask = 1; mask <= fullMask; mask++) {
        if ((mask & 1) === 0) continue;
        for (let i = 0; i < n; i++) {
            if ((mask & (1 << i)) === 0) continue;
            const base = dp[mask][i];
            if (!Number.isFinite(base)) continue;
            for (let j = 0; j < n; j++) {
                if (j === 0) continue;
                if ((mask & (1 << j)) !== 0) continue;
                const nextMask = mask | (1 << j);
                const candidate = base + cost[i][j];
                if (candidate < dp[nextMask][j]) {
                    dp[nextMask][j] = candidate;
                    parent[nextMask][j] = i;
                }
            }
        }
    }
    // Pick the cheapest endpoint of the full-mask path.
    let bestEnd = 0;
    let bestCost = Infinity;
    for (let i = 1; i < n; i++) {
        if (dp[fullMask][i] < bestCost) {
            bestCost = dp[fullMask][i];
            bestEnd = i;
        }
    }
    // Reconstruct.
    const order: number[] = [];
    let mask = fullMask;
    let cur = bestEnd;
    while (cur !== -1) {
        order.push(cur);
        const prev = parent[mask][cur];
        mask = mask & ~(1 << cur);
        cur = prev;
    }
    order.reverse();
    return order;
}

function nearestNeighbour2Opt(cost: number[][]): number[] {
    const n = cost.length;
    const order: number[] = [0];
    const visited = new Array<boolean>(n).fill(false);
    visited[0] = true;
    for (let step = 1; step < n; step++) {
        const cur = order[order.length - 1];
        let best = -1;
        let bestC = Infinity;
        for (let j = 0; j < n; j++) {
            if (visited[j]) continue;
            if (cost[cur][j] < bestC) {
                bestC = cost[cur][j];
                best = j;
            }
        }
        if (best < 0) break;
        order.push(best);
        visited[best] = true;
    }
    // 2-opt smoothing (open path).
    let improved = true;
    let passes = 0;
    while (improved && passes < 32) {
        improved = false;
        passes += 1;
        for (let i = 0; i < n - 1; i++) {
            for (let k = i + 1; k < n; k++) {
                const a = order[i];
                const b = order[i + 1];
                const c = order[k];
                const d = k + 1 < n ? order[k + 1] : -1;
                const before = cost[a][b] + (d >= 0 ? cost[c][d] : 0);
                const after = cost[a][c] + (d >= 0 ? cost[b][d] : 0);
                if (after + 1e-9 < before) {
                    reverseInPlace(order, i + 1, k);
                    improved = true;
                }
            }
        }
    }
    return order;
}

function reverseInPlace<T>(arr: T[], lo: number, hi: number): void {
    while (lo < hi) {
        const tmp = arr[lo];
        arr[lo] = arr[hi];
        arr[hi] = tmp;
        lo += 1;
        hi -= 1;
    }
}

// ---------------------------------------------------------------------------
// Hub junction optimiser
// ---------------------------------------------------------------------------

function median(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    if (n % 2 === 1) return sorted[(n - 1) >> 1];
    return Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}

/** Per-axis median of endpoint coords. Used as the seed candidate for
 *  the hub grid search and as the centroid-only fallback above the
 *  endpoint cap. Y uses median (not mean) so the junction stays at a
 *  real column rather than half-floors. */
export function endpointCentroid(endpoints: ReadonlyArray<TLEndpoint>): Block3 {
    if (endpoints.length === 0) return { x: 0, y: 110, z: 0 };
    return {
        x: median(endpoints.map((e) => e.coord.x)),
        y: median(endpoints.map((e) => e.coord.y)),
        z: median(endpoints.map((e) => e.coord.z)),
    };
}

function evaluateHub(
    junction: Block3,
    endpoints: ReadonlyArray<TLEndpoint>,
    segments: Map<EdgeKey, SegmentSpec>,
    metric: CostMetric,
): number {
    const costs: number[] = [];
    for (const ep of endpoints) {
        const key = edgeKey(ep.id, HUB_ID);
        const spec = getSegmentOrDefault(segments, key, ep.coord, junction);
        costs.push(segmentCost(ep.coord, junction, spec, metric));
    }
    return aggregateCost(costs, metric);
}

/** Solve for an optimal junction block. Strategy:
 *   1. Seed at the per-axis median.
 *   2. Hill-climb: at each step, evaluate the 6 axis-aligned neighbours
 *      and move to the best improver.
 *   3. Cap moves at HUB_GRID_RADIUS · 3 to bound runtime.
 *  Above MULTI_TUNNEL_SOFT_CAP endpoints, returns the centroid only
 *  (skipping the hill-climb to keep the page interactive). */
export function solveHub(
    endpoints: ReadonlyArray<TLEndpoint>,
    segments: Map<EdgeKey, SegmentSpec>,
    metric: CostMetric,
): Block3 {
    const seed = endpointCentroid(endpoints);
    if (endpoints.length === 0) return seed;
    if (endpoints.length > MULTI_TUNNEL_SOFT_CAP) return seed;

    let cur: Block3 = { ...seed };
    let curCost = evaluateHub(cur, endpoints, segments, metric);
    const maxSteps = HUB_GRID_RADIUS * 3;
    let visited = 0;
    const seen = new Set<string>([`${cur.x},${cur.y},${cur.z}`]);

    for (let step = 0; step < maxSteps; step++) {
        if (visited >= HUB_GRID_MAX_CANDIDATES) break;
        const neighbours: Block3[] = [
            { x: cur.x + 1, y: cur.y, z: cur.z },
            { x: cur.x - 1, y: cur.y, z: cur.z },
            { x: cur.x, y: cur.y + 1, z: cur.z },
            { x: cur.x, y: cur.y - 1, z: cur.z },
            { x: cur.x, y: cur.y, z: cur.z + 1 },
            { x: cur.x, y: cur.y, z: cur.z - 1 },
        ];
        let bestNext: Block3 | null = null;
        let bestCost = curCost;
        for (const n of neighbours) {
            const key = `${n.x},${n.y},${n.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            visited += 1;
            const cost = evaluateHub(n, endpoints, segments, metric);
            if (cost + 1e-9 < bestCost) {
                bestCost = cost;
                bestNext = n;
            }
        }
        if (!bestNext) break;
        cur = bestNext;
        curCost = bestCost;
    }
    return cur;
}

// ---------------------------------------------------------------------------
// Path generation across topologies
// ---------------------------------------------------------------------------

export interface MultiSegment {
    /** Stable identifier — the same `EdgeKey` used in the segment registry. */
    key: EdgeKey;
    /** Endpoint A id (always a real endpoint). */
    fromId: string;
    /** Endpoint B id, or `HUB_ID` for hub branches. */
    toId: string;
    fromCoord: Block3;
    toCoord: Block3;
    spec: SegmentSpec;
    path: PathBlock[];
}

export interface MultiPathResult {
    segments: MultiSegment[];
    /** Junction block when topology is `hub`; else null. */
    junction: Block3 | null;
}

interface BuildOptions {
    endpoints: ReadonlyArray<TLEndpoint>;
    segments: Map<EdgeKey, SegmentSpec>;
    topology: Topology;
    costMetric: CostMetric;
    /** For `pairs` topology only — un-checked edges are skipped. When
     *  null, every pair renders. */
    enabledPairs?: ReadonlySet<EdgeKey> | null;
    /** Pre-solved tour order (string[]). When null, `solveTour` runs. */
    tourOrder?: ReadonlyArray<string> | null;
    /** Pre-solved hub junction. When null, `solveHub` runs. */
    junction?: Block3 | null;
}

export function buildMultiPaths(opts: BuildOptions): MultiPathResult {
    const { endpoints, segments, topology, costMetric } = opts;
    if (endpoints.length === 0) return { segments: [], junction: null };

    const byId = new Map(endpoints.map((e) => [e.id, e]));

    if (topology === "pairs") {
        const out: MultiSegment[] = [];
        const allKeys = pairwiseEdgeKeys(endpoints);
        for (const key of allKeys) {
            if (opts.enabledPairs && !opts.enabledPairs.has(key)) continue;
            const [a, b] = key.split("|");
            const epA = byId.get(a);
            const epB = byId.get(b);
            if (!epA || !epB) continue;
            const spec = getSegmentOrDefault(segments, key, epA.coord, epB.coord);
            const path = generateTunnelPath(epA.coord, epB.coord, spec.pattern, spec.mode);
            out.push({
                key,
                fromId: epA.id,
                toId: epB.id,
                fromCoord: epA.coord,
                toCoord: epB.coord,
                spec,
                path,
            });
        }
        return { segments: out, junction: null };
    }

    if (topology === "tour") {
        const order = opts.tourOrder ?? solveTour(endpoints, segments, costMetric);
        const out: MultiSegment[] = [];
        for (let i = 0; i < order.length - 1; i++) {
            const epA = byId.get(order[i]);
            const epB = byId.get(order[i + 1]);
            if (!epA || !epB) continue;
            const key = edgeKey(epA.id, epB.id);
            const spec = getSegmentOrDefault(segments, key, epA.coord, epB.coord);
            const path = generateTunnelPath(epA.coord, epB.coord, spec.pattern, spec.mode);
            out.push({
                key,
                fromId: epA.id,
                toId: epB.id,
                fromCoord: epA.coord,
                toCoord: epB.coord,
                spec,
                path,
            });
        }
        return { segments: out, junction: null };
    }

    // hub
    const junction = opts.junction ?? solveHub(endpoints, segments, costMetric);
    const out: MultiSegment[] = [];
    for (const ep of endpoints) {
        const key = edgeKey(ep.id, HUB_ID);
        const spec = getSegmentOrDefault(segments, key, ep.coord, junction);
        const path = generateTunnelPath(ep.coord, junction, spec.pattern, spec.mode);
        out.push({
            key,
            fromId: ep.id,
            toId: HUB_ID,
            fromCoord: ep.coord,
            toCoord: junction,
            spec,
            path,
        });
    }
    return { segments: out, junction };
}

// ---------------------------------------------------------------------------
// Aggregate stats
// ---------------------------------------------------------------------------

export interface MultiPathStats {
    totalBlocks: number;
    longestSegmentBlocks: number;
    totalSlabs: number;
    /** Sum of straight-line distances for every segment. */
    totalStraightLine: number;
    /** Sum of walkable lengths (used for traverse-time stats). */
    totalWalkable: number;
    /** Per-segment stats keyed by `EdgeKey` for the breakdown table. */
    perSegment: Map<EdgeKey, PathStats>;
    /** Union of every segment's bounds (and endpoints + junction). */
    bounds: PathBounds;
}

export function aggregateMultiStats(result: MultiPathResult): MultiPathStats {
    let totalBlocks = 0;
    let longestSegmentBlocks = 0;
    let totalSlabs = 0;
    let totalStraightLine = 0;
    let totalWalkable = 0;
    const perSegment = new Map<EdgeKey, PathStats>();

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const considerPoint = (p: Block3) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    };

    for (const seg of result.segments) {
        const stats = pathStats(seg.path, seg.fromCoord, seg.toCoord);
        perSegment.set(seg.key, stats);
        totalBlocks += stats.totalBlocks;
        if (stats.totalBlocks > longestSegmentBlocks) longestSegmentBlocks = stats.totalBlocks;
        totalSlabs += stats.slabBlocks;
        totalStraightLine += stats.straightLineBlocks;
        totalWalkable += stats.walkableLength;
        const b = pathBounds(seg.path);
        considerPoint(b.min);
        considerPoint(b.max);
    }
    if (result.junction) considerPoint(result.junction);

    if (!Number.isFinite(minX)) {
        return {
            totalBlocks: 0,
            longestSegmentBlocks: 0,
            totalSlabs: 0,
            totalStraightLine: 0,
            totalWalkable: 0,
            perSegment,
            bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        };
    }
    return {
        totalBlocks,
        longestSegmentBlocks,
        totalSlabs,
        totalStraightLine,
        totalWalkable,
        perSegment,
        bounds: {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
        },
    };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Mint a stable-ish ID for new endpoints. Random suffix avoids
 *  collisions if the user adds + removes + adds again. */
export function newEndpointId(): string {
    return `tl_${Math.random().toString(36).slice(2, 9)}`;
}

/** Replace the spec for one segment, preserving the rest. */
export function updateSegmentSpec(
    segments: Map<EdgeKey, SegmentSpec>,
    key: EdgeKey,
    update: Partial<SegmentSpec>,
    fallbackFrom: Block3,
    fallbackTo: Block3,
): Map<EdgeKey, SegmentSpec> {
    const prev = getSegmentOrDefault(segments, key, fallbackFrom, fallbackTo);
    return setSegment(segments, key, {
        mode: update.mode ?? prev.mode,
        pattern: update.pattern ?? prev.pattern,
    });
}

/** Default sensible pattern when no auto-fit reference is available
 *  (e.g. a fresh blank endpoint). */
export function blankPattern(): TunnelPattern {
    return {
        stepX: 1,
        stepY: 0,
        stepZ: 1,
        primaryAxis: "x",
        sequence: DEFAULT_SEQUENCE,
        padding: DEFAULT_PADDING,
        paddingDiagonal: DEFAULT_PADDING_DIAGONAL,
        useSlabs: DEFAULT_USE_SLABS,
    };
}
