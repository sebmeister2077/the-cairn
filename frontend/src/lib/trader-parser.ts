/**
 * Trader extraction from a chat-log dump.
 *
 * Strategy: reuse ``parseChatLogWaypoints`` from [tl-parser.ts] to walk
 * the ``/waypoint list details`` block (so the "joined TOPS server" +
 * "Your waypoints:" sentinels still gate the parse), then keep only
 * entries whose ``icon === "trader"``. The Vintage Story client emits
 * the icon name verbatim per line, e.g.
 *
 *     562: Treasure Hunter at 244, 121, 753 #F9D0DC trader
 *
 * so a single equality check picks every trader waypoint without false
 * positives. The waypoint name then feeds [trader-types.ts#inferTraderType]
 * to populate a type hint that the user can override before submitting.
 *
 * World-coordinate convention matches the rest of the frontend (+Z = north
 * in-game / on the TOPS map). The backend negates Z on the way into the
 * geojson so the on-disk file matches the landmarks/translocators convention.
 */

import { parseChatLogWaypoints } from "@/lib/tl-parser";
import { inferTraderType, type TraderCandidate, type TraderType } from "@/lib/trader-types";

let _localIdCounter = 0;
function nextLocalId(): string {
    _localIdCounter += 1;
    return `trader-${Date.now().toString(36)}-${_localIdCounter.toString(36)}`;
}

export interface ExtractTradersResult {
    candidates: TraderCandidate[];
    /** Total parsed waypoints in the block (whether trader or not). */
    parsedWaypointCount: number;
    /** Number of trader-icon waypoints found. Equal to
     *  ``candidates.length`` unless caller post-filters. */
    traderCount: number;
}

export function extractTradersFromChatLog(text: string): ExtractTradersResult {
    const waypoints = parseChatLogWaypoints(text);
    const candidates: TraderCandidate[] = [];
    for (const wp of waypoints) {
        if (wp.icon !== "trader") continue;
        const inferred = inferTraderType(wp.name);
        candidates.push({
            localId: nextLocalId(),
            x: wp.x,
            y: wp.y,
            z: wp.z,
            label: wp.name,
            trader_type: inferred.type,
            inferred,
        });
    }
    return {
        candidates,
        parsedWaypointCount: waypoints.length,
        traderCount: candidates.length,
    };
}

/** Build a blank manual-entry candidate (factory used by the manual flow). */
export function blankTraderCandidate(type: TraderType | null = null): TraderCandidate {
    return {
        localId: nextLocalId(),
        x: 0,
        z: 0,
        label: "",
        trader_type: type,
    };
}

/**
 * Average confidence across a candidate batch. Used in the submission
 * stats so the admin review surface knows roughly how trustworthy the
 * type-inference column is for the batch.
 */
export function averageInferredConfidence(candidates: TraderCandidate[]): number {
    if (candidates.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (const c of candidates) {
        if (c.inferred) {
            sum += c.inferred.confidence;
            n += 1;
        }
    }
    return n === 0 ? 0 : sum / n;
}
