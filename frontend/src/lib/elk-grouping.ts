// Enumerate and classify the elk-attestable walk edges *inside* a
// favourite TL grouping. Used by the "Mark grouping elk-friendly" batch
// action so the user can see at a glance how much of a grouping is
// already confirmed and stage every missing edge into the existing
// attestation draft in one click.
//
// Connections are enumerated as every endpoint-to-endpoint pair between
// two different TLs in the grouping within `maxWalkBlocks`. We deliberately
// do NOT use the planner's K-nearest wiring here: for a small hand-picked
// grouping the user expects *every* short walk to appear, and the K-NN cap
// silently dropped edges when several TLs clustered close together.

import type { WorldLineSegment } from "@/components/MapViewer";
import {
    canonicalEdgeKey,
    classifyWalkLeg,
    type EdgeEndpointIdx,
    type EdgeEndpointRef,
    type ElkWalkableEdge,
    type WalkLegElkState,
} from "@/lib/elk-walkable";
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

/** How walk edges inside a grouping are selected.
 *  - `distance`: every endpoint pair within {@link EnumerateGroupingEdgesOptions.maxWalkBlocks}.
 *  - `epicenter`: only endpoints inside {@link EnumerateGroupingEdgesOptions.radiusBlocks}
 *    of a chosen centre, wired to each other regardless of the distance
 *    between them. Lets the user tightly scope a densely interconnected
 *    cluster so far-apart-but-nearby TLs aren't wrongly linked. */
export type ElkGroupingMode = "distance" | "epicenter";

export interface EnumerateGroupingEdgesOptions {
    kNeighbors: number;
    walkSpeed: number;
    /** Drop walk edges whose Euclidean endpoint-to-endpoint distance
     *  exceeds this many blocks. Defaults to {@link DEFAULT_MAX_WALK_BLOCKS}.
     *  Pure K-NN over a small grouping will otherwise wire up every TL
     *  pair regardless of distance, so chained TLs that should produce
     *  N−1 walks end up with C(N,2)×4 edges. Ignored in `epicenter` mode. */
    maxWalkBlocks?: number;
    /** Connection-selection strategy. Defaults to `distance`. */
    mode?: ElkGroupingMode;
    /** Epicenter centre (map/UI world frame) for `epicenter` mode. When
     *  null in `epicenter` mode, no edges are produced. */
    epicenter?: { x: number; z: number } | null;
    /** Inclusion radius around {@link epicenter}, in blocks. Defaults to
     *  {@link DEFAULT_EPICENTER_RADIUS}. */
    radiusBlocks?: number;
}

/** Default cap on the walkable distance between two TL endpoints inside
 *  a grouping. ~800 blocks is the rough "I'd walk this rather than warp"
 *  threshold and matches the slider default exposed in the UI. */
export const DEFAULT_MAX_WALK_BLOCKS = 800;
export const MIN_MAX_WALK_BLOCKS = 10;
export const MAX_MAX_WALK_BLOCKS = 1900;

/** Default / bounds for the epicenter-mode inclusion radius. */
export const DEFAULT_EPICENTER_RADIUS = 400;
export const MIN_EPICENTER_RADIUS = 25;
export const MAX_EPICENTER_RADIUS = 2000;

/**
 * Walk-edge enumeration for a single grouping.
 *
 * - Filters `segments` to those whose `tlIdFor()` is in the grouping.
 * - Drops members missing a stable `id` (recorded in `skipped`).
 * - Enumerates every endpoint-to-endpoint pair between two different TLs
 *   within `maxWalkBlocks` and deduplicates by canonical edge key.
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

    const maxWalkBlocks = options.maxWalkBlocks ?? DEFAULT_MAX_WALK_BLOCKS;
    const mode: ElkGroupingMode = options.mode ?? "distance";
    const epicenter = options.epicenter ?? null;
    const radiusBlocks = options.radiusBlocks ?? DEFAULT_EPICENTER_RADIUS;

    // Epicenter mode with no centre chosen yet produces nothing — the UI
    // prompts the user to pick one.
    if (mode === "epicenter" && !epicenter) {
        return { edges: [], skipped, includedCount: included.length };
    }

    // Every walkable connection inside the grouping is an endpoint-to-endpoint
    // pair between two *different* TLs. Enumerate all such pairs directly
    // rather than via the planner's K-nearest graph — the K-NN cap silently
    // dropped connections when 7+ TLs sat close together, since each endpoint
    // only wired to its k closest neighbours.
    //
    // Selection differs by mode:
    //   * distance  — keep pairs within `maxWalkBlocks` of each other.
    //   * epicenter — keep only endpoints inside `radiusBlocks` of the
    //                 chosen centre, then link every remaining pair.
    const seen = new Map<string, GroupingElkEdge>();
    let endpoints: Array<{ id: string; ep: EdgeEndpointIdx; x: number; z: number }> = [];
    for (const seg of included) {
        if (!seg.id) continue;
        endpoints.push({ id: seg.id, ep: 0, x: seg.x1, z: seg.z1 });
        endpoints.push({ id: seg.id, ep: 1, x: seg.x2, z: seg.z2 });
    }
    if (mode === "epicenter" && epicenter) {
        const r2 = radiusBlocks * radiusBlocks;
        endpoints = endpoints.filter((e) => {
            const dx = e.x - epicenter.x;
            const dz = e.z - epicenter.z;
            return dx * dx + dz * dz <= r2;
        });
    }
    for (let i = 0; i < endpoints.length; i++) {
        const A = endpoints[i];
        for (let j = i + 1; j < endpoints.length; j++) {
            const B = endpoints[j];
            if (A.id === B.id) continue; // same TL — not a walk
            const dx = A.x - B.x;
            const dz = A.z - B.z;
            const walkBlocks = Math.sqrt(dx * dx + dz * dz);
            // In epicenter mode the radius filter already scoped the set,
            // so any surviving pair counts regardless of separation.
            if (mode === "distance" && walkBlocks > maxWalkBlocks) continue;
            const a: EdgeEndpointRef = { tl_id: A.id, ep: A.ep };
            const b: EdgeEndpointRef = { tl_id: B.id, ep: B.ep };
            let key: string;
            try {
                key = canonicalEdgeKey(a, b);
            } catch {
                continue;
            }
            if (seen.has(key)) continue;
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
