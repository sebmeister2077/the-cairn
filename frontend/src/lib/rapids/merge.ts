// Pure merge of the two rapids sources into one marker list:
//  - recorded: rapids players saw in-game (VSProxy `--map-export`, R2 merged)
//  - generated: every rapid predicted from the world seed (Rapids Exporter mod)
//
// The proxy records the rapid's *source* block, which is exactly the block the
// generator predicts, so the two datasets match on identical integer X/Y/Z
// (verified: all 291 recorded rapids inside the scan area matched at
// dx = dy = dz = 0). That makes the dedupe a plain key lookup.
//
// Claim status is derived geometrically from the player land-claim boxes (the
// recorded `claimed` flag is unreliable, and generated rapids come from a
// claim-free local world). With ~33k rapids × ~5k boxes a linear scan is too
// slow, so the boxes are bucketed into a coarse grid first.

import type { WorldPointMarker } from "@/components/tops-map-viewer/MapViewer";
import type { GeneratedRapid, RapidOutflow } from "@/lib/rapids/generated";

/** Fill colour for a rapid source that is inside a land claim ("taken"). */
export const RAPIDS_CLAIMED_COLOR = "rgba(249, 115, 22, 0.95)"; // orange-500
/** Fill colour for a rapid source that is not claimed ("available"). */
export const RAPIDS_UNCLAIMED_COLOR = "rgba(45, 212, 191, 0.95)"; // teal-400

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface RecordedRapid {
    abs?: Partial<Vec3>;
    rel?: Partial<Vec3>;
    claimed?: boolean;
    owner?: string;
}

export interface RawPlayerClaim {
    center?: Partial<Vec3>;
    min?: Partial<Vec3>;
    max?: Partial<Vec3>;
}

/** Where a merged rapid came from. `both` = predicted AND seen in-game. */
export type RapidSource = "recorded" | "generated" | "both";

export interface RapidMarker extends WorldPointMarker {
    kind: "Rapids";
    claimed: boolean;
    source: RapidSource;
    /** 0..1. Observed rapids (recorded / both) are always 1. */
    likelihood: number;
    outflow?: RapidOutflow;
    /** Absolute Y of the source block. */
    y: number;
}

export interface RapidsCounts {
    total: number;
    /** Predicted and seen in-game. */
    confirmed: number;
    /** Seen in-game but not predicted (outside the scan, or generator miss). */
    recordedOnly: number;
    /** Generated only (not yet seen in-game). */
    predicted: number;
    /** Generated only with likelihood < 1. */
    uncertain: number;
}

export interface MergedRapids {
    markers: RapidMarker[];
    counts: RapidsCounts;
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

interface ClaimBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY: number;
    maxY: number;
}

const CLAIM_CELL = 256;
const claimCellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

export interface ClaimIndex {
    contains(x: number, z: number, y: number): boolean;
}

/** Bucket claim boxes (spawn-relative X/Z, absolute Y) into a coarse grid so
 *  each lookup only tests the boxes overlapping the point's cell. */
export function buildClaimIndex(features: RawPlayerClaim[]): ClaimIndex {
    const cells = new Map<number, ClaimBox[]>();
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
        const box: ClaimBox = {
            minX,
            maxX,
            minZ,
            maxZ,
            minY: isFiniteNumber(minY) ? minY : -Infinity,
            maxY: isFiniteNumber(maxY) ? maxY : Infinity,
        };
        const cx0 = Math.floor(minX / CLAIM_CELL);
        const cx1 = Math.floor(maxX / CLAIM_CELL);
        const cz0 = Math.floor(minZ / CLAIM_CELL);
        const cz1 = Math.floor(maxZ / CLAIM_CELL);
        for (let cx = cx0; cx <= cx1; cx++) {
            for (let cz = cz0; cz <= cz1; cz++) {
                const key = claimCellKey(cx, cz);
                const bucket = cells.get(key);
                if (bucket) bucket.push(box);
                else cells.set(key, [box]);
            }
        }
    }
    return {
        contains(x, z, y) {
            const bucket = cells.get(
                claimCellKey(Math.floor(x / CLAIM_CELL), Math.floor(z / CLAIM_CELL)),
            );
            if (!bucket) return false;
            for (const b of bucket) {
                if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y >= b.minY && y <= b.maxY) {
                    return true;
                }
            }
            return false;
        },
    };
}

// Pack integer (x, y, z) into one number: x/z offset by 2^20 (21 bits each),
// y in 0..255 (8 bits) — 50 bits total, well inside the safe-integer range.
const rapidKey = (x: number, y: number, z: number) =>
    ((x + 1_048_576) * 2_097_152 + (z + 1_048_576)) * 256 + (y & 0xff);

function makeMarker(
    x: number,
    y: number,
    z: number,
    source: RapidSource,
    likelihood: number,
    outflow: RapidOutflow | undefined,
    claimed: boolean,
): RapidMarker {
    return {
        x,
        y,
        z,
        kind: "Rapids",
        claimed,
        source,
        likelihood,
        outflow,
        color: claimed ? RAPIDS_CLAIMED_COLOR : RAPIDS_UNCLAIMED_COLOR,
    };
}

const OUTFLOW_LABEL: Record<RapidOutflow, string> = { n: "N", e: "E", s: "S", w: "W" };

function rapidDetail(m: RapidMarker): string {
    if (m.source === "both") return "Confirmed · seen in-game";
    if (m.source === "recorded") return "Seen in-game";
    const parts = [m.likelihood < 1 ? `Possible · ${Math.round(m.likelihood * 100)}%` : "Predicted"];
    if (m.outflow) parts.push(`outflow ${OUTFLOW_LABEL[m.outflow]}`);
    return parts.join(" · ");
}

export function mergeRapids(
    recorded: RecordedRapid[],
    generated: GeneratedRapid[],
    claims: ClaimIndex,
): MergedRapids {
    const byKey = new Map<number, RapidMarker>();
    for (const g of generated) {
        byKey.set(
            rapidKey(g.x, g.y, g.z),
            makeMarker(g.x, g.y, g.z, "generated", g.likelihood, g.outflow, claims.contains(g.x, g.z, g.y)),
        );
    }

    for (const r of recorded) {
        const rel = r.rel;
        if (!rel || !isFiniteNumber(rel.x) || !isFiniteNumber(rel.z)) continue;
        const absY = isFiniteNumber(r.abs?.y) ? r.abs.y : isFiniteNumber(rel.y) ? rel.y : 0;
        // Recorded coordinates are floats (`502192.0`); the generated ones are ints.
        const x = Math.round(rel.x);
        const y = Math.round(absY);
        const z = Math.round(rel.z);
        const key = rapidKey(x, y, z);
        const existing = byKey.get(key);
        if (existing) {
            // Seen in-game, so it definitely exists.
            existing.source = "both";
            existing.likelihood = 1;
            if (r.claimed === true && !existing.claimed) {
                existing.claimed = true;
                existing.color = RAPIDS_CLAIMED_COLOR;
            }
            continue;
        }
        // Trust a recorded `claimed: true`, else derive from the claim boxes.
        const claimed = r.claimed === true || claims.contains(x, z, y);
        byKey.set(key, makeMarker(x, y, z, "recorded", 1, undefined, claimed));
    }

    const markers = Array.from(byKey.values());
    const counts: RapidsCounts = {
        total: markers.length,
        confirmed: 0,
        recordedOnly: 0,
        predicted: 0,
        uncertain: 0,
    };
    for (const m of markers) {
        m.confirmed = m.source === "both";
        m.tooltip = { x: m.x, y: m.y, z: m.z, detail: rapidDetail(m) };
        if (m.source === "both") counts.confirmed++;
        else if (m.source === "recorded") counts.recordedOnly++;
        else {
            counts.predicted++;
            if (m.likelihood < 1) counts.uncertain++;
        }
    }
    return { markers, counts };
}
