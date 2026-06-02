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
 * Internals are CSR-shaped (parallel typed arrays, integer edge IDs) so
 * the inner Dijkstra/A* loops avoid per-edge object allocation and Yen's
 * forbidden-edge tracking is a `Uint8Array` mask rather than a string set.
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
    /** When true, the planner *prefers* walk edges between TL endpoints
     *  that the community has confirmed are safely traversable by an elk
     *  (no chasm, shore, acid pool, etc). Non-confirmed inter-TL walks
     *  stay routable but accrue an elk-climbing overhead based on how
     *  far below `elkDepthBaselineY` (default y=130) each endpoint sits.
     *  Default false. */
    elkFriendlyOnly?: boolean;
    /** Canonical-key set of elk-walkable edges. Used both to filter walk
     *  edges (when `elkFriendlyOnly` is on) and to inject confirmed edges
     *  the K-nearest wiring would otherwise miss. */
    confirmedElkEdges?: ReadonlySet<string>;
}

export const DEFAULT_WALK_SPEED = 7;
export const DEFAULT_TL_PENALTY_S = 15;
export const DEFAULT_K_NEIGHBORS = 8;
/** Surface-ish baseline. Endpoints at/above this y level pay only the
 *  small fixed minimum overhead; endpoints below pay proportionally more. */
export const DEFAULT_ELK_DEPTH_BASELINE_Y = 110;
/** Seconds of elk-climbing overhead per 30-block chunk (rounded up)
 *  below `DEFAULT_ELK_DEPTH_BASELINE_Y`. Charged once per endpoint
 *  involved in an unverified inter-TL walk. */
export const DEFAULT_ELK_PENALTY_PER_30_BLOCKS_S = 80;
/** Minimum per-endpoint overhead charged when a TL endpoint sits at or
 *  above the baseline y — leading an elk still has some unavoidable
 *  setup cost (loading, leashing, navigating doorways). */
export const DEFAULT_ELK_MIN_PENALTY_S = 40;
/** Fallback per-endpoint overhead used when a TL has no recorded y
 *  (user-contributed TLs only carry 2D coordinates). */
export const DEFAULT_ELK_UNKNOWN_Y_PENALTY_S = 250;

/** Per-endpoint elk-overhead in seconds. Endpoints with no recorded y
 *  fall back to `DEFAULT_ELK_UNKNOWN_Y_PENALTY_S`. Endpoints at or
 *  above `DEFAULT_ELK_DEPTH_BASELINE_Y` pay `DEFAULT_ELK_MIN_PENALTY_S`.
 *  Deeper endpoints add `ceil((baseline - y) / 30) * 50` seconds. */
export function elkEndpointOverheadSeconds(y: number | undefined): number {
    if (y == null) return DEFAULT_ELK_UNKNOWN_Y_PENALTY_S;
    const depth = DEFAULT_ELK_DEPTH_BASELINE_Y - y;
    if (depth <= 0) return DEFAULT_ELK_MIN_PENALTY_S;
    return Math.ceil(depth / 30) * DEFAULT_ELK_PENALTY_PER_30_BLOCKS_S;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
    walkSpeed: DEFAULT_WALK_SPEED,
    tlPenaltySeconds: DEFAULT_TL_PENALTY_S,
    kNeighbors: DEFAULT_K_NEIGHBORS,
    elkFriendlyOnly: false,
    confirmedElkEdges: undefined,
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
        /** Portion of `seconds` that comes from the elk-prefer penalty on
         *  unverified inter-TL walks. The actual physical traversal cost
         *  is `seconds - penaltySeconds`; the rest is a worst-case
         *  estimate of the extra effort to lead an elk through an
         *  unconfirmed passage. Zero/absent on confirmed walks and on
         *  start/dest walks. */
        penaltySeconds?: number;
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
    /** Total cost in seconds (walk + TL hops), penalty included. */
    totalSeconds: number;
    /** Portion of `totalSeconds` that comes from the elk-prefer penalty
     *  on unverified inter-TL walks. Zero when the toggle is off or the
     *  route uses only confirmed elk-walkable walks. UI can render the
     *  ETA as a range `[totalSeconds - uncertainSeconds, totalSeconds]`
     *  to communicate that the upper bound is a worst-case estimate. */
    uncertainSeconds: number;
    /** Sum of all walk-leg distances. */
    walkBlocks: number;
    /** Number of TL hops in the route. */
    tlHops: number;
    legs: RouteLeg[];
}

// ---------------------------------------------------------------------------
// Internal CSR graph representation
// ---------------------------------------------------------------------------
//
// Node indices < 2*N are TL endpoints, encoded as `tlIndex * 2 + side`
// (side 0 = (x1,z1), side 1 = (x2,z2)). N = number of TLs. The Start/
// Dest virtual nodes are attached per-query at indices `2*N` and `2*N+1`.
//
// Edges are stored in a single Compressed-Sparse-Row block of typed
// arrays. For node `u`, outgoing edges are at indices
// `[baseHead[u], baseHead[u+1])`. Each edge `eid` has parallel fields
// `baseTo[eid]`, `baseSec[eid]`, `baseKindTlIdx[eid]`, `basePenalty[eid]`.
//
// `baseKindTlIdx` packs both edge kind and TL index into one int:
//   • >= 0 ⇒ TL edge with that tlIndex
//   • -1   ⇒ plain walk edge
//   • -2   ⇒ confirmed elk-walkable walk edge

const KIND_WALK = -1;
const KIND_WALK_ELK = -2;

export interface TLGraph {
    segments: WorldLineSegment[];
    /** Number of nodes (= 2 * segments.length). */
    numNodes: number;
    /** Flat x/z coordinates per node. */
    xs: Float64Array;
    zs: Float64Array;

    // CSR adjacency (length = numNodes + 1, with `baseHead[numNodes]` =
    // total edge count).
    baseHead: Int32Array;
    baseTo: Int32Array;
    baseSec: Float64Array;
    /** See packing rules above. */
    baseKindTlIdx: Int32Array;
    /** 0 if the edge has no soft elk-prefer penalty. */
    basePenalty: Float64Array;
    /** Total number of base edges (= baseHead[numNodes]). */
    baseEdgeCount: number;

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
    xs: ArrayLike<number>;
    zs: ArrayLike<number>;
    root: KDNode | null;
}

function buildKD(xs: ArrayLike<number>, zs: ArrayLike<number>): KDTree {
    const n = xs.length;
    const indices = new Array<number>(n);
    for (let i = 0; i < n; i++) indices[i] = i;

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

    return { xs, zs, root: build(0, n, 0) };
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
    const numNodes = N * 2;
    const xs = new Float64Array(numNodes);
    const zs = new Float64Array(numNodes);
    for (let i = 0; i < N; i++) {
        const s = segments[i];
        xs[i * 2] = s.x1;
        zs[i * 2] = s.z1;
        xs[i * 2 + 1] = s.x2;
        zs[i * 2 + 1] = s.z2;
    }

    const kd = buildKD(xs, zs);

    // First pass: gather all (u, v, seconds, kindTlIdx, penalty) records
    // in plain JS arrays so we don't need to know the per-node degree
    // ahead of time. Second pass converts to CSR.
    const tlSeconds = opts.tlPenaltySeconds;
    const elkSet = opts.confirmedElkEdges;
    const preferElk = opts.elkFriendlyOnly === true;

    // Per-endpoint elk-climbing overhead. Computed once: depends only on
    // the endpoint's y, not on which neighbour is being wired.
    const endpointOverhead: number[] = preferElk ? new Array(numNodes) : [];
    if (preferElk) {
        for (let i = 0; i < N; i++) {
            const s = segments[i];
            endpointOverhead[i * 2] = elkEndpointOverheadSeconds(s.y1);
            endpointOverhead[i * 2 + 1] = elkEndpointOverheadSeconds(s.y2);
        }
    }

    /** Build the canonical elk key for the walk edge between two endpoint
     *  indices, or `null` when either endpoint has no stable TL id. */
    const elkKeyForEndpoints = (a: number, b: number): string | null => {
        if (!elkSet) return null;
        const tlA = segments[a >>> 1]?.id;
        const tlB = segments[b >>> 1]?.id;
        if (!tlA || !tlB) return null;
        const epA = (a & 1) as 0 | 1;
        const epB = (b & 1) as 0 | 1;
        const tokA = `${tlA}:${epA}`;
        const tokB = `${tlB}:${epB}`;
        if (tokA === tokB) return null;
        return tokA < tokB ? `${tokA}|${tokB}` : `${tokB}|${tokA}`;
    };

    // Outgoing edge buckets per node. We accumulate then flatten to CSR.
    const outTo: number[][] = new Array(numNodes);
    const outSec: number[][] = new Array(numNodes);
    const outKind: number[][] = new Array(numNodes);
    const outPen: number[][] = new Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
        outTo[i] = [];
        outSec[i] = [];
        outKind[i] = [];
        outPen[i] = [];
    }

    const addEdge = (u: number, v: number, seconds: number, kindTlIdx: number, penalty: number) => {
        outTo[u].push(v);
        outSec[u].push(seconds);
        outKind[u].push(kindTlIdx);
        outPen[u].push(penalty);
    };

    // TL edges (paired endpoints).
    for (let i = 0; i < N; i++) {
        const a = i * 2;
        const b = i * 2 + 1;
        addEdge(a, b, tlSeconds, i, 0);
        addEdge(b, a, tlSeconds, i, 0);
    }

    // Walk edges via K-NN. Skip the query point itself AND its paired
    // endpoint (the TL edge already handles that connection, and including
    // it as a walk edge would only ever look worse).
    const speed = opts.walkSpeed;
    /** Track keys already added so the "inject missing confirmed edges"
     *  pass below doesn't double-wire any K-NN neighbours we already saw. */
    const seenWalkEdges = elkSet ? new Set<string>() : null;
    for (let i = 0; i < numNodes; i++) {
        const partner = i ^ 1;
        const nn = knn(
            kd,
            xs[i],
            zs[i],
            opts.kNeighbors + 1,
            (idx) => idx === i || idx === partner,
        );
        for (const { idx, d2 } of nn) {
            const baseSeconds = Math.sqrt(d2) / speed;
            const elkKey = elkKeyForEndpoints(i, idx);
            const isElk = elkKey !== null && elkSet!.has(elkKey);
            // Soft preference: unverified inter-TL walks are still routable
            // but pay an elk-climbing overhead equal to the sum of both
            // endpoints' depth-based costs (or a fallback for endpoints
            // with no recorded y). Confirmed walks pay nothing.
            const edgePenalty = preferElk && !isElk
                ? endpointOverhead[i] + endpointOverhead[idx]
                : 0;
            const seconds = baseSeconds + edgePenalty;
            addEdge(i, idx, seconds, isElk ? KIND_WALK_ELK : KIND_WALK, edgePenalty);
            if (seenWalkEdges && elkKey) {
                seenWalkEdges.add(`${Math.min(i, idx)}|${Math.max(i, idx)}`);
            }
        }
    }

    // Inject any community-confirmed elk edges that K-nearest missed.
    // Without this, a far-but-confirmed link (e.g. a long hand-checked
    // path between two distant TLs) would silently disappear from the
    // elk-only graph and the planner would report "no route".
    if (elkSet && elkSet.size > 0) {
        // Build TL-id → array of endpoint indices once, so injection is
        // O(elkSet.size) instead of O(elkSet.size · N).
        const idToEndpoints = new Map<string, number[]>();
        for (let i = 0; i < N; i++) {
            const id = segments[i].id;
            if (!id) continue;
            const list = idToEndpoints.get(id);
            if (list) list.push(i * 2, i * 2 + 1);
            else idToEndpoints.set(id, [i * 2, i * 2 + 1]);
        }
        for (const key of elkSet) {
            const sep = key.indexOf("|");
            if (sep < 0) continue;
            const lo = key.slice(0, sep);
            const hi = key.slice(sep + 1);
            const splitTok = (t: string): { id: string; ep: 0 | 1 } | null => {
                const j = t.lastIndexOf(":");
                if (j < 0) return null;
                const epNum = Number(t.slice(j + 1));
                if (epNum !== 0 && epNum !== 1) return null;
                return { id: t.slice(0, j), ep: epNum };
            };
            const a = splitTok(lo);
            const b = splitTok(hi);
            if (!a || !b) continue;
            const aEndpoints = idToEndpoints.get(a.id);
            const bEndpoints = idToEndpoints.get(b.id);
            if (!aEndpoints || !bEndpoints) continue;
            // A TL may appear multiple times in the segment list (e.g.
            // mis-imported duplicates); link every instance pair so the
            // graph doesn't silently drop the confirmation for some.
            for (const aIdx of aEndpoints.filter((idx) => (idx & 1) === a.ep)) {
                for (const bIdx of bEndpoints.filter((idx) => (idx & 1) === b.ep)) {
                    if (aIdx === bIdx) continue;
                    const seenKey = `${Math.min(aIdx, bIdx)}|${Math.max(aIdx, bIdx)}`;
                    if (seenWalkEdges?.has(seenKey)) continue;
                    seenWalkEdges?.add(seenKey);
                    const dx = xs[aIdx] - xs[bIdx];
                    const dz = zs[aIdx] - zs[bIdx];
                    const seconds = Math.sqrt(dx * dx + dz * dz) / speed;
                    addEdge(aIdx, bIdx, seconds, KIND_WALK_ELK, 0);
                    addEdge(bIdx, aIdx, seconds, KIND_WALK_ELK, 0);
                }
            }
        }
    }

    // Flatten to CSR.
    let total = 0;
    for (let i = 0; i < numNodes; i++) total += outTo[i].length;
    const baseHead = new Int32Array(numNodes + 1);
    const baseTo = new Int32Array(total);
    const baseSec = new Float64Array(total);
    const baseKindTlIdx = new Int32Array(total);
    const basePenalty = new Float64Array(total);
    let cursor = 0;
    for (let i = 0; i < numNodes; i++) {
        baseHead[i] = cursor;
        const tos = outTo[i];
        const secs = outSec[i];
        const kinds = outKind[i];
        const pens = outPen[i];
        for (let j = 0; j < tos.length; j++) {
            baseTo[cursor] = tos[j];
            baseSec[cursor] = secs[j];
            baseKindTlIdx[cursor] = kinds[j];
            basePenalty[cursor] = pens[j];
            cursor++;
        }
    }
    baseHead[numNodes] = cursor;

    return {
        segments: segments.slice(),
        numNodes,
        xs,
        zs,
        baseHead,
        baseTo,
        baseSec,
        baseKindTlIdx,
        basePenalty,
        baseEdgeCount: cursor,
        kd,
        opts,
    };
}

// ---------------------------------------------------------------------------
// Per-query augmentation: attach virtual Start / Dest nodes
// ---------------------------------------------------------------------------
//
// We don't rebuild CSR for the augmented graph — extras live in side
// arrays indexed by `extraId = eid - baseEdgeCount`. Outgoing-edge
// iteration walks the base CSR slice (when the source is a non-virtual
// node) followed by the extras list for that node.

interface AugmentedGraph {
    base: TLGraph;
    startIdx: number;
    destIdx: number;
    /** Total node count including the two virtuals. */
    numNodes: number;

    // Extra edge fields (one entry per appended edge).
    extraTo: Int32Array;
    extraSec: Float64Array;
    extraKindTlIdx: Int32Array;
    extraPenalty: Float64Array;
    /** Number of populated entries in the extra arrays. */
    extraCount: number;
    /** Per-source-node list of extra edge IDs (full-space, i.e. >=
     *  baseEdgeCount). */
    extrasBySource: Map<number, number[]>;
    /** baseEdgeCount + extra capacity. Used to size forbidden masks. */
    edgeCapacity: number;

    coord(idx: number): WorldPoint;
}

function augmentForQuery(
    graph: TLGraph,
    start: WorldPoint,
    dest: WorldPoint,
): AugmentedGraph {
    const numBase = graph.numNodes;
    const startIdx = numBase;
    const destIdx = numBase + 1;
    const speed = graph.opts.walkSpeed;
    const k = graph.opts.kNeighbors;

    // Worst case: 2 virtuals * (k neighbours both directions = 2k each)
    // + 1 direct start↔dest * 2. Allocate generously to avoid resizes.
    const cap = 4 * k + 2 + 4;
    const extraTo = new Int32Array(cap);
    const extraSec = new Float64Array(cap);
    const extraKindTlIdx = new Int32Array(cap);
    const extraPenalty = new Float64Array(cap);
    let extraCount = 0;
    const extrasBySource = new Map<number, number[]>();

    const appendEdge = (from: number, to: number, seconds: number) => {
        const localId = extraCount;
        extraTo[localId] = to;
        extraSec[localId] = seconds;
        extraKindTlIdx[localId] = KIND_WALK;
        extraPenalty[localId] = 0;
        extraCount++;
        const eid = graph.baseEdgeCount + localId;
        const list = extrasBySource.get(from);
        if (list) list.push(eid);
        else extrasBySource.set(from, [eid]);
    };

    const linkVirtual = (virtualIdx: number, vx: number, vz: number) => {
        const nn = knn(graph.kd, vx, vz, k);
        for (const { idx, d2 } of nn) {
            const seconds = Math.sqrt(d2) / speed;
            appendEdge(virtualIdx, idx, seconds);
            // Reverse direction so endpoints can reach virtuals too.
            appendEdge(idx, virtualIdx, seconds);
        }
    };

    linkVirtual(startIdx, start.x, start.z);
    linkVirtual(destIdx, dest.x, dest.z);

    // Direct start↔dest walk edge so trivially short trips don't force a TL.
    const dsx = dest.x - start.x;
    const dsz = dest.z - start.z;
    const directSeconds = Math.sqrt(dsx * dsx + dsz * dsz) / speed;
    appendEdge(startIdx, destIdx, directSeconds);
    appendEdge(destIdx, startIdx, directSeconds);

    const xs = graph.xs;
    const zs = graph.zs;
    const coord = (idx: number): WorldPoint => {
        if (idx === startIdx) return start;
        if (idx === destIdx) return dest;
        return { x: xs[idx], z: zs[idx] };
    };

    return {
        base: graph,
        startIdx,
        destIdx,
        numNodes: numBase + 2,
        extraTo,
        extraSec,
        extraKindTlIdx,
        extraPenalty,
        extraCount,
        extrasBySource,
        edgeCapacity: graph.baseEdgeCount + cap,
        coord,
    };
}

/** Read (to, seconds) for a given edge id without materialising any
 *  intermediate object. Hot-path helper used during reconstruction —
 *  inner Dijkstra/A* loops inline these reads instead of calling. */
function edgeEndpoint(aug: AugmentedGraph, eid: number): { to: number; seconds: number; kindTlIdx: number; penalty: number } {
    const baseN = aug.base.baseEdgeCount;
    if (eid < baseN) {
        return {
            to: aug.base.baseTo[eid],
            seconds: aug.base.baseSec[eid],
            kindTlIdx: aug.base.baseKindTlIdx[eid],
            penalty: aug.base.basePenalty[eid],
        };
    }
    const li = eid - baseN;
    return {
        to: aug.extraTo[li],
        seconds: aug.extraSec[li],
        kindTlIdx: aug.extraKindTlIdx[li],
        penalty: aug.extraPenalty[li],
    };
}

// ---------------------------------------------------------------------------
// Min-heap (binary) keyed by `priority` ascending — parallel arrays so
// pushes don't allocate a wrapper object per entry.
// ---------------------------------------------------------------------------

class MinHeap {
    private nodes: number[] = [];
    private prio: number[] = [];
    get size(): number {
        return this.nodes.length;
    }
    push(node: number, priority: number): void {
        const ns = this.nodes;
        const ps = this.prio;
        ns.push(node);
        ps.push(priority);
        let i = ns.length - 1;
        while (i > 0) {
            const p = (i - 1) >>> 1;
            if (ps[p] > ps[i]) {
                const tn = ns[p]; ns[p] = ns[i]; ns[i] = tn;
                const tp = ps[p]; ps[p] = ps[i]; ps[i] = tp;
                i = p;
            } else break;
        }
    }
    /** Pops the smallest-priority entry, writing into `out` to avoid
     *  allocating a result object per pop. Returns false when empty. */
    pop(out: { node: number; priority: number }): boolean {
        const ns = this.nodes;
        const ps = this.prio;
        if (ns.length === 0) return false;
        out.node = ns[0];
        out.priority = ps[0];
        const lastN = ns.pop()!;
        const lastP = ps.pop()!;
        if (ns.length > 0) {
            ns[0] = lastN;
            ps[0] = lastP;
            let i = 0;
            const n = ns.length;
            for (; ;) {
                const l = i * 2 + 1;
                const r = i * 2 + 2;
                let smallest = i;
                if (l < n && ps[l] < ps[smallest]) smallest = l;
                if (r < n && ps[r] < ps[smallest]) smallest = r;
                if (smallest === i) break;
                const tn = ns[smallest]; ns[smallest] = ns[i]; ns[i] = tn;
                const tp = ps[smallest]; ps[smallest] = ps[i]; ps[i] = tp;
                i = smallest;
            }
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Path reconstruction → RouteLeg[]
// ---------------------------------------------------------------------------

function reconstructLegs(
    aug: AugmentedGraph,
    nodePath: number[],
    edgeIds: number[],
): RouteResult {
    const legs: RouteLeg[] = [];
    let totalSeconds = 0;
    let walkBlocks = 0;
    let tlHops = 0;
    for (let i = 0; i < edgeIds.length; i++) {
        const e = edgeEndpoint(aug, edgeIds[i]);
        const fromIdx = nodePath[i];
        const toIdx = nodePath[i + 1];
        const from = aug.coord(fromIdx);
        const to = aug.coord(toIdx);
        totalSeconds += e.seconds;
        if (e.kindTlIdx >= 0) {
            const seg = aug.base.segments[e.kindTlIdx];
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
            legs.push({
                kind: "walk",
                from,
                to,
                blocks,
                seconds: e.seconds,
                penaltySeconds: e.penalty > 0 ? e.penalty : undefined,
            });
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
            const mergedPenalty =
                (prev.penaltySeconds ?? 0) + (leg.penaltySeconds ?? 0);
            merged[merged.length - 1] = {
                kind: "walk",
                from: prev.from,
                to: leg.to,
                blocks: prev.blocks + leg.blocks,
                seconds: prev.seconds + leg.seconds,
                penaltySeconds: mergedPenalty > 0 ? mergedPenalty : undefined,
            };
        } else {
            merged.push(leg);
        }
    }

    // Strip the elk-prefer penalty from walk legs that sit BEFORE the
    // first TL hop or AFTER the last TL hop. Those segments are the
    // player walking solo (no elk to lead), so they shouldn't be
    // charged the "leading an elk through an unverified passage"
    // surcharge — only the inter-TL middle walks should.
    let firstTlIdx = -1;
    let lastTlIdx = -1;
    for (let i = 0; i < merged.length; i++) {
        if (merged[i].kind === "tl") {
            if (firstTlIdx === -1) firstTlIdx = i;
            lastTlIdx = i;
        }
    }
    for (let i = 0; i < merged.length; i++) {
        const leg = merged[i];
        if (leg.kind !== "walk" || !leg.penaltySeconds) continue;
        const isStartSide = firstTlIdx === -1 || i < firstTlIdx;
        const isEndSide = lastTlIdx === -1 || i > lastTlIdx;
        if (!isStartSide && !isEndSide) continue;
        totalSeconds -= leg.penaltySeconds;
        merged[i] = {
            ...leg,
            seconds: leg.seconds - leg.penaltySeconds,
            penaltySeconds: undefined,
        };
    }

    let uncertainSeconds = 0;
    for (const leg of merged) {
        if (leg.kind === "walk" && leg.penaltySeconds) {
            uncertainSeconds += leg.penaltySeconds;
        }
    }

    return { totalSeconds, uncertainSeconds, walkBlocks, tlHops, legs: merged };
}

// ---------------------------------------------------------------------------
// Core search (A* + Dijkstra) over CSR
// ---------------------------------------------------------------------------
//
// Both routines share the same shape: typed-array distance + parent
// arrays indexed by node id, lazy-deletion heap. `forbiddenEdges` and
// `forbiddenNodes` are optional Uint8Array masks (1 = blocked) — a
// sentinel for `null` keeps the inner loop branch-free in the common
// no-forbidden case.

const POP_SCRATCH = { node: 0, priority: 0 };

interface SearchResult {
    nodes: number[];
    edgeIds: number[];
    cost: number;
}

/** Walks from `target` back to `source` via the parent arrays and emits
 *  forward node + edge-id paths. Returns null on any inconsistency. */
function tracePath(
    parentNode: Int32Array,
    parentEdge: Int32Array,
    source: number,
    target: number,
    safetyCap: number,
): { nodes: number[]; edgeIds: number[] } | null {
    if (target === source) return { nodes: [source], edgeIds: [] };
    const nodes: number[] = [];
    const edgeIds: number[] = [];
    let n = target;
    let safety = safetyCap;
    while (n !== source) {
        if (safety-- <= 0) return null;
        nodes.push(n);
        const eid = parentEdge[n];
        if (eid < 0) return null;
        edgeIds.push(eid);
        const prev = parentNode[n];
        if (prev < 0) return null;
        n = prev;
    }
    nodes.push(source);
    nodes.reverse();
    edgeIds.reverse();
    return { nodes, edgeIds };
}

/** Common A* / Dijkstra inner loop. When `useHeuristic` is true, edges
 *  are prioritised by `g + h`; otherwise pure Dijkstra. Stops as soon
 *  as `target` is popped (consistent heuristic ⇒ optimal at pop). When
 *  `target < 0`, the search runs to exhaustion (used by the rendezvous
 *  routine to populate a full SPT). */
function searchCSR(
    aug: AugmentedGraph,
    source: number,
    target: number,
    useHeuristic: boolean,
    forbiddenEdges: Uint8Array | null,
    forbiddenNodes: Uint8Array | null,
): { dist: Float64Array; parentNode: Int32Array; parentEdge: Int32Array; reachedTarget: boolean } {
    const numNodes = aug.numNodes;
    const dist = new Float64Array(numNodes);
    const parentNode = new Int32Array(numNodes);
    const parentEdge = new Int32Array(numNodes);
    dist.fill(Infinity);
    parentNode.fill(-1);
    parentEdge.fill(-1);
    dist[source] = 0;

    const heap = new MinHeap();
    heap.push(source, 0);

    const speed = aug.base.opts.walkSpeed;
    const baseHead = aug.base.baseHead;
    const baseTo = aug.base.baseTo;
    const baseSec = aug.base.baseSec;
    const baseN = aug.base.baseEdgeCount;
    const numBaseNodes = aug.base.numNodes;
    const xs = aug.base.xs;
    const zs = aug.base.zs;
    const extrasBySource = aug.extrasBySource;
    const extraTo = aug.extraTo;
    const extraSec = aug.extraSec;

    // Precompute target coords for the heuristic (skipped when target<0).
    let tx = 0;
    let tz = 0;
    if (useHeuristic && target >= 0) {
        const tp = aug.coord(target);
        tx = tp.x;
        tz = tp.z;
    }

    let reachedTarget = false;
    while (heap.pop(POP_SCRATCH)) {
        const u = POP_SCRATCH.node;
        const pri = POP_SCRATCH.priority;
        if (forbiddenNodes && forbiddenNodes[u] === 1) continue;
        const gU = dist[u];
        // Stale heap entry (better g already recorded) — skip.
        if (useHeuristic) {
            // pri = g + h; reconstruct g for the staleness check.
            const p = aug.coord(u);
            const dx = p.x - tx;
            const dz = p.z - tz;
            const hU = Math.sqrt(dx * dx + dz * dz) / speed;
            if (pri - hU > gU + 1e-9) continue;
        } else {
            if (pri > gU + 1e-9) continue;
        }
        if (u === target) {
            reachedTarget = true;
            break;
        }

        // Iterate base CSR edges (only when u is a non-virtual node).
        if (u < numBaseNodes) {
            const eEnd = baseHead[u + 1];
            for (let eid = baseHead[u]; eid < eEnd; eid++) {
                if (forbiddenEdges && forbiddenEdges[eid] === 1) continue;
                const v = baseTo[eid];
                if (forbiddenNodes && forbiddenNodes[v] === 1) continue;
                const tentative = gU + baseSec[eid];
                if (tentative < dist[v]) {
                    dist[v] = tentative;
                    parentNode[v] = u;
                    parentEdge[v] = eid;
                    let priority = tentative;
                    if (useHeuristic) {
                        // For non-virtual neighbours we have the coords in
                        // typed arrays directly; virtual neighbours can't
                        // appear here (they're not in baseTo).
                        const dx = xs[v] - tx;
                        const dz = zs[v] - tz;
                        priority += Math.sqrt(dx * dx + dz * dz) / speed;
                    }
                    heap.push(v, priority);
                }
            }
        }
        // Iterate extras.
        const extras = extrasBySource.get(u);
        if (extras) {
            for (let k = 0; k < extras.length; k++) {
                const eid = extras[k];
                if (forbiddenEdges && forbiddenEdges[eid] === 1) continue;
                const li = eid - baseN;
                const v = extraTo[li];
                if (forbiddenNodes && forbiddenNodes[v] === 1) continue;
                const tentative = gU + extraSec[li];
                if (tentative < dist[v]) {
                    dist[v] = tentative;
                    parentNode[v] = u;
                    parentEdge[v] = eid;
                    let priority = tentative;
                    if (useHeuristic) {
                        const vp = aug.coord(v);
                        const dx = vp.x - tx;
                        const dz = vp.z - tz;
                        priority += Math.sqrt(dx * dx + dz * dz) / speed;
                    }
                    heap.push(v, priority);
                }
            }
        }
    }
    return { dist, parentNode, parentEdge, reachedTarget };
}

function aStarOnAugmented(aug: AugmentedGraph): RouteResult | null {
    const { startIdx, destIdx } = aug;
    const { dist, parentNode, parentEdge, reachedTarget } = searchCSR(
        aug,
        startIdx,
        destIdx,
        true,
        null,
        null,
    );
    if (!reachedTarget || !Number.isFinite(dist[destIdx])) return null;
    const traced = tracePath(parentNode, parentEdge, startIdx, destIdx, aug.numNodes * 2 + 16);
    if (!traced) return null;
    return reconstructLegs(aug, traced.nodes, traced.edgeIds);
}

function dijkstraPath(
    aug: AugmentedGraph,
    fromOverride: number,
    toOverride: number,
    forbiddenEdges: Uint8Array | null,
    forbiddenNodes: Uint8Array | null,
): SearchResult | null {
    const { dist, parentNode, parentEdge, reachedTarget } = searchCSR(
        aug,
        fromOverride,
        toOverride,
        false,
        forbiddenEdges,
        forbiddenNodes,
    );
    if (!reachedTarget || !Number.isFinite(dist[toOverride])) return null;
    const traced = tracePath(parentNode, parentEdge, fromOverride, toOverride, aug.numNodes * 2 + 16);
    if (!traced) return null;
    return { nodes: traced.nodes, edgeIds: traced.edgeIds, cost: dist[toOverride] };
}

// ---------------------------------------------------------------------------
// Public: single shortest route via A*
// ---------------------------------------------------------------------------

export function findRoute(
    graph: TLGraph,
    start: WorldPoint,
    dest: WorldPoint,
): RouteResult | null {
    const aug = augmentForQuery(graph, start, dest);
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
    const aug = augmentForQuery(graph, start, dest);
    const first = dijkstraPath(aug, aug.startIdx, aug.destIdx, null, null);
    if (!first) return [];

    // Edge-id space is fixed for this augmented graph: base edges
    // [0, baseEdgeCount) plus extras [baseEdgeCount, edgeCapacity).
    // Forbidden masks reuse this contiguous space so Yen's spur setup
    // is just a few `Uint8Array` writes/clears per iteration.
    const edgeMaskLen = aug.edgeCapacity;
    const nodeMaskLen = aug.numNodes;
    const forbiddenEdges = new Uint8Array(edgeMaskLen);
    const forbiddenNodes = new Uint8Array(nodeMaskLen);

    const A: SearchResult[] = [first];
    const B: SearchResult[] = [];

    // Cap raw Yen iterations to avoid degenerate cost on pathological graphs.
    // Generous multiplier so we still have material after dedup filtering.
    const RAW_K = Math.max(k * 5, 12);

    /** Pair an edge id with its reverse. Both base TL/walk edges and
     *  extras are wired symmetrically (we always `addEdge(u,v)` AND
     *  `addEdge(v,u)`), so there's exactly one reverse — find it once
     *  and forbid the pair together. */
    const findReverseEdge = (from: number, to: number, eid: number): number => {
        if (eid < aug.base.baseEdgeCount) {
            // Search base CSR slice of `to` for an edge back to `from`
            // with matching kindTlIdx (TL edges are 1:1 by tlIndex; walk
            // edges by direction). Returns -1 if missing.
            const baseHead = aug.base.baseHead;
            const baseTo = aug.base.baseTo;
            const baseKind = aug.base.baseKindTlIdx;
            const targetKind = aug.base.baseKindTlIdx[eid];
            const eEnd = baseHead[to + 1];
            for (let r = baseHead[to]; r < eEnd; r++) {
                if (baseTo[r] === from && baseKind[r] === targetKind) return r;
            }
            return -1;
        }
        // Extras: walk through the source's extras list.
        const list = aug.extrasBySource.get(to);
        if (!list) return -1;
        for (const r of list) {
            const baseN = aug.base.baseEdgeCount;
            const li = r - baseN;
            if (aug.extraTo[li] === from) return r;
        }
        return -1;
    };

    while (A.length < RAW_K) {
        const prev = A[A.length - 1];
        for (let i = 0; i < prev.nodes.length - 1; i++) {
            const spurNode = prev.nodes[i];

            // Build forbidden-edges set: every previous A-path that shares
            // the same root prefix [0..i] forbids its (i)th edge in BOTH
            // directions, so the spur Dijkstra can't recreate any earlier
            // result.
            forbiddenEdges.fill(0);
            forbiddenNodes.fill(0);
            for (const p of A) {
                if (p.nodes.length <= i) continue;
                let same = true;
                for (let j = 0; j <= i; j++) {
                    if (p.nodes[j] !== prev.nodes[j]) { same = false; break; }
                }
                if (!same) continue;
                const eid = p.edgeIds[i];
                forbiddenEdges[eid] = 1;
                const rev = findReverseEdge(p.nodes[i], p.nodes[i + 1], eid);
                if (rev >= 0) forbiddenEdges[rev] = 1;
            }
            // Forbid root nodes (excluding the spur node itself) so the
            // spur path is loopless w.r.t. the root.
            for (let j = 0; j < i; j++) {
                forbiddenNodes[prev.nodes[j]] = 1;
            }

            const spur = dijkstraPath(aug, spurNode, aug.destIdx, forbiddenEdges, forbiddenNodes);
            if (!spur) continue;

            // Stitch: rootNodes already ends at spurNode, spur.nodes starts
            // at spurNode — drop the duplicate when concatenating.
            const candidateNodes = prev.nodes.slice(0, i + 1).concat(spur.nodes.slice(1));
            const candidateEdges = prev.edgeIds.slice(0, i).concat(spur.edgeIds);
            let totalSeconds = 0;
            for (const eid of candidateEdges) {
                if (eid < aug.base.baseEdgeCount) totalSeconds += aug.base.baseSec[eid];
                else totalSeconds += aug.extraSec[eid - aug.base.baseEdgeCount];
            }
            const candidate: SearchResult = {
                nodes: candidateNodes,
                edgeIds: candidateEdges,
                cost: totalSeconds,
            };
            // Cheap dedup against B by cost+length (full equality check
            // only when those tie — exact-match collisions are rare).
            let dup = false;
            for (const b of B) {
                if (b.cost !== candidate.cost) continue;
                if (b.nodes.length !== candidate.nodes.length) continue;
                let eq = true;
                for (let j = 0; j < b.nodes.length; j++) {
                    if (b.nodes[j] !== candidate.nodes[j]) { eq = false; break; }
                }
                if (eq) { dup = true; break; }
            }
            if (!dup) B.push(candidate);
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
    // `A` and goes through the same dedupe below.
    const firstTLIndices = new Set<number>();
    for (const eid of A[0].edgeIds) {
        if (eid < aug.base.baseEdgeCount && aug.base.baseKindTlIdx[eid] >= 0) {
            firstTLIndices.add(aug.base.baseKindTlIdx[eid]);
        }
    }
    for (const tlIdx of firstTLIndices) {
        forbiddenEdges.fill(0);
        forbiddenNodes.fill(0);
        // The two TL edges for tlIdx live in the CSR slice of node
        // `tlIdx*2` and `tlIdx*2+1` respectively — find them once.
        const a = tlIdx * 2;
        const b = tlIdx * 2 + 1;
        const baseHead = aug.base.baseHead;
        const baseTo = aug.base.baseTo;
        const baseKind = aug.base.baseKindTlIdx;
        for (let r = baseHead[a]; r < baseHead[a + 1]; r++) {
            if (baseTo[r] === b && baseKind[r] === tlIdx) { forbiddenEdges[r] = 1; break; }
        }
        for (let r = baseHead[b]; r < baseHead[b + 1]; r++) {
            if (baseTo[r] === a && baseKind[r] === tlIdx) { forbiddenEdges[r] = 1; break; }
        }
        const alt = dijkstraPath(aug, aug.startIdx, aug.destIdx, forbiddenEdges, null);
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
    const built = A.map((p) => reconstructLegs(aug, p.nodes, p.edgeIds));
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

// ---------------------------------------------------------------------------
// Public: Rendezvous (find a meeting point that minimises party travel time)
// ---------------------------------------------------------------------------

/** How "best meeting point" is scored across the party. */
export type RendezvousObjective =
    /** Minimise the slowest player's travel time. "Nobody waits too long." */
    | "minimax"
    /** Minimise total travel time across the party. Fastest in aggregate, but
     *  can dump all the walking on one unlucky player. */
    | "minisum";

export interface PerPlayerLeg {
    player: WorldPoint;
    route: RouteResult;
}

export interface RendezvousResult {
    /** Chosen meeting point in world coords. */
    meeting: WorldPoint;
    /** Per-player routes from player → meeting, in the order of the input. */
    perPlayer: PerPlayerLeg[];
    /** Slowest player's travel time in seconds. The "everyone's there by" ETA. */
    worstSeconds: number;
    /** Sum of all players' travel times — useful as a secondary score. */
    totalSeconds: number;
    /** Echoed back so callers can label the result without tracking it. */
    objective: RendezvousObjective;
}

/** Run Dijkstra from a single source and record the FULL shortest-path
 *  tree to every reachable node. Used by the rendezvous scoring step
 *  so we can answer "cost to candidate X" for any X without re-running
 *  the search. */
function dijkstraAllFrom(aug: AugmentedGraph, source: number) {
    return searchCSR(aug, source, -1, false, null, null);
}

/** Reconstruct a `RouteResult` walking backwards through the parent
 *  arrays produced by `dijkstraAllFrom`. Returns null if `target` was
 *  never reached. */
function reconstructFromTree(
    aug: AugmentedGraph,
    target: number,
    source: number,
    parentNode: Int32Array,
    parentEdge: Int32Array,
): RouteResult | null {
    if (target === source) {
        return { totalSeconds: 0, uncertainSeconds: 0, walkBlocks: 0, tlHops: 0, legs: [] };
    }
    const traced = tracePath(parentNode, parentEdge, source, target, aug.numNodes * 2 + 16);
    if (!traced) return null;
    return reconstructLegs(aug, traced.nodes, traced.edgeIds);
}

/**
 * Find the optimal meeting point for a party of N players (N ≥ 1).
 *
 * Algorithm:
 *   1. Run Dijkstra-from-source once per player on their own augmented
 *      graph (player → all reachable nodes). O(P · (V + E log V)).
 *   2. Score every TL endpoint as a candidate meeting node by combining
 *      per-player costs via `objective`.
 *   3. Also consider each player's own position as a candidate (handles
 *      "everyone walk to player X" when the party is already close).
 *      For these we re-run `findRoute` from each other player (cheap A*).
 *   4. Reconstruct per-player routes to the winning candidate.
 *
 * Ties on the primary objective are broken by the OTHER objective so
 * minimax doesn't pick an unnecessarily walk-heavy spot when a tied
 * candidate would also be cheaper in aggregate.
 */
export function findRendezvous(
    graph: TLGraph,
    players: ReadonlyArray<WorldPoint>,
    objective: RendezvousObjective = "minimax",
): RendezvousResult | null {
    if (players.length === 0) return null;
    if (players.length === 1) {
        return {
            meeting: { x: players[0].x, z: players[0].z },
            perPlayer: [
                {
                    player: players[0],
                    route: { totalSeconds: 0, uncertainSeconds: 0, walkBlocks: 0, tlHops: 0, legs: [] },
                },
            ],
            worstSeconds: 0,
            totalSeconds: 0,
            objective,
        };
    }

    const numBaseNodes = graph.numNodes;

    // Phase 1: per-player shortest-path trees.
    const perPlayer = players.map((p) => {
        // Reuse `augmentForQuery` with dest = start. The virtual dest node
        // is harmless extra wiring (a handful of walk edges); the per-query
        // start↔dest direct edge has cost 0 since the points coincide.
        const aug = augmentForQuery(graph, p, p);
        const trees = dijkstraAllFrom(aug, aug.startIdx);
        return { player: p, aug, ...trees };
    });

    const scoreOf = (costs: ReadonlyArray<number>): number =>
        objective === "minimax" ? Math.max(...costs) : costs.reduce((a, b) => a + b, 0);
    const tieOf = (costs: ReadonlyArray<number>): number =>
        objective === "minimax" ? costs.reduce((a, b) => a + b, 0) : Math.max(...costs);

    type Best =
        | { kind: "tlNode"; nodeIdx: number; meeting: WorldPoint; score: number; tie: number }
        | { kind: "playerPos"; routes: RouteResult[]; meeting: WorldPoint; score: number; tie: number };
    let best: Best | null = null;

    const isBetter = (s: number, t: number): boolean => {
        if (!best) return true;
        if (s < best.score - 1e-9) return true;
        if (s > best.score + 1e-9) return false;
        return t < best.tie - 1e-9;
    };

    // Phase 2: score every TL endpoint as a meeting candidate. We only
    // need costs here — route reconstruction is deferred to the winner.
    const costsBuf: number[] = new Array(players.length);
    for (let nodeIdx = 0; nodeIdx < numBaseNodes; nodeIdx++) {
        let reachable = true;
        for (let i = 0; i < perPlayer.length; i++) {
            const c = perPlayer[i].dist[nodeIdx];
            if (!Number.isFinite(c)) {
                reachable = false;
                break;
            }
            costsBuf[i] = c;
        }
        if (!reachable) continue;
        const s = scoreOf(costsBuf);
        const t = tieOf(costsBuf);
        if (isBetter(s, t)) {
            best = {
                kind: "tlNode",
                nodeIdx,
                meeting: { x: graph.xs[nodeIdx], z: graph.zs[nodeIdx] },
                score: s,
                tie: t,
            };
        }
    }

    // Phase 3: consider "meet at player M's spot" for every player. This
    // matters when the party is already clustered tightly enough that the
    // best TL endpoint is a detour. For each candidate we run findRoute
    // from every OTHER player (player M's own route is zero).
    for (let m = 0; m < players.length; m++) {
        const meet = players[m];
        const routes: RouteResult[] = [];
        let reachable = true;
        for (let p = 0; p < players.length; p++) {
            if (p === m) {
                routes.push({ totalSeconds: 0, uncertainSeconds: 0, walkBlocks: 0, tlHops: 0, legs: [] });
                continue;
            }
            const r = findRoute(graph, players[p], meet);
            if (!r) {
                reachable = false;
                break;
            }
            routes.push(r);
        }
        if (!reachable) continue;
        const costs = routes.map((r) => r.totalSeconds);
        const s = scoreOf(costs);
        const t = tieOf(costs);
        if (isBetter(s, t)) {
            best = {
                kind: "playerPos",
                routes,
                meeting: { x: meet.x, z: meet.z },
                score: s,
                tie: t,
            };
        }
    }

    if (!best) return null;

    // Phase 4: materialise per-player routes for the winner.
    let perPlayerRoutes: RouteResult[];
    if (best.kind === "tlNode") {
        const targetNode = best.nodeIdx;
        perPlayerRoutes = perPlayer.map((pp) => {
            const reconstructed = reconstructFromTree(
                pp.aug,
                targetNode,
                pp.aug.startIdx,
                pp.parentNode,
                pp.parentEdge,
            );
            if (reconstructed) return reconstructed;
            // Fallback shouldn't happen — we already know targetNode is
            // reachable from pp.startIdx — but degrade gracefully.
            const cost = pp.dist[targetNode];
            return {
                totalSeconds: Number.isFinite(cost) ? cost : 0,
                uncertainSeconds: 0,
                walkBlocks: 0,
                tlHops: 0,
                legs: [],
            };
        });
    } else {
        perPlayerRoutes = best.routes;
    }

    const worstSeconds = perPlayerRoutes.reduce((m, r) => Math.max(m, r.totalSeconds), 0);
    const totalSeconds = perPlayerRoutes.reduce((a, r) => a + r.totalSeconds, 0);

    return {
        meeting: best.meeting,
        perPlayer: players.map((p, i) => ({ player: p, route: perPlayerRoutes[i] })),
        worstSeconds,
        totalSeconds,
        objective,
    };
}
