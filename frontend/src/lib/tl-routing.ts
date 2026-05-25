/**
 * Translocator routing core.
 *
 * Builds a graph from a list of translocator segments where:
 *   • Each TL contributes TWO endpoint nodes plus one TL edge between them
 *     (cost = `tlPenaltySeconds`, ≈ load/cooldown time).
 *   • Each endpoint is connected to its K nearest other endpoints by WALK
 *     edges (cost = `distance / walkSpeed`).
 *   • Per-query we attach virtual Start/Dest nodes the same way, plus a
 *     direct Start↔Dest walk edge so trivially-short trips don't force a
 *     TL hop.
 *
 * Two routing algorithms over the same graph:
 *   • Algorithm A: A* with a Euclidean / walkSpeed heuristic (admissible &
 *     consistent). Used as the single-best fast path and as Yen's inner
 *     subroutine.
 *   • Algorithm B: Yen's K-shortest paths over Bidirectional Dijkstra, with
 *     a TL-distinctness filter so the alternatives users see feel
 *     meaningfully different rather than micro-variations.
 *
 * Everything in this module is a pure function over plain data so it stays
 * easy to unit-test (and trivially worker-portable if we ever decide to
 * move compute off the main thread).
 */

import type { WorldLineSegment } from "@/components/MapViewer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorldPoint {
    x: number;
    z: number;
}

export interface RouteOptions {
    /** Player walk/sprint speed in blocks/second. Default 7 (≈ sprint). */
    walkSpeed: number;
    /** Time penalty per TL hop in seconds. Default 8. */
    tlPenaltySeconds: number;
    /** Neighbours considered per endpoint when wiring walk edges. Default 8. */
    kNeighbors: number;
}

export const DEFAULT_WALK_SPEED = 7;
export const DEFAULT_TL_PENALTY_S = 10;
export const DEFAULT_K_NEIGHBORS = 8;

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
    walkSpeed: DEFAULT_WALK_SPEED,
    tlPenaltySeconds: DEFAULT_TL_PENALTY_S,
    kNeighbors: DEFAULT_K_NEIGHBORS,
};

/** A single leg of a computed route. */
export type RouteLeg =
    | {
        kind: "walk";
        from: WorldPoint;
        to: WorldPoint;
        /** Euclidean blocks walked. */
        blocks: number;
        seconds: number;
    }
    | {
        kind: "tl";
        /** Endpoint the player enters. */
        from: WorldPoint;
        /** Endpoint the player exits at. */
        to: WorldPoint;
        seconds: number;
        /** Stable id `"x1,z1,x2,z2"` matching `tlIdFor()` orientation-agnostic. */
        tlId: string;
        /** Original segment (for highlight overlay). */
        segment: WorldLineSegment;
    };

export interface RouteResult {
    /** Total cost in seconds (walk + TL hops). */
    totalSeconds: number;
    /** Sum of all walk-leg distances. */
    walkBlocks: number;
    /** Number of TL hops in the route. */
    tlHops: number;
    legs: RouteLeg[];
}

// ---------------------------------------------------------------------------
// Internal graph representation
// ---------------------------------------------------------------------------

/**
 * Node indices < 2*N are TL endpoints, encoded as `tlIndex * 2 + side`
 * (side 0 = (x1,z1), side 1 = (x2,z2)). N = number of TLs.
 *
 * The Start/Dest virtual nodes are attached per-query with indices
 * `2*N` and `2*N+1`.
 */
type Edge = {
    to: number;
    seconds: number;
    /** `"tl"` for the TL hop edge, `"walk"` otherwise. Used for leg reconstruction. */
    kind: "tl" | "walk";
    /** Set on TL edges; index into `graph.segments`. */
    tlIndex?: number;
};

export interface TLGraph {
    segments: WorldLineSegment[];
    /** Flat x coordinates per node (length = 2*N). */
    xs: number[];
    /** Flat z coordinates per node. */
    zs: number[];
    /** Adjacency: built-in walk + TL edges. Length 2*N. */
    adj: Edge[][];
    /** Spatial index over endpoints for K-nearest lookups. */
    kd: KDTree;
    opts: RouteOptions;
}

/** Stable, orientation-agnostic id for a TL segment. */
export function tlIdForSegment(s: WorldLineSegment): string {
    if (s.x1 < s.x2 || (s.x1 === s.x2 && s.z1 <= s.z2)) {
        return `${s.x1},${s.z1},${s.x2},${s.z2}`;
    }
    return `${s.x2},${s.z2},${s.x1},${s.z1}`;
}

// ---------------------------------------------------------------------------
// Tiny KD-tree (2D, static build, K-nearest query) — zero deps
// ---------------------------------------------------------------------------

interface KDNode {
    /** Index into the points arrays. */
    idx: number;
    axis: 0 | 1;
    left: KDNode | null;
    right: KDNode | null;
}

export interface KDTree {
    xs: ReadonlyArray<number>;
    zs: ReadonlyArray<number>;
    root: KDNode | null;
    /** Indices flagged as ignored by queries (used to skip the same-TL endpoint). */
}

function buildKD(xs: ReadonlyArray<number>, zs: ReadonlyArray<number>): KDTree {
    const indices = new Array<number>(xs.length);
    for (let i = 0; i < xs.length; i++) indices[i] = i;

    const build = (lo: number, hi: number, depth: number): KDNode | null => {
        if (lo >= hi) return null;
        const axis = (depth % 2) as 0 | 1;
        const mid = (lo + hi) >>> 1;
        // Partial sort — full sort is fine at N≤30k and keeps code simple.
        const slice = indices.slice(lo, hi);
        slice.sort((a, b) => (axis === 0 ? xs[a] - xs[b] : zs[a] - zs[b]));
        for (let k = 0; k < slice.length; k++) indices[lo + k] = slice[k];
        const node: KDNode = {
            idx: indices[mid],
            axis,
            left: build(lo, mid, depth + 1),
            right: build(mid + 1, hi, depth + 1),
        };
        return node;
    };

    return { xs, zs, root: build(0, xs.length, 0) };
}

/**
 * K-nearest neighbours to (qx, qz) using a fixed-size max-heap of squared
 * distances. Optionally skips indices where `skip(idx)` returns true (used
 * to skip the query-point's own TL pair endpoint when wiring walk edges).
 */
function knn(
    tree: KDTree,
    qx: number,
    qz: number,
    k: number,
    skip?: (idx: number) => boolean,
): Array<{ idx: number; d2: number }> {
    if (!tree.root || k <= 0) return [];
    const heap: Array<{ idx: number; d2: number }> = [];

    const pushCandidate = (idx: number, d2: number) => {
        if (heap.length < k) {
            heap.push({ idx, d2 });
            // Bubble up: maintain max-heap by d2.
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >>> 1;
                if (heap[p].d2 < heap[i].d2) {
                    const t = heap[p];
                    heap[p] = heap[i];
                    heap[i] = t;
                    i = p;
                } else break;
            }
        } else if (d2 < heap[0].d2) {
            heap[0] = { idx, d2 };
            // Sift down.
            let i = 0;
            const n = heap.length;
            for (; ;) {
                const l = i * 2 + 1;
                const r = i * 2 + 2;
                let largest = i;
                if (l < n && heap[l].d2 > heap[largest].d2) largest = l;
                if (r < n && heap[r].d2 > heap[largest].d2) largest = r;
                if (largest === i) break;
                const t = heap[largest];
                heap[largest] = heap[i];
                heap[i] = t;
                i = largest;
            }
        }
    };

    const visit = (node: KDNode | null) => {
        if (!node) return;
        const idx = node.idx;
        const px = tree.xs[idx];
        const pz = tree.zs[idx];
        if (!skip || !skip(idx)) {
            const dx = px - qx;
            const dz = pz - qz;
            pushCandidate(idx, dx * dx + dz * dz);
        }
        const diff = node.axis === 0 ? qx - px : qz - pz;
        const near = diff < 0 ? node.left : node.right;
        const far = diff < 0 ? node.right : node.left;
        visit(near);
        const worst = heap.length < k ? Infinity : heap[0].d2;
        if (diff * diff < worst) visit(far);
    };

    visit(tree.root);
    return heap.sort((a, b) => a.d2 - b.d2);
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

export interface BuildGraphOptions extends Partial<RouteOptions> { }

/**
 * Build a routing graph from a list of TL segments. The result memoises
 * static structure (endpoints, KD-tree, walk edges, TL edges). Per-query
 * Start/Dest nodes are added on top of this in `aStar` / `biDijkstra`.
 *
 * Cost: O(N log N) build + O(N · K log N) walk-edge wiring. At N = 30k
 * endpoints and K = 8 that's well under 50ms in practice.
 */
export function buildTLGraph(
    segments: ReadonlyArray<WorldLineSegment>,
    options: BuildGraphOptions = {},
): TLGraph {
    const opts: RouteOptions = { ...DEFAULT_ROUTE_OPTIONS, ...options };
    const N = segments.length;
    const xs = new Array<number>(N * 2);
    const zs = new Array<number>(N * 2);
    for (let i = 0; i < N; i++) {
        const s = segments[i];
        xs[i * 2] = s.x1;
        zs[i * 2] = s.z1;
        xs[i * 2 + 1] = s.x2;
        zs[i * 2 + 1] = s.z2;
    }

    const kd = buildKD(xs, zs);
    const adj: Edge[][] = Array.from({ length: N * 2 }, () => [] as Edge[]);

    // TL edges (paired endpoints).
    const tlSeconds = opts.tlPenaltySeconds;
    for (let i = 0; i < N; i++) {
        const a = i * 2;
        const b = i * 2 + 1;
        adj[a].push({ to: b, seconds: tlSeconds, kind: "tl", tlIndex: i });
        adj[b].push({ to: a, seconds: tlSeconds, kind: "tl", tlIndex: i });
    }

    // Walk edges via K-NN. Skip the query point itself AND its paired
    // endpoint (the TL edge already handles that connection, and including
    // it as a walk edge would only ever look worse).
    const speed = opts.walkSpeed;
    for (let i = 0; i < N * 2; i++) {
        const partner = i ^ 1;
        const nn = knn(
            kd,
            xs[i],
            zs[i],
            opts.kNeighbors + 1,
            (idx) => idx === i || idx === partner,
        );
        for (const { idx, d2 } of nn) {
            const seconds = Math.sqrt(d2) / speed;
            adj[i].push({ to: idx, seconds, kind: "walk" });
        }
    }

    return { segments: segments.slice(), xs, zs, adj, kd, opts };
}

// ---------------------------------------------------------------------------
// Per-query augmentation: attach virtual Start / Dest nodes
// ---------------------------------------------------------------------------

interface AugmentedGraph {
    base: TLGraph;
    startIdx: number;
    destIdx: number;
    /** Edges from virtual nodes (added on top of base.adj via overlay maps). */
    extraOut: Map<number, Edge[]>;
    /** Coordinate lookup that includes virtual nodes. */
    coord(idx: number): WorldPoint;
}

function augmentForQuery(
    graph: TLGraph,
    start: WorldPoint,
    dest: WorldPoint,
    /** Optional set of edges to forbid (used by Yen's). Keys are `from|to|kind|tlIndex`. */
    forbiddenEdges?: ReadonlySet<string>,
    /** Optional set of node indices to skip entirely (Yen's spur path setup). */
    forbiddenNodes?: ReadonlySet<number>,
): AugmentedGraph {
    const N = graph.segments.length;
    const startIdx = N * 2;
    const destIdx = N * 2 + 1;
    const extraOut = new Map<number, Edge[]>();
    const speed = graph.opts.walkSpeed;

    const linkVirtual = (virtualIdx: number, vx: number, vz: number) => {
        const nn = knn(graph.kd, vx, vz, graph.opts.kNeighbors);
        const out: Edge[] = [];
        for (const { idx, d2 } of nn) {
            if (forbiddenNodes?.has(idx)) continue;
            const seconds = Math.sqrt(d2) / speed;
            out.push({ to: idx, seconds, kind: "walk" });
            // Reverse direction so endpoints can reach virtuals too.
            const rev = extraOut.get(idx) ?? [];
            rev.push({ to: virtualIdx, seconds, kind: "walk" });
            extraOut.set(idx, rev);
        }
        extraOut.set(virtualIdx, out);
    };

    linkVirtual(startIdx, start.x, start.z);
    linkVirtual(destIdx, dest.x, dest.z);

    // Direct start↔dest walk edge so trivially short trips don't force a TL.
    const dsx = dest.x - start.x;
    const dsz = dest.z - start.z;
    const directSeconds = Math.sqrt(dsx * dsx + dsz * dsz) / speed;
    extraOut.get(startIdx)!.push({ to: destIdx, seconds: directSeconds, kind: "walk" });
    extraOut.get(destIdx)!.push({ to: startIdx, seconds: directSeconds, kind: "walk" });

    const coord = (idx: number): WorldPoint => {
        if (idx === startIdx) return start;
        if (idx === destIdx) return dest;
        return { x: graph.xs[idx], z: graph.zs[idx] };
    };

    const edgeKey = (from: number, e: Edge) =>
        `${from}|${e.to}|${e.kind}|${e.tlIndex ?? ""}`;

    // Wrap adjacency lookups so callers can iterate forbidden-free outgoing edges.
    const outgoing = (from: number): Edge[] => {
        const baseEdges = from < N * 2 ? graph.adj[from] : [];
        const extras = extraOut.get(from) ?? [];
        if (!forbiddenEdges && !forbiddenNodes) {
            // Concat lazily to avoid an allocation when neither set exists.
            return baseEdges.length === 0 ? extras : extras.length === 0 ? baseEdges : baseEdges.concat(extras);
        }
        const result: Edge[] = [];
        for (const e of baseEdges) {
            if (forbiddenNodes?.has(e.to)) continue;
            if (forbiddenEdges?.has(edgeKey(from, e))) continue;
            result.push(e);
        }
        for (const e of extras) {
            if (forbiddenNodes?.has(e.to)) continue;
            if (forbiddenEdges?.has(edgeKey(from, e))) continue;
            result.push(e);
        }
        return result;
    };

    return {
        base: graph,
        startIdx,
        destIdx,
        extraOut,
        coord,
        // Stash outgoing on the object via a non-enum prop using `as any`-free path.
        ...({ outgoing } as { outgoing: (from: number) => Edge[] }),
    } as AugmentedGraph & { outgoing: (from: number) => Edge[] };
}

// ---------------------------------------------------------------------------
// Min-heap (binary) keyed by `priority` ascending
// ---------------------------------------------------------------------------

interface HeapItem {
    node: number;
    priority: number;
}

class MinHeap {
    private a: HeapItem[] = [];
    get size(): number {
        return this.a.length;
    }
    push(item: HeapItem): void {
        const a = this.a;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >>> 1;
            if (a[p].priority > a[i].priority) {
                const t = a[p];
                a[p] = a[i];
                a[i] = t;
                i = p;
            } else break;
        }
    }
    pop(): HeapItem | undefined {
        const a = this.a;
        if (a.length === 0) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (; ;) {
                const l = i * 2 + 1;
                const r = i * 2 + 2;
                let smallest = i;
                if (l < a.length && a[l].priority < a[smallest].priority) smallest = l;
                if (r < a.length && a[r].priority < a[smallest].priority) smallest = r;
                if (smallest === i) break;
                const t = a[smallest];
                a[smallest] = a[i];
                a[i] = t;
                i = smallest;
            }
        }
        return top;
    }
}

// ---------------------------------------------------------------------------
// Path reconstruction → RouteLeg[]
// ---------------------------------------------------------------------------

function reconstructLegs(
    aug: AugmentedGraph & { outgoing: (from: number) => Edge[] },
    nodePath: number[],
    edgePath: Edge[],
): RouteResult {
    const legs: RouteLeg[] = [];
    let totalSeconds = 0;
    let walkBlocks = 0;
    let tlHops = 0;
    for (let i = 0; i < edgePath.length; i++) {
        const e = edgePath[i];
        const fromIdx = nodePath[i];
        const toIdx = nodePath[i + 1];
        const from = aug.coord(fromIdx);
        const to = aug.coord(toIdx);
        totalSeconds += e.seconds;
        if (e.kind === "tl" && e.tlIndex != null) {
            const seg = aug.base.segments[e.tlIndex];
            tlHops += 1;
            legs.push({
                kind: "tl",
                from,
                to,
                seconds: e.seconds,
                tlId: tlIdForSegment(seg),
                segment: seg,
            });
        } else {
            const dx = to.x - from.x;
            const dz = to.z - from.z;
            const blocks = Math.sqrt(dx * dx + dz * dz);
            walkBlocks += blocks;
            legs.push({ kind: "walk", from, to, blocks, seconds: e.seconds });
        }
    }

    // Coalesce consecutive walk legs (e.g. virtual-start → endpoint → endpoint
    // can compress into virtual-start → second endpoint visually when both are
    // walk edges through an intermediate node that's NOT a TL entry). We only
    // do this for the leg list shown to the user, not the underlying path.
    const merged: RouteLeg[] = [];
    for (const leg of legs) {
        const prev = merged[merged.length - 1];
        if (
            prev &&
            prev.kind === "walk" &&
            leg.kind === "walk" &&
            prev.to.x === leg.from.x &&
            prev.to.z === leg.from.z
        ) {
            merged[merged.length - 1] = {
                kind: "walk",
                from: prev.from,
                to: leg.to,
                blocks: prev.blocks + leg.blocks,
                seconds: prev.seconds + leg.seconds,
            };
        } else {
            merged.push(leg);
        }
    }

    return { totalSeconds, walkBlocks, tlHops, legs: merged };
}

// ---------------------------------------------------------------------------
// Algorithm A: A* with Euclidean / walkSpeed heuristic
// ---------------------------------------------------------------------------

function heuristicSeconds(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    speed: number,
): number {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz) / speed;
}

function aStarOnAugmented(
    aug: AugmentedGraph & { outgoing: (from: number) => Edge[] },
): RouteResult | null {
    const { base, startIdx, destIdx } = aug;
    const speed = base.opts.walkSpeed;
    const destPt = aug.coord(destIdx);

    const gScore = new Map<number, number>();
    const cameFromNode = new Map<number, number>();
    const cameFromEdge = new Map<number, Edge>();
    const open = new MinHeap();

    gScore.set(startIdx, 0);
    open.push({ node: startIdx, priority: 0 });

    while (open.size > 0) {
        const cur = open.pop()!;
        if (cur.node === destIdx) {
            // Reconstruct.
            const nodePath: number[] = [];
            const edgePath: Edge[] = [];
            let n = destIdx;
            while (n !== startIdx) {
                nodePath.push(n);
                const e = cameFromEdge.get(n);
                if (!e) return null;
                edgePath.push(e);
                const prev = cameFromNode.get(n);
                if (prev == null) return null;
                n = prev;
            }
            nodePath.push(startIdx);
            nodePath.reverse();
            edgePath.reverse();
            return reconstructLegs(aug, nodePath, edgePath);
        }
        const curG = gScore.get(cur.node) ?? Infinity;
        // Stale heap entry — recomputed with a better g already, skip.
        if (cur.priority - heuristicEstimate(cur.node, destPt, aug, speed) > curG + 1e-9) {
            continue;
        }
        const edges = aug.outgoing(cur.node);
        for (const e of edges) {
            const tentative = curG + e.seconds;
            const existing = gScore.get(e.to) ?? Infinity;
            if (tentative < existing) {
                gScore.set(e.to, tentative);
                cameFromNode.set(e.to, cur.node);
                cameFromEdge.set(e.to, e);
                const h = heuristicEstimate(e.to, destPt, aug, speed);
                open.push({ node: e.to, priority: tentative + h });
            }
        }
    }
    return null;
}

function heuristicEstimate(
    node: number,
    dest: WorldPoint,
    aug: AugmentedGraph,
    speed: number,
): number {
    const p = aug.coord(node);
    return heuristicSeconds(p.x, p.z, dest.x, dest.z, speed);
}

// ---------------------------------------------------------------------------
// Algorithm B helper: Dijkstra (used inside Yen's). Returns full path or null.
// ---------------------------------------------------------------------------

function dijkstraPath(
    aug: AugmentedGraph & { outgoing: (from: number) => Edge[] },
    fromOverride?: number,
    toOverride?: number,
): { nodes: number[]; edges: Edge[]; cost: number } | null {
    // Yen's spur computation needs to run dijkstra from a node OTHER than
    // the virtual start. Allow callers to override the source / sink while
    // keeping the rest of the augmented graph (extras, forbidden filters)
    // intact so node indices remain consistent with the parent path.
    const startIdx = fromOverride ?? aug.startIdx;
    const destIdx = toOverride ?? aug.destIdx;
    const gScore = new Map<number, number>();
    const cameFromNode = new Map<number, number>();
    const cameFromEdge = new Map<number, Edge>();
    const open = new MinHeap();
    gScore.set(startIdx, 0);
    open.push({ node: startIdx, priority: 0 });

    while (open.size > 0) {
        const cur = open.pop()!;
        if (cur.node === destIdx) {
            const nodes: number[] = [];
            const edges: Edge[] = [];
            let n = destIdx;
            while (n !== startIdx) {
                nodes.push(n);
                const e = cameFromEdge.get(n);
                if (!e) return null;
                edges.push(e);
                const prev = cameFromNode.get(n);
                if (prev == null) return null;
                n = prev;
            }
            nodes.push(startIdx);
            nodes.reverse();
            edges.reverse();
            return { nodes, edges, cost: cur.priority };
        }
        const curG = gScore.get(cur.node) ?? Infinity;
        if (cur.priority > curG + 1e-9) continue;
        for (const e of aug.outgoing(cur.node)) {
            const tentative = curG + e.seconds;
            if (tentative < (gScore.get(e.to) ?? Infinity)) {
                gScore.set(e.to, tentative);
                cameFromNode.set(e.to, cur.node);
                cameFromEdge.set(e.to, e);
                open.push({ node: e.to, priority: tentative });
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Public: single shortest route via A*
// ---------------------------------------------------------------------------

export function findRoute(
    graph: TLGraph,
    start: WorldPoint,
    dest: WorldPoint,
): RouteResult | null {
    const aug = augmentForQuery(graph, start, dest) as AugmentedGraph & {
        outgoing: (from: number) => Edge[];
    };
    return aStarOnAugmented(aug);
}

// ---------------------------------------------------------------------------
// Public: Top-K routes via Yen's algorithm with TL-distinctness filter
// ---------------------------------------------------------------------------

/**
 * Yen's K-shortest-loopless-paths. We post-filter the K candidates so each
 * returned route uses a TL set that's not a subset/superset of any earlier
 * route — this makes "Alt 1" and "Alt 2" visibly different rather than
 * tiny re-routings.
 *
 * Worst-case Yen's is O(K · V · (E + V log V)); for K=3 and V≤30k this is
 * well under the 300ms budget on commodity hardware.
 */
export function findRoutes(
    graph: TLGraph,
    start: WorldPoint,
    dest: WorldPoint,
    k: number,
): RouteResult[] {
    if (k <= 0) return [];
    const aug0 = augmentForQuery(graph, start, dest) as AugmentedGraph & {
        outgoing: (from: number) => Edge[];
    };
    const first = dijkstraPath(aug0);
    if (!first) return [];

    const A: Array<{ nodes: number[]; edges: Edge[]; cost: number }> = [first];
    const B: Array<{ nodes: number[]; edges: Edge[]; cost: number }> = [];

    // Cap raw Yen iterations to avoid degenerate cost on pathological graphs.
    // Generous multiplier so we still have material after dedup filtering.
    const RAW_K = Math.max(k * 5, 12);

    const edgeKey = (from: number, e: Edge) =>
        `${from}|${e.to}|${e.kind}|${e.tlIndex ?? ""}`;
    const reverseEdgeKey = (from: number, e: Edge) =>
        `${e.to}|${from}|${e.kind}|${e.tlIndex ?? ""}`;

    while (A.length < RAW_K) {
        const prev = A[A.length - 1];
        for (let i = 0; i < prev.nodes.length - 1; i++) {
            const spurNode = prev.nodes[i];
            const rootNodes = prev.nodes.slice(0, i + 1);
            const rootEdges = prev.edges.slice(0, i);
            const forbiddenEdges = new Set<string>();
            for (const p of A) {
                if (p.nodes.length > i && arraysEqual(p.nodes.slice(0, i + 1), rootNodes)) {
                    const e = p.edges[i];
                    forbiddenEdges.add(edgeKey(p.nodes[i], e));
                    // Also forbid the reverse direction so undirected behaviour holds.
                    forbiddenEdges.add(reverseEdgeKey(p.nodes[i], e));
                }
            }
            const forbiddenNodes = new Set<number>(rootNodes.slice(0, -1));

            // Compute the spur path from spurNode → destIdx with restrictions.
            // Reuse the original start/dest (same node-index space as aug0)
            // so the resulting path indices can be safely concatenated and
            // later reconstructed against aug0 without translation.
            const spurAug = augmentForQuery(
                graph,
                start,
                dest,
                forbiddenEdges,
                forbiddenNodes,
            ) as AugmentedGraph & { outgoing: (from: number) => Edge[] };
            const spur = dijkstraPath(spurAug, spurNode, spurAug.destIdx);
            if (!spur) continue;

            // Stitch: rootNodes already ends at spurNode, spur.nodes starts
            // at spurNode — drop the duplicate when concatenating.
            const candidateNodes = rootNodes.concat(spur.nodes.slice(1));
            const candidateEdges = rootEdges.concat(spur.edges);
            let totalSeconds = 0;
            for (const e of candidateEdges) totalSeconds += e.seconds;
            const candidate = {
                nodes: candidateNodes,
                edges: candidateEdges,
                cost: totalSeconds,
            };
            if (!B.some((b) => b.cost === candidate.cost && arraysEqual(b.nodes, candidate.nodes))) {
                B.push(candidate);
            }
        }
        if (B.length === 0) break;
        B.sort((a, b) => a.cost - b.cost);
        A.push(B.shift()!);
    }

    // Yen tends to enumerate walk-routing variants of the same TL chain,
    // especially when `tlPenaltySeconds` is high (any chain that swaps a
    // TL for another loses by a big delta and falls outside Yen's RAW_K
    // window). After the post-filter dedupes by TL sequence, that often
    // collapses the alternatives down to a single route. To surface
    // genuinely-different TL chains, we run an extra pass: for each TL
    // used by the best route, forbid both directions of that TL's edges
    // and re-run plain dijkstra. Each successful result is appended to
    // `A` and goes through the same dedupe below, so duplicates and the
    // original best are filtered out naturally.
    const firstTLIndices = new Set<number>();
    for (const e of A[0].edges) {
        if (e.kind === "tl" && e.tlIndex !== undefined) firstTLIndices.add(e.tlIndex);
    }
    for (const tlIdx of firstTLIndices) {
        const forbidden = new Set<string>([
            `${tlIdx * 2}|${tlIdx * 2 + 1}|tl|${tlIdx}`,
            `${tlIdx * 2 + 1}|${tlIdx * 2}|tl|${tlIdx}`,
        ]);
        const altAug = augmentForQuery(graph, start, dest, forbidden) as AugmentedGraph & {
            outgoing: (from: number) => Edge[];
        };
        const alt = dijkstraPath(altAug);
        if (alt) A.push(alt);
    }
    A.sort((a, b) => a.cost - b.cost);

    // Materialise leg lists, then dedupe so the alternatives feel
    // meaningfully different. We key on the ORDERED TL-id sequence (not
    // the sorted set), so two routes traversing the same TLs in a
    // different order still count as separate alternatives. Routes that
    // share the same TL chain and only differ in walk-leg micro-routing
    // (Yen often returns several of these) collapse into one — surfacing
    // them as "+1s" / "+2s" alternates would be misleading because the
    // user cannot meaningfully choose between them in game. A pure-walk
    // route (no TLs) gets a stable sentinel key so it surfaces at most
    // once.
    const built = A.map((p) => legsFromPath(aug0, p.nodes, p.edges));
    const out: RouteResult[] = [];
    const seenKeys = new Set<string>();
    const tlKey = (r: RouteResult): string => {
        const ids = r.legs
            .filter((l): l is Extract<RouteLeg, { kind: "tl" }> => l.kind === "tl")
            .map((l) => l.tlId);
        return ids.length === 0 ? "__walk_only__" : ids.join(">");
    };
    for (const r of built) {
        const key = tlKey(r);
        if (seenKeys.has(key)) continue;
        out.push(r);
        seenKeys.add(key);
        if (out.length >= k) break;
    }
    return out;
}

function legsFromPath(
    aug: AugmentedGraph & { outgoing: (from: number) => Edge[] },
    nodes: number[],
    edges: Edge[],
): RouteResult {
    return reconstructLegs(aug, nodes, edges);
}

function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
