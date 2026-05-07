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
    contributor?: string;
}

export interface TLContributionResult {
    accepted: number;
    pending_id?: string;
}
