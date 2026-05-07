/**
 * Pair user-uploaded translocator waypoints with each other and detect
 * which ones already exist on the server.
 *
 * Algorithm summary (per-TL) — pairing is **bidirectional**:
 *   1. Parse coordinates out of self's label. If absent → unpaired.
 *   2. Verify the parsed-target distance lies within the typical TL spacing
 *      window (1000–14000 blocks). If not → unpaired.
 *   3. Find every other unpaired waypoint `c` whose actual position is
 *      within `APPROX_MATCH_RADIUS` of self's parsed target AND whose own
 *      label parses to coords within `APPROX_MATCH_RADIUS` of self's
 *      actual position (symmetric).
 *   4. Among the symmetric candidates, pick the one with the smallest
 *      worst-direction distance. Confidence is `"exact"` if both directions
 *      are within `EXACT_MATCH_RADIUS` OR there is exactly one symmetric
 *      candidate; otherwise `"approx"` (surfaces as `new-unconfirmed`).
 *   5. If no symmetric partner exists → unpaired. One-way matches (label
 *      points at the other side, but the other side's label points
 *      elsewhere) are rejected, since they led to obviously wrong pairings
 *      in practice.
 *
 * Independently, every formed pair is checked against the server's existing
 * translocator segments — if BOTH endpoints fall within a tolerance of the
 * same server segment (orientation-agnostic), the pair is upgraded to
 * `existing`. The tolerance is `EXACT_MATCH_RADIUS` (7 blocks) for confident
 * pairings, and the more permissive `EXISTING_MATCH_RADIUS` (100 blocks) for
 * `new-unconfirmed` pairings — since those endpoints are uncertain to
 * begin with, a generous radius prevents duplicate submissions of TLs that
 * are already on the map.
 */

import type { WorldLineSegment } from "@/components/MapViewer";
import type {
    ParsedWaypoint,
    UserTL,
    UserTLEndpoint,
    TLStatus,
    TLPairConfidence,
} from "@/models/contributeTLs";
import { parseLabelCoords } from "./tl-parser";

/** Match radius used for Pass-3 exact pairing and endpoint snapping. */
export const EXACT_MATCH_RADIUS = 20;
/**
 * Tolerance used by the bidirectional pairing check. A pair is auto-formed
 * only when EACH waypoint's parsed-label target lies within this many
 * blocks of the OTHER waypoint's actual position. Players occasionally
 * round / mistype labels by a few hundred blocks, so this is intentionally
 * generous — but it must remain symmetric (one-way matches are rejected,
 * because they led to obviously wrong pairings in practice).
 */
export const APPROX_MATCH_RADIUS = 400;
/**
 * Generous tolerance used only when promoting a `new-unconfirmed` user pair
 * to `existing`. Confident pairs still use the strict `EXACT_MATCH_RADIUS`
 * — we only loosen the check when the user pair itself is uncertain.
 */
export const EXISTING_MATCH_RADIUS = 200;
/** Minimum sane label-target distance to even attempt label-based pairing. */
export const MIN_TL_DISTANCE = 1000;
/** Maximum sane label-target distance. Beyond this the label is likely stale. */
export const MAX_TL_DISTANCE = 14000;

function dist2(ax: number, az: number, bx: number, bz: number): number {
    const dx = ax - bx;
    const dz = az - bz;
    return dx * dx + dz * dz;
}

function dist(ax: number, az: number, bx: number, bz: number): number {
    return Math.sqrt(dist2(ax, az, bx, bz));
}

/** Stable identifier for a server segment, orientation-agnostic. */
export function segmentKey(s: WorldLineSegment): string {
    // Sort endpoints so "A→B" and "B→A" produce the same key.
    if (s.x1 < s.x2 || (s.x1 === s.x2 && s.z1 <= s.z2)) {
        return `${s.x1},${s.z1}|${s.x2},${s.z2}`;
    }
    return `${s.x2},${s.z2}|${s.x1},${s.z1}`;
}

/**
 * Return the nearest server segment for which BOTH endpoints fall within
 * `radius` blocks of (a, b) — orientation-agnostic. Returns `null` if no
 * such segment exists.
 */
export function endpointMatchesPair(
    a: { x: number; z: number },
    b: { x: number; z: number },
    segments: WorldLineSegment[],
    radius: number = EXACT_MATCH_RADIUS,
): WorldLineSegment | null {
    const r2 = radius * radius;
    for (const seg of segments) {
        const a1 = dist2(a.x, a.z, seg.x1, seg.z1) <= r2 && dist2(b.x, b.z, seg.x2, seg.z2) <= r2;
        const a2 = dist2(a.x, a.z, seg.x2, seg.z2) <= r2 && dist2(b.x, b.z, seg.x1, seg.z1) <= r2;
        if (a1 || a2) return seg;
    }
    return null;
}

function makeEndpoint(w: ParsedWaypoint): UserTLEndpoint {
    return { x: w.x, z: w.z, sourceWaypointIndex: w.index, label: w.name };
}

interface PairingResult {
    partnerIndex: number;
    confidence: TLPairConfidence;
}

/**
 * For the given waypoint, find an unpaired partner using the bidirectional
 * label-coord algorithm described at the top of this file.
 *
 * A candidate `c` is considered "symmetric" with `self` iff:
 *   1. `self`'s label parses to coords within {@link APPROX_MATCH_RADIUS}
 *      of `c`'s actual position, AND
 *   2. `c`'s label parses to coords within {@link APPROX_MATCH_RADIUS} of
 *      `self`'s actual position.
 *
 * Any one-way match (label points at the other side, but the other side's
 * label points elsewhere) is rejected outright — those nearly always turn
 * out to be wrong pairings in practice.
 *
 * Confidence: `"exact"` if both directions are within {@link
 * EXACT_MATCH_RADIUS} OR if there's only one symmetric candidate within
 * {@link APPROX_MATCH_RADIUS}; otherwise `"approx"` (will surface as
 * `new-unconfirmed` for the user to verify).
 */
function findPartner(
    self: ParsedWaypoint,
    candidates: ParsedWaypoint[],
    consumed: Set<number>,
): PairingResult | null {
    const target = parseLabelCoords(self.name);
    if (!target) return null;

    const labelDist = dist(self.x, self.z, target.x, target.z);
    if (labelDist < MIN_TL_DISTANCE || labelDist > MAX_TL_DISTANCE) return null;

    const approxR2 = APPROX_MATCH_RADIUS * APPROX_MATCH_RADIUS;
    const exactR2 = EXACT_MATCH_RADIUS * EXACT_MATCH_RADIUS;

    let bestIdx = -1;
    // Score the symmetry by the worse of the two distances — a partner that
    // is close in both directions wins over one that's tight in one
    // direction and loose in the other.
    let bestScore = Infinity;
    let bestForward = Infinity;
    let bestBackward = Infinity;
    let symmetricCount = 0;

    for (let i = 0; i < candidates.length; i++) {
        if (consumed.has(i)) continue;
        const c = candidates[i];
        if (c.index === self.index) continue;

        // Forward: self's label → c's actual position.
        const dForward2 = dist2(c.x, c.z, target.x, target.z);
        if (dForward2 > approxR2) continue;

        // Backward: c's label → self's actual position. Required for the
        // pair to be considered symmetric.
        const cTarget = parseLabelCoords(c.name);
        if (!cTarget) continue;
        const dBackward2 = dist2(self.x, self.z, cTarget.x, cTarget.z);
        if (dBackward2 > approxR2) continue;

        symmetricCount++;
        const score = Math.max(dForward2, dBackward2);
        if (score < bestScore) {
            bestScore = score;
            bestIdx = i;
            bestForward = dForward2;
            bestBackward = dBackward2;
        }
    }

    if (bestIdx < 0) return null;

    const bothExact = bestForward <= exactR2 && bestBackward <= exactR2;
    const confidence: TLPairConfidence =
        bothExact || symmetricCount === 1 ? "exact" : "approx";
    return { partnerIndex: bestIdx, confidence };
}

/**
 * Run the full pairing + existing-detection pipeline on the parsed
 * translocator waypoints.
 */
export function pairUserTLs(
    waypoints: ParsedWaypoint[],
    serverSegments: WorldLineSegment[],
): UserTL[] {
    const consumed = new Set<number>();
    const out: UserTL[] = [];
    let nextId = 0;

    // Pass 1: try to pair every waypoint whose label parses. We iterate
    // twice ("label-parseable first") so a waypoint with an unparseable
    // label — e.g. "(5300,14800)" if regex tightens, or just garbage —
    // can still be claimed by another TL whose label *does* parse and
    // points to it. Without this, the unparseable side gets emitted as
    // `unpaired` and consumed before the parseable side gets its turn.
    for (let i = 0; i < waypoints.length; i++) {
        if (consumed.has(i)) continue;
        const self = waypoints[i];
        // Skip on this pass if the label has no coords — give a parseable
        // sibling the chance to claim it first.
        if (!parseLabelCoords(self.name)) continue;
        const partner = findPartner(self, waypoints, consumed);
        if (!partner) continue;

        consumed.add(i);
        consumed.add(partner.partnerIndex);

        const a = makeEndpoint(self);
        const b = makeEndpoint(waypoints[partner.partnerIndex]);

        const existingRadius =
            partner.confidence === "exact" ? EXACT_MATCH_RADIUS : EXISTING_MATCH_RADIUS;
        const matched = endpointMatchesPair(a, b, serverSegments, existingRadius);

        const status: TLStatus = matched
            ? "existing"
            : partner.confidence === "exact"
                ? "new-confirmed"
                : "new-unconfirmed";

        out.push({
            localId: `tl-${nextId++}`,
            endpointA: a,
            endpointB: b,
            status,
            pairConfidence: partner.confidence,
            matchedExistingSegmentKey: matched ? segmentKey(matched) : undefined,
        });
    }

    // Pass 2: emit everything still unconsumed as unpaired (preserving
    // original waypoint order).
    for (let i = 0; i < waypoints.length; i++) {
        if (consumed.has(i)) continue;
        consumed.add(i);
        out.push({
            localId: `tl-${nextId++}`,
            endpointA: makeEndpoint(waypoints[i]),
            endpointB: null,
            status: "unpaired",
            pairConfidence: "none",
        });
    }

    return validateUserTLs(out);
}

/**
 * Re-classify a single user TL after the user has edited one of its
 * endpoints. Re-runs the existing-segment check against the server data.
 * Does NOT re-pair (the user explicitly chose this pairing).
 */
export function reclassifyUserTL(tl: UserTL, serverSegments: WorldLineSegment[]): UserTL {
    if (!tl.endpointB) {
        return { ...tl, status: "unpaired", matchedExistingSegmentKey: undefined };
    }
    // Mirror pairUserTLs: confident pairings use the strict radius; only
    // unconfirmed pairings get the generous existing-match tolerance.
    const existingRadius =
        tl.pairConfidence === "exact" || tl.pairConfidence === "manual"
            ? EXACT_MATCH_RADIUS
            : EXISTING_MATCH_RADIUS;
    const matched = endpointMatchesPair(tl.endpointA, tl.endpointB, serverSegments, existingRadius);
    if (matched) {
        return {
            ...tl,
            status: "existing",
            matchedExistingSegmentKey: segmentKey(matched),
        };
    }
    // Re-derive whether the existing pairing is still "exact" or "approx" by
    // looking at the original parse confidence + current distance. We keep
    // the user's manual pairing decision but downgrade to `new-unconfirmed`
    // if we can no longer prove `new-confirmed`.
    const status: TLStatus =
        tl.pairConfidence === "exact" ? "new-confirmed" : "new-unconfirmed";
    return { ...tl, status, matchedExistingSegmentKey: undefined };
}

/**
 * Flag obviously-inconsistent TLs as `invalid` (e.g. duplicate endpoint
 * coordinates). Runs at the end of {@link pairUserTLs}.
 */
function validateUserTLs(tls: UserTL[]): UserTL[] {
    // Detect endpoints used by more than one TL — likely operator error.
    const seen = new Map<string, number>();
    const dupKeys = new Set<string>();
    for (const tl of tls) {
        for (const ep of [tl.endpointA, tl.endpointB]) {
            if (!ep) continue;
            const k = `${ep.x},${ep.z}`;
            const c = (seen.get(k) ?? 0) + 1;
            seen.set(k, c);
            if (c > 1) dupKeys.add(k);
        }
    }
    if (dupKeys.size === 0) return tls;
    return tls.map((tl) => {
        const aKey = `${tl.endpointA.x},${tl.endpointA.z}`;
        const bKey = tl.endpointB ? `${tl.endpointB.x},${tl.endpointB.z}` : null;
        if (dupKeys.has(aKey) || (bKey && dupKeys.has(bKey))) {
            return { ...tl, status: "invalid", invalidReason: "Duplicate endpoint coordinates" };
        }
        return tl;
    });
}

/** Build the set of server segment keys referenced by the user's TLs. */
export function matchedServerSegmentKeys(userTLs: UserTL[]): Set<string> {
    const out = new Set<string>();
    for (const tl of userTLs) {
        if (tl.matchedExistingSegmentKey) out.add(tl.matchedExistingSegmentKey);
    }
    return out;
}
