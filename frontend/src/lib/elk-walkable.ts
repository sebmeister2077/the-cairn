// Elk-walkable edges — shared types and canonical edge-key helpers used
// by both the route planner UI and the routing graph.
//
// An "edge" is an undirected pair of TL endpoints `(tl_id, endpoint_idx)`
// the user has confirmed is safely walkable by an elk (no chasm, no
// shore, no acid pool, etc). Identity is keyed on the TL's stable
// `properties.id` so the reference survives small coordinate jitter on
// re-imports.

export type EdgeEndpointIdx = 0 | 1;

export interface EdgeEndpointRef {
    tl_id: string;
    ep: EdgeEndpointIdx;
}

/** What the user sees in a draft list before submission. */
export interface PendingEdgeChange {
    a: EdgeEndpointRef;
    b: EdgeEndpointRef;
    /** Canonical key — recomputed on hydration so we don't trust the wire. */
    key: string;
}

/** Per-edge attester record returned by the backend. */
export interface EdgeAttester {
    user_id: string | null;
    display_name: string | null;
    at: string;
    note?: string;
}

/** Edge record as served by `/api/elk-walkable/url`. */
export interface ElkWalkableEdge {
    key: string;
    a: EdgeEndpointRef;
    b: EdgeEndpointRef;
    attested_by: EdgeAttester[];
    first_attested_at: string;
    last_updated_at: string;
}

export interface ElkWalkableFile {
    version: number;
    edges: ElkWalkableEdge[];
}

function endpointToken(tlId: string, ep: EdgeEndpointIdx): string {
    return `${tlId}:${ep}`;
}

/**
 * Build the canonical (direction-insensitive) edge key. Mirrors the
 * backend `canonical_edge_key()` in `app/core/elk_walkable_store.py` so
 * round-trips compare equal.
 */
export function canonicalEdgeKey(a: EdgeEndpointRef, b: EdgeEndpointRef): string {
    const aTok = endpointToken(a.tl_id, a.ep);
    const bTok = endpointToken(b.tl_id, b.ep);
    if (aTok === bTok) {
        throw new Error("edge endpoints must differ");
    }
    return aTok < bTok ? `${aTok}|${bTok}` : `${bTok}|${aTok}`;
}

export function parseEdgeKey(
    key: string,
): { a: EdgeEndpointRef; b: EdgeEndpointRef } {
    const [lo, hi] = key.split("|", 2);
    if (!lo || !hi) throw new Error(`invalid edge key: ${key}`);
    const splitTok = (tok: string): EdgeEndpointRef => {
        const i = tok.lastIndexOf(":");
        if (i < 0) throw new Error(`invalid endpoint token: ${tok}`);
        const tlId = tok.slice(0, i);
        const ep = Number(tok.slice(i + 1));
        if (ep !== 0 && ep !== 1) throw new Error(`invalid endpoint index: ${tok}`);
        return { tl_id: tlId, ep };
    };
    return { a: splitTok(lo), b: splitTok(hi) };
}

// ---------------------------------------------------------------------------
// Walk-leg → edge identity
// ---------------------------------------------------------------------------

/**
 * Identify a walk leg's elk-attestable edge.
 *
 * A walk leg is attestable iff it sits *between two TL legs* (i.e. it
 * connects two real TL endpoints, not a virtual Start/Dest node) and
 * both surrounding TL segments carry a stable `id`. Walk legs touching
 * Start/Dest, or TLs without an id (e.g. brand-new user TLs that haven't
 * been id-stamped yet), return `null`.
 *
 * This is purely a lookup on the route legs as returned by the routing
 * worker — it does NOT need the underlying graph, only the segment
 * geometry to figure out which endpoint of each TL the walk touches.
 */
import type { RouteLeg } from "@/lib/tl-routing";

export function walkLegEdgeRef(
    legs: ReadonlyArray<RouteLeg>,
    index: number,
): { a: EdgeEndpointRef; b: EdgeEndpointRef; key: string } | null {
    const leg = legs[index];
    if (!leg || leg.kind !== "walk") return null;
    const prev = legs[index - 1];
    const next = legs[index + 1];
    if (prev?.kind !== "tl" || next?.kind !== "tl") return null;
    const segPrev = prev.segment;
    const segNext = next.segment;
    if (!segPrev.id || !segNext.id) return null;

    // The previous TL leg exits at `prev.to`, which equals the walk
    // leg's `from`. The next TL leg enters at `next.from`, which equals
    // the walk leg's `to`. Pick the matching endpoint index on each.
    const epA: EdgeEndpointIdx | null =
        segPrev.x1 === leg.from.x && segPrev.z1 === leg.from.z
            ? 0
            : segPrev.x2 === leg.from.x && segPrev.z2 === leg.from.z
                ? 1
                : null;
    const epB: EdgeEndpointIdx | null =
        segNext.x1 === leg.to.x && segNext.z1 === leg.to.z
            ? 0
            : segNext.x2 === leg.to.x && segNext.z2 === leg.to.z
                ? 1
                : null;
    if (epA === null || epB === null) return null;
    const a: EdgeEndpointRef = { tl_id: segPrev.id, ep: epA };
    const b: EdgeEndpointRef = { tl_id: segNext.id, ep: epB };
    if (a.tl_id === b.tl_id && a.ep === b.ep) return null;
    return { a, b, key: canonicalEdgeKey(a, b) };
}

/** Render-state classification for a walk leg, used both by the canvas
 *  recolouring and by the planner's per-leg button copy. */
export type WalkLegElkState =
    | "not-attestable"
    | "unconfirmed"
    | "confirmed"
    | "confirmed-by-me"
    | "pending-attest"
    | "pending-unattest";

export function classifyWalkLeg(
    edgeRef: { key: string } | null,
    confirmedEdges: Record<string, ElkWalkableEdge>,
    pendingAttestKeys: ReadonlySet<string>,
    pendingUnattestKeys: ReadonlySet<string>,
    selfUserId: string | null,
): WalkLegElkState {
    if (!edgeRef) return "not-attestable";
    if (pendingAttestKeys.has(edgeRef.key)) return "pending-attest";
    if (pendingUnattestKeys.has(edgeRef.key)) return "pending-unattest";
    const confirmed = confirmedEdges[edgeRef.key];
    if (!confirmed) return "unconfirmed";
    if (
        selfUserId &&
        confirmed.attested_by.some((a) => a.user_id === selfUserId)
    ) {
        return "confirmed-by-me";
    }
    return "confirmed";
}
