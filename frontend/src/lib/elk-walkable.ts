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
