/**
 * Types for the "Contribute Translocators" feature.
 *
 * The page parses the user's `client-chat.log` (output of `/waypoint list
 * details`), extracts spiral-icon waypoints (translocator markers), and
 * pairs them with each other or matches them against the server's existing
 * translocator overlay.
 */

/** A single waypoint parsed from the chat-log. */
export interface ParsedWaypoint {
    /** 0-based index from the in-game list. */
    index: number;
    name: string;
    x: number;
    y: number;
    z: number;
    color: string;
    icon: string;
    /** 1-based source line number for diagnostics. */
    lineNumber: number;
}

/** A single endpoint of a user-uploaded translocator pair. */
export interface UserTLEndpoint {
    /** World x. */
    x: number;
    /** World z. */
    z: number;
    /** Original waypoint index (if endpoint came from the chat-log; null for "manual" added points). */
    sourceWaypointIndex: number | null;
    /** Display label (waypoint name). */
    label: string;
}

export type TLStatus =
    /** Both endpoints match the same server segment (within match radius). */
    | "existing"
    /** New pair derived from label coordinates with exact (≤7 block) target match. */
    | "new-confirmed"
    /** New pair derived from label coordinates with approximate (≤50 block) target match. */
    | "new-unconfirmed"
    /** Endpoint exists but no pair could be derived. */
    | "unpaired"
    /** Endpoint duplicated or otherwise inconsistent — flagged for user attention. */
    | "invalid";

export type TLPairConfidence = "exact" | "approx" | "manual" | "none";

/**
 * One translocator from the user's perspective. Always has at least
 * `endpointA` (the waypoint they uploaded). `endpointB` is `null` while the
 * TL is unpaired.
 */
export interface UserTL {
    /** Stable identifier for React keys + drag operations. */
    localId: string;
    endpointA: UserTLEndpoint;
    endpointB: UserTLEndpoint | null;
    status: TLStatus;
    pairConfidence: TLPairConfidence;
    /** Identifier of the matching server segment (when status === "existing"). */
    matchedExistingSegmentKey?: string;
    /** Reason for `invalid` status, if applicable. */
    invalidReason?: string;
}

/** Payload sent to the backend on submit. */
export interface TLContributionPayload {
    translocators: Array<{
        x1: number;
        z1: number;
        x2: number;
        z2: number;
        label?: string;
    }>;
    /**
     * User-supplied (frontend-computed) batch statistics. Trusted as-is by
     * the server and stored verbatim on every audit row of the batch so
     * reviewers can gauge how well the submitter's existing TLs match
     * what's already on the server.
     */
    stats: {
        existing_match_pct: number;
        existing_pair_count: number;
    };
    /** Optional client-supplied identifier so a batch can be correlated
     * across the audit rows it produces. Server falls back to a UUID if
     * absent. */
    client_batch_id?: string;
}

export interface TLContributionResult {
    accepted: number;
    /** Number of submitted TLs the server detected as already present on the
     * map and silently dropped (no audit row written). */
    skipped_existing?: number;
    /** Server-side identifier for the batch (echoed back). */
    batch_id?: string;
}

/**
 * Payload for the manual-entry endpoint (`POST /contribute-tls/manual`).
 * No `label` (the manual flow does not collect one) and Y depths
 * (`y1` / `y2`) are optional — when omitted the server stores
 * `depth1` / `depth2` as 0.
 */
export interface TLManualContributionPayload {
    translocators: Array<{
        x1: number;
        z1: number;
        x2: number;
        z2: number;
        y1?: number;
        y2?: number;
    }>;
    client_batch_id?: string;
}
