// React Query loader for the static trader-*claim* boxes bundled with the
// frontend (`frontend/src/assets/MapFeaturesJson/map-features.traderclaims.json`,
// emitted by the VsClayProxy `--map-export` split writer). These are the ~56k
// land-claim volumes owned by traders across the explored world — far more
// than the individual trader NPCs we've actually recorded, and with NO trader
// type of their own.
//
// We dedupe by canonical claim id (the quantised absolute `center`) since the
// export contains many duplicate rows, then position each marker using the
// spawn-relative `rel` coords (same convention as the recorded traders / TLs
// overlay — see useRecordedMapFeatures for the rationale). The claim id is the
// join key against the `trader_claim_types.json` overlay (see
// useTraderClaimTypesOverlay) and the proxy's authoritative submissions.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { claimIdFromCenter } from "@/lib/trader-types";
import { loadMapFeatures } from "@/lib/mapFeatures";

interface RecordedVec3 {
    x: number;
    y: number;
    z: number;
}

interface RecordedTraderClaim {
    entityId?: number;
    type?: string;
    owner?: string;
    center?: Partial<RecordedVec3>;
    rel?: Partial<RecordedVec3>;
    min?: Partial<RecordedVec3>;
    max?: Partial<RecordedVec3>;
}

export interface TraderClaimMarker {
    /** Canonical claim id ("x:y:z" of the absolute centre). Join key against
     *  the type overlay + proxy submissions. */
    claimId: string;
    /** Spawn-relative X used for map positioning. */
    x: number;
    /** Spawn-relative Z used for map positioning. */
    z: number;
    /** Absolute world centre — sent with a manual mark so the backend can
     *  store coordinates alongside the assignment. */
    center: RecordedVec3;
}

export const TRADER_CLAIMS_QUERY_KEY = ["trader-claims"] as const;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function parseTraderClaims(features: RecordedTraderClaim[]): TraderClaimMarker[] {
    const seen = new Set<string>();
    const out: TraderClaimMarker[] = [];
    for (const c of features) {
        const rel = c.rel;
        const center = c.center;
        if (!rel || !isFiniteNumber(rel.x) || !isFiniteNumber(rel.z)) continue;
        if (
            !center ||
            !isFiniteNumber(center.x) ||
            !isFiniteNumber(center.y) ||
            !isFiniteNumber(center.z)
        ) {
            continue;
        }
        const abs: RecordedVec3 = { x: center.x, y: center.y, z: center.z };
        const claimId = claimIdFromCenter(abs);
        if (seen.has(claimId)) continue;
        seen.add(claimId);
        out.push({ claimId, x: rel.x, z: rel.z, center: abs });
    }
    return out;
}

/**
 * Load + dedupe the static trader-claim boxes. Pass `enabled: false` to keep
 * the (large) fetch from running until the overlay toggle is on.
 */
export function useTraderClaims(enabled: boolean): UseQueryResult<TraderClaimMarker[]> {
    return useQuery<TraderClaimMarker[]>({
        queryKey: [...TRADER_CLAIMS_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ signal }) => {
            const features = await loadMapFeatures<RecordedTraderClaim>("traderclaims", signal);
            return parseTraderClaims(features);
        },
    });
}
