// React Query loader for the combined Rapids overlay. Like the Traders layer,
// one toggle shows several sources merged and deduped:
//  - recorded rapids players saw in-game (VSProxy `--map-export`, published to
//    R2 as `map-features.rapids.json`, bundled fallback for local dev);
//  - generated rapids predicted from the world seed by the Rapids Exporter mod
//    (bundled lazy chunk, see lib/rapids/generated.ts).
//
// Coordinate handling mirrors the other recorded overlays (broken TLs, trader
// claims): markers are POSITIONED using spawn-relative X/Z with z kept AS-IS;
// the generated export uses the same spawn so both share one space. Claim
// status is DERIVED geometrically from the player land-claim boxes (see
// lib/rapids/merge.ts) and drives the marker colour.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { loadMapFeatures } from "@/lib/tops-map-view/mapFeatures";
import { loadGeneratedRapids } from "@/lib/rapids/generated";
import {
    buildClaimIndex,
    mergeRapids,
    type MergedRapids,
    type RawPlayerClaim,
    type RecordedRapid,
} from "@/lib/rapids/merge";

export {
    RAPIDS_CLAIMED_COLOR,
    RAPIDS_UNCLAIMED_COLOR,
    type MergedRapids,
    type RapidMarker,
    type RapidsCounts,
} from "@/lib/rapids/merge";

// Bumped whenever the merge/derivation logic changes so stale cached data from
// an older shape is dropped.
export const RAPIDS_QUERY_KEY = ["rapids", "v3-merged-generated"] as const;

/**
 * Load + merge every rapids source. Pass `enabled: false` to keep the fetches
 * from running until the overlay toggle is on. Each source is missing-safe:
 * recorded/claims resolve to empty lists without data, and a failed generated
 * chunk falls back to recorded-only rapids.
 */
export interface RapidsOverlayData extends MergedRapids {
    /** Half-size of the generated scan square (blocks), or null without generated data. */
    scanRadiusBlocks: number | null;
}

export function useRapidsOverlay(enabled: boolean): UseQueryResult<RapidsOverlayData> {
    return useQuery<RapidsOverlayData>({
        queryKey: [...RAPIDS_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ signal }) => {
            const [recorded, claims, generated] = await Promise.all([
                loadMapFeatures<RecordedRapid>("rapids", signal),
                loadMapFeatures<RawPlayerClaim>("playerclaims", signal),
                loadGeneratedRapids().catch((err: unknown) => {
                    console.warn("Generated rapids failed to load; showing recorded only", err);
                    return null;
                }),
            ]);
            const merged = mergeRapids(recorded, generated?.rapids ?? [], buildClaimIndex(claims));
            return { ...merged, scanRadiusBlocks: generated?.scan.radiusBlocks ?? null };
        },
    });
}
