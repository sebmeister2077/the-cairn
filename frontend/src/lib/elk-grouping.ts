// Enumerate and classify the elk-attestable walk edges *inside* a
// favourite TL grouping. Used by the "Mark grouping elk-friendly" batch
// action so the user can see at a glance how much of a grouping is
// already confirmed and stage every missing edge into the existing
// attestation draft in one click.
//
// We reuse the route-planner's `buildTLGraph()` so the user's notion of
// "what walks count as adjacent inside this grouping" matches what the
// planner itself would consider when routing through that subset. The
// K-nearest wiring is computed over the grouping's TLs alone — that's
// the right scope for "every walkable edge between TLs the user has
// grouped together".

import type { WorldLineSegment } from "@/components/MapViewer";
import {
    canonicalEdgeKey,
    classifyWalkLeg,
    type EdgeEndpointIdx,
    type EdgeEndpointRef,
    type ElkWalkableEdge,
    type WalkLegElkState,
} from "@/lib/elk-walkable";
import { buildTLGraph } from "@/lib/tl-routing";
import type { TLGrouping } from "@/lib/tl-groupings";
import { tlIdFor } from "@/lib/tl-groupings";

export interface GroupingElkEdge {
    a: EdgeEndpointRef;
    b: EdgeEndpointRef;
    key: string;
    /** Euclidean blocks between the two endpoints — used for sorting + display. */
    walkBlocks: number;
}

export interface EnumerateGroupingEdgesResult {
    /** Deduplicated set of walk edges within the grouping. */
    edges: GroupingElkEdge[];
    /** TLs that belong to the grouping but had no stable `id`, so they
     *  cannot be referenced in elk attestations. Surfaced to the user as
     *  a "[N] skipped" warning. */
    skipped: WorldLineSegment[];
    /** TLs from the grouping that were found in `segments` (have a stable id). */
    includedCount: number;
}

export interface EnumerateGroupingEdgesOptions {
    kNeighbors: number;
    walkSpeed: number;
    /** Drop walk edges whose Euclidean endpoint-to-endpoint distance
     *  exceeds this many blocks. Defaults to {@link DEFAULT_MAX_WALK_BLOCKS}.
     *  Pure K-NN over a small grouping will otherwise wire up every TL
     *  pair regardless of distance, so chained TLs that should produce
     *  N−1 walks end up with C(N,2)×4 edges. */
    maxWalkBlocks?: number;
}

/** Default cap on the walkable distance between two TL endpoints inside
 *  a grouping. ~800 blocks is the rough "I'd walk this rather than warp"
 *  threshold and matches the slider default exposed in the UI. */
export const DEFAULT_MAX_WALK_BLOCKS = 800;
export const MIN_MAX_WALK_BLOCKS = 10;
export const MAX_MAX_WALK_BLOCKS = 1900;

/**
 * Walk-edge enumeration for a single grouping.
 *
 * - Filters `segments` to those whose `tlIdFor()` is in the grouping.
 * - Drops members missing a stable `id` (recorded in `skipped`).
 * - Builds a K-NN graph over the remaining endpoints with `buildTLGraph`
 *   and walks the CSR adjacency to collect every walk edge (kind < 0).
 * - Deduplicates by canonical edge key (the graph stores both directions).
 */
export function enumerateGroupingEdges(
    grouping: TLGrouping,
    segments: ReadonlyArray<WorldLineSegment>,
    options: EnumerateGroupingEdgesOptions,
): EnumerateGroupingEdgesResult {
    const tlIdSet = new Set(grouping.tlIds);
    const included: WorldLineSegment[] = [];
    const skipped: WorldLineSegment[] = [];
    for (const seg of segments) {
        if (!tlIdSet.has(tlIdFor(seg))) continue;
        if (!seg.id) {
            skipped.push(seg);
            continue;
        }
        included.push(seg);
    }

    if (included.length < 2) {
        return { edges: [], skipped, includedCount: included.length };
    }

    const graph = buildTLGraph(included, {
        kNeighbors: options.kNeighbors,
        walkSpeed: options.walkSpeed,
    });
    const maxWalkBlocks = options.maxWalkBlocks ?? DEFAULT_MAX_WALK_BLOCKS;

    const seen = new Map<string, GroupingElkEdge>();
    const xs = graph.xs;
    const zs = graph.zs;
    const head = graph.baseHead;
    const to = graph.baseTo;
    const kindTlIdx = graph.baseKindTlIdx;
    const numNodes = head.length - 1;

    for (let u = 0; u < numNodes; u++) {
        const lo = head[u];
        const hi = head[u + 1];
        for (let eid = lo; eid < hi; eid++) {
            // Walk edges are encoded with negative `kindTlIdx`
            // (KIND_WALK=-1, KIND_WALK_ELK=-2). TL edges carry the
            // non-negative tlIndex of the segment they pair.
            if (kindTlIdx[eid] >= 0) continue;
            const v = to[eid];
            if (v <= u) continue; // dedupe the reverse direction

            const segA = included[u >>> 1];
            const segB = included[v >>> 1];
            // `buildTLGraph` already skips wiring an endpoint to its
            // partner, but be defensive — same-TL walk would have no
            // attestation meaning.
            if (!segA?.id || !segB?.id) continue;
            if (segA.id === segB.id) continue;

            const epA: EdgeEndpointIdx = (u & 1) as 0 | 1;
            const epB: EdgeEndpointIdx = (v & 1) as 0 | 1;
            const a: EdgeEndpointRef = { tl_id: segA.id, ep: epA };
            const b: EdgeEndpointRef = { tl_id: segB.id, ep: epB };
            let key: string;
            try {
                key = canonicalEdgeKey(a, b);
            } catch {
                continue;
            }
            if (seen.has(key)) continue;

            const dx = xs[u] - xs[v];
            const dz = zs[u] - zs[v];
            const walkBlocks = Math.sqrt(dx * dx + dz * dz);
            if (walkBlocks > maxWalkBlocks) continue;
            seen.set(key, { a, b, key, walkBlocks });
        }
    }

    // Deterministic order: shortest walks first, then by key.
    const edges = Array.from(seen.values()).sort(
        (x, y) => x.walkBlocks - y.walkBlocks || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
    );
    return { edges, skipped, includedCount: included.length };
}

export interface ClassifiedGroupingEdge extends GroupingElkEdge {
    state: WalkLegElkState;
}

export interface GroupingElkSummary {
    total: number;
    confirmed: number;
    confirmedByMe: number;
    pendingAttest: number;
    pendingUnattest: number;
    unconfirmed: number;
    /** Edges that would actually be added to the draft if the user
     *  confirms: unconfirmed AND not already in the draft. */
    stageable: GroupingElkEdge[];
}

export interface ClassifyGroupingEdgesResult {
    edges: ClassifiedGroupingEdge[];
    summary: GroupingElkSummary;
}

export function classifyGroupingEdges(
    edges: ReadonlyArray<GroupingElkEdge>,
    confirmedEdges: Record<string, ElkWalkableEdge>,
    pendingAttestKeys: ReadonlySet<string>,
    pendingUnattestKeys: ReadonlySet<string>,
    selfUserId: string | null,
): ClassifyGroupingEdgesResult {
    const classified: ClassifiedGroupingEdge[] = [];
    const summary: GroupingElkSummary = {
        total: edges.length,
        confirmed: 0,
        confirmedByMe: 0,
        pendingAttest: 0,
        pendingUnattest: 0,
        unconfirmed: 0,
        stageable: [],
    };

    for (const edge of edges) {
        const state = classifyWalkLeg(
            edge,
            confirmedEdges,
            pendingAttestKeys,
            pendingUnattestKeys,
            selfUserId,
        );
        classified.push({ ...edge, state });
        switch (state) {
            case "confirmed":
                summary.confirmed++;
                break;
            case "confirmed-by-me":
                summary.confirmed++;
                summary.confirmedByMe++;
                break;
            case "pending-attest":
                summary.pendingAttest++;
                break;
            case "pending-unattest":
                summary.pendingUnattest++;
                break;
            case "unconfirmed":
                summary.unconfirmed++;
                summary.stageable.push(edge);
                break;
            case "not-attestable":
                // Shouldn't happen — every enumerated edge has a key — but be safe.
                break;
        }
    }

    return { edges: classified, summary };
}
