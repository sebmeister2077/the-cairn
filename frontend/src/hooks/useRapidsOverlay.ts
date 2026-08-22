// React Query loader for the recorded (in-game session export) *rapids*
// sources — waterfalls/rapids the community has contributed via the VSProxy
// `--map-export` writer. The merged dataset is published to the public R2
// bucket as `map-features.rapids.json` (one self-describing envelope) and
// falls back to the committed bundle for local dev (see loadMapFeatures).
//
// Coordinate handling mirrors the other recorded overlays (broken TLs, trader
// claims): markers are POSITIONED using the file's spawn-relative `rel`
// coordinates with z kept AS-IS. The recorded `claimed` flag has proven
// unreliable (the proxy tags rapids before claim data is available, so they
// arrive `claimed: false`), so we DERIVE claim status geometrically instead:
// a rapid is "claimed" if it sits inside any player land-claim box. We colour
// the marker accordingly and expose an X/Y/Z hover tooltip.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorldPointMarker } from "@/components/MapViewer";
import { loadMapFeatures } from "@/lib/mapFeatures";

/** Fill colour for a rapid source that is inside a land claim ("taken"). */
export const RAPIDS_CLAIMED_COLOR = "rgba(249, 115, 22, 0.95)"; // orange-500
/** Fill colour for a rapid source that is not claimed ("available"). */
export const RAPIDS_UNCLAIMED_COLOR = "rgba(45, 212, 191, 0.95)"; // teal-400

interface RecordedVec3 {
    x: number;
    y: number;
    z: number;
}

interface RecordedRapid {
    abs?: Partial<RecordedVec3>;
    rel?: Partial<RecordedVec3>;
    claimed?: boolean;
    owner?: string;
}

interface RawPlayerClaim {
    center?: Partial<RecordedVec3>;
    min?: Partial<RecordedVec3>;
    max?: Partial<RecordedVec3>;
}

/** A player-claim cuboid: spawn-relative X/Z, absolute Y (matching rapids). */
interface ClaimBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY: number;
    maxY: number;
}

export interface RapidMarker extends WorldPointMarker {
    /** True when the rapid sits inside a player land claim. Drives the colour. */
    claimed: boolean;
}

// Bumped when the claim-derivation logic changes so stale cached markers from
// the recorded-only version are dropped.
export const RAPIDS_QUERY_KEY = ["recorded-rapids", "v2-derived-claims"] as const;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function buildClaimBoxes(features: RawPlayerClaim[]): ClaimBox[] {
    const boxes: ClaimBox[] = [];
    for (const c of features) {
        const center = c.center ?? {};
        const min = c.min ?? {};
        const max = c.max ?? {};
        const minX = isFiniteNumber(min.x) ? min.x : center.x;
        const maxX = isFiniteNumber(max.x) ? max.x : center.x;
        const minZ = isFiniteNumber(min.z) ? min.z : center.z;
        const maxZ = isFiniteNumber(max.z) ? max.z : center.z;
        const minY = isFiniteNumber(min.y) ? min.y : center.y;
        const maxY = isFiniteNumber(max.y) ? max.y : center.y;
        if (
            !isFiniteNumber(minX) ||
            !isFiniteNumber(maxX) ||
            !isFiniteNumber(minZ) ||
            !isFiniteNumber(maxZ)
        ) {
            continue;
        }
        boxes.push({
            minX,
            maxX,
            minZ,
            maxZ,
            minY: isFiniteNumber(minY) ? minY : -Infinity,
            maxY: isFiniteNumber(maxY) ? maxY : Infinity,
        });
    }
    return boxes;
}

function insideAnyClaim(boxes: ClaimBox[], x: number, z: number, y: number): boolean {
    for (const b of boxes) {
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y >= b.minY && y <= b.maxY) {
            return true;
        }
    }
    return false;
}

function parseRapids(features: RecordedRapid[], claimBoxes: ClaimBox[]): RapidMarker[] {
    const out: RapidMarker[] = [];
    for (const r of features) {
        const rel = r.rel;
        const abs = r.abs;
        if (!rel || !isFiniteNumber(rel.x) || !isFiniteNumber(rel.z)) continue;
        const absY = isFiniteNumber(abs?.y) ? abs.y : isFiniteNumber(rel.y) ? rel.y : 0;
        // Trust a recorded `claimed: true`, else derive from the claim boxes.
        const claimed = r.claimed === true || insideAnyClaim(claimBoxes, rel.x, rel.z, absY);
        out.push({
            x: rel.x,
            z: rel.z,
            kind: "Rapids",
            claimed,
            color: claimed ? RAPIDS_CLAIMED_COLOR : RAPIDS_UNCLAIMED_COLOR,
            tooltip: { x: rel.x, y: absY, z: rel.z },
        });
    }
    return out;
}

/**
 * Load + parse the recorded rapids dataset, deriving each rapid's claim status
 * from the player land-claim boxes. Pass `enabled: false` to keep the fetches
 * from running until the overlay toggle is on. Both files are fetched from R2
 * when configured, else the committed bundle, and are missing-safe (no data
 * resolves to an empty list — rapids then fall back to their recorded flag).
 */
export function useRapidsOverlay(enabled: boolean): UseQueryResult<RapidMarker[]> {
    return useQuery<RapidMarker[]>({
        queryKey: [...RAPIDS_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ signal }) => {
            const [rapids, claims] = await Promise.all([
                loadMapFeatures<RecordedRapid>("rapids", signal),
                loadMapFeatures<RawPlayerClaim>("playerclaims", signal),
            ]);
            return parseRapids(rapids, buildClaimBoxes(claims));
        },
    });
}

