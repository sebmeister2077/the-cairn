import type { WorldPointMarker } from "@/components/MapViewer";
import type { TraderMarker, ClaimTypeMap } from "@/hooks/useOverlayData";
import type { RecordedMapFeatures } from "@/hooks/useRecordedMapFeatures";
import type { TraderClaimMarker } from "@/hooks/useTraderClaims";
import { isTraderType, type TraderType } from "@/lib/trader-types";

interface ViewportBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

export interface BuildLandmarkPointsArgs {
    allLandmarks: WorldPointMarker[] | undefined;
    showLandmarks: boolean;
    showServerLandmarks: boolean;
    showTerminus: boolean;
    showTraders: boolean;
    allTraders: TraderMarker[] | undefined;
    traderColors: Record<TraderType, string>;
    traderTypeFilterSet: Set<string>;
    recordedBrokenTLsVisible: boolean;
    recordedFeatures: RecordedMapFeatures | undefined;
    rapidsVisible: boolean;
    rapidsMarkers: WorldPointMarker[] | undefined;
    claimList: TraderClaimMarker[] | undefined;
    claimTypeMap: ClaimTypeMap | undefined;
    brokenTLViewportBounds: ViewportBounds | null;
    favoriteStartingPosition: { x: number; z: number; zoom?: number } | null;
}

/**
 * Build the flat marker list handed to the viewer: landmarks (by kind gates),
 * traders (official + recorded + classified claims, deduped), viewport-culled
 * broken-TL + rapids markers, and the always-on Home glyph.
 */
export function buildLandmarkPoints({
    allLandmarks,
    showLandmarks,
    showServerLandmarks,
    showTerminus,
    showTraders,
    allTraders,
    traderColors,
    traderTypeFilterSet,
    recordedBrokenTLsVisible,
    recordedFeatures,
    rapidsVisible,
    rapidsMarkers,
    claimList,
    claimTypeMap,
    brokenTLViewportBounds,
    favoriteStartingPosition,
}: BuildLandmarkPointsArgs): WorldPointMarker[] {
    const base: WorldPointMarker[] = [];
    if (allLandmarks) {
        for (const p of allLandmarks) {
            if (p.kind === "Terminus") {
                if (showTerminus) base.push(p);
                continue;
            }
            if (p.kind === "Server") {
                const isSpawn = (p.label ?? "").trim().toLowerCase() === "spawn";
                if (showServerLandmarks || isSpawn) base.push(p);
                continue;
            }
            if (showLandmarks) base.push(p);
        }
    }
    // Traders overlay. A single toggle (`showTraders`) shows traders from
    // BOTH sources — the official contributed set and the recorded (session
    // export) set — deduped, with the per-type filter applied uniformly.
    if (showTraders) {
        const passesTypeFilter = (type: string | null | undefined) =>
            !(traderTypeFilterSet.size > 0 && isTraderType(type) && !traderTypeFilterSet.has(type));

        // Official traders.
        if (allTraders) {
            for (const t of allTraders) {
                if (!passesTypeFilter(t.trader_type)) continue;
                base.push({
                    x: t.x,
                    z: t.z,
                    kind: "Trader",
                    // label: t.label,
                    color: traderColors[t.trader_type],
                });
            }
        }

        // Recorded traders — collapsed against the official set (same type
        // within DEDUPE_RADIUS blocks) so overlapping traders don't double up.
        // A spatial hash keyed by (type, 10-block cell) keeps this O(n): each
        // recorded trader only tests the 3x3 neighbouring cells. Coordinates
        // share the same space (verified against the live traders.geojson).
        if (recordedFeatures) {
            const DEDUPE_RADIUS = 10;
            const DEDUPE_RADIUS_SQ = DEDUPE_RADIUS * DEDUPE_RADIUS;
            const officialBuckets = new Map<string, Array<{ x: number; z: number }>>();
            const cellKey = (type: string, cx: number, cz: number) => `${type}:${cx}:${cz}`;
            for (const ot of allTraders ?? []) {
                if (!isTraderType(ot.trader_type)) continue;
                const cx = Math.floor(ot.x / DEDUPE_RADIUS);
                const cz = Math.floor(ot.z / DEDUPE_RADIUS);
                const key = cellKey(ot.trader_type, cx, cz);
                const bucket = officialBuckets.get(key);
                if (bucket) bucket.push({ x: ot.x, z: ot.z });
                else officialBuckets.set(key, [{ x: ot.x, z: ot.z }]);
            }
            for (const m of recordedFeatures.traders) {
                if (!passesTypeFilter(m.traderType)) continue;
                // Only dedupe when we know the type; unknown-type recordings always show.
                if (m.traderType) {
                    const cx = Math.floor(m.x / DEDUPE_RADIUS);
                    const cz = Math.floor(m.z / DEDUPE_RADIUS);
                    let duplicate = false;
                    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
                        for (let dz = -1; dz <= 1 && !duplicate; dz++) {
                            const existing = officialBuckets.get(cellKey(m.traderType, cx + dx, cz + dz));
                            if (!existing) continue;
                            for (const p of existing) {
                                const ddx = p.x - m.x;
                                const ddz = p.z - m.z;
                                if (ddx * ddx + ddz * ddz <= DEDUPE_RADIUS_SQ) {
                                    duplicate = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (duplicate) continue;
                }
                base.push(m.traderType ? { ...m, color: traderColors[m.traderType] } : m);
            }
        }

        // Classified trader claims render as normal trader markers here (part of
        // the Traders layer), so a type you assign a claim shows up under "Show
        // Traders" — not only the dedicated claims overlay. Positions use the
        // claim's spawn-relative coords (same space as the official/recorded
        // traders). Deduped against the official + recorded traders within
        // DEDUPE_RADIUS so a claim colocated with an existing trader marker
        // doesn't double up.
        if (claimTypeMap && claimList) {
            const R = 10;
            const R_SQ = R * R;
            const buckets = new Map<string, Array<{ x: number; z: number }>>();
            const cell = (type: string, cx: number, cz: number) => `${type}:${cx}:${cz}`;
            const addBucket = (type: string, x: number, z: number) => {
                const key = cell(type, Math.floor(x / R), Math.floor(z / R));
                const b = buckets.get(key);
                if (b) b.push({ x, z });
                else buckets.set(key, [{ x, z }]);
            };
            for (const ot of allTraders ?? []) {
                if (isTraderType(ot.trader_type)) addBucket(ot.trader_type, ot.x, ot.z);
            }
            for (const rm of recordedFeatures?.traders ?? []) {
                if (rm.traderType) addBucket(rm.traderType, rm.x, rm.z);
            }
            for (const c of claimList) {
                const assigned = claimTypeMap[c.claimId];
                if (!assigned) continue;
                if (!passesTypeFilter(assigned.trader_type)) continue;
                const cx = Math.floor(c.x / R);
                const cz = Math.floor(c.z / R);
                let duplicate = false;
                for (let dx = -1; dx <= 1 && !duplicate; dx++) {
                    for (let dz = -1; dz <= 1 && !duplicate; dz++) {
                        const existing = buckets.get(cell(assigned.trader_type, cx + dx, cz + dz));
                        if (!existing) continue;
                        for (const p of existing) {
                            const ddx = p.x - c.x;
                            const ddz = p.z - c.z;
                            if (ddx * ddx + ddz * ddz <= R_SQ) {
                                duplicate = true;
                                break;
                            }
                        }
                    }
                }
                if (duplicate) continue;
                base.push({
                    x: c.x,
                    z: c.z,
                    kind: "Trader",
                    color: traderColors[assigned.trader_type],
                });
            }
        }
    }
    // Recorded broken-translocator overlay (advanced-only, own toggle). Broken
    // TLs carry an X/Y/Z hover tooltip (relative X/Z + absolute Y).
    if (recordedBrokenTLsVisible && recordedFeatures) {
        // Viewport culling for performance: only render broken TLs inside the
        // current viewport, expanded by a margin so markers pop in slightly
        // before they scroll into view. Until the first viewport is reported
        // (bounds null) we render them all so visibility never depends on the
        // debounced-bounds race; culling kicks in once bounds are known.
        const b = brokenTLViewportBounds;
        if (b) {
            const marginX = (b.maxX - b.minX) * 0.25;
            const marginZ = (b.maxZ - b.minZ) * 0.25;
            const minX = b.minX - marginX;
            const maxX = b.maxX + marginX;
            const minZ = b.minZ - marginZ;
            const maxZ = b.maxZ + marginZ;
            for (const m of recordedFeatures.brokenTLs) {
                if (m.x < minX || m.x > maxX || m.z < minZ || m.z > maxZ) continue;
                base.push(m);
            }
        } else {
            for (const m of recordedFeatures.brokenTLs) base.push(m);
        }
    }
    // Recorded rapids overlay (advanced-only, own toggle). Same viewport
    // culling as the broken TLs; markers are coloured by claimed state and
    // carry an X/Y/Z hover tooltip.
    if (rapidsVisible && rapidsMarkers) {
        const b = brokenTLViewportBounds;
        if (b) {
            const marginX = (b.maxX - b.minX) * 0.25;
            const marginZ = (b.maxZ - b.minZ) * 0.25;
            const minX = b.minX - marginX;
            const maxX = b.maxX + marginX;
            const minZ = b.minZ - marginZ;
            const maxZ = b.maxZ + marginZ;
            for (const m of rapidsMarkers) {
                if (m.x < minX || m.x > maxX || m.z < minZ || m.z > maxZ) continue;
                base.push(m);
            }
        } else {
            for (const m of rapidsMarkers) base.push(m);
        }
    }
    // Always-on house glyph for the user's saved favorite position. Drawn
    // last so the marker sits on top of any colocated landmark/trader dot.
    if (favoriteStartingPosition) {
        base.push({
            x: favoriteStartingPosition.x,
            z: favoriteStartingPosition.z,
            kind: "Home",
            label: "Home",
        });
    }
    return base;
}
