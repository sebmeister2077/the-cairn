// React Query loader for the recorded (in-game session export) map features:
// broken translocators and traders. The source is a large JSON asset bundled
// with the frontend (`frontend/src/assets/MapFeaturesJson/map-features.json`),
// so we pull it in via a dynamic `import()` — this keeps it out of the main
// bundle and only downloads the chunk once a user actually enables one of the
// recorded-features toggles.
//
// Coordinate handling (see plan): markers are POSITIONED using the file's
// spawn-relative `rel` coordinates with z kept AS-IS (not negated like the
// backend GeoJSON overlays). Broken-TL hover tooltips surface relative X/Z
// plus the ABSOLUTE Y (the true in-game altitude).

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorldPointMarker } from "@/components/MapViewer";
import { TRADER_TYPE_COLORS, mapExportTraderType, type TraderType } from "@/lib/trader-types";

interface RecordedVec3 {
    x: number;
    y: number;
    z: number;
}

interface RecordedTranslocator {
    abs?: Partial<RecordedVec3>;
    rel?: Partial<RecordedVec3>;
    state?: string;
    facing?: string;
    code?: string;
}

interface RecordedTrader {
    entityId?: number;
    type?: string;
    abs?: Partial<RecordedVec3>;
    rel?: Partial<RecordedVec3>;
    code?: string;
}

interface RecordedMapFeaturesFile {
    translocators?: RecordedTranslocator[];
    traders?: RecordedTrader[];
}

export interface RecordedTraderMarker extends WorldPointMarker {
    /** Canonical trader type (mapped from the export code), or `null` when
     *  the code was unrecognised. Used to dedupe against the official
     *  traders overlay by matching type. */
    traderType: TraderType | null;
}

export interface RecordedMapFeatures {
    /** Broken-translocator point markers (kind `"BrokenTL"`). */
    brokenTLs: WorldPointMarker[];
    /** Trader point markers (kind `"Trader"`), colored by mapped type. */
    traders: RecordedTraderMarker[];
}

export const RECORDED_MAP_FEATURES_QUERY_KEY = ["recorded-map-features"] as const;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function parseRecordedMapFeatures(file: RecordedMapFeaturesFile): RecordedMapFeatures {
    const brokenTLs: WorldPointMarker[] = [];
    for (const tl of file.translocators ?? []) {
        const rel = tl.rel;
        const abs = tl.abs;
        if (!rel || !isFiniteNumber(rel.x) || !isFiniteNumber(rel.z)) continue;
        // Position: relative X/Z kept as-is. This is empirically the space the
        // viewer/official overlays live in (verified against the live
        // traders.geojson — recorded `rel` lines up with official markers to
        // within a few blocks, whereas negating Z is off by hundreds+). Hover
        // tooltip shows the raw relative X/Z + absolute Y (true altitude).
        const tipY = isFiniteNumber(abs?.y) ? abs.y : isFiniteNumber(rel.y) ? rel.y : 0;
        brokenTLs.push({
            x: rel.x,
            z: rel.z,
            kind: "BrokenTL",
            tooltip: { x: rel.x, y: tipY, z: rel.z },
        });
    }

    const traders: RecordedTraderMarker[] = [];
    for (const tr of file.traders ?? []) {
        const rel = tr.rel;
        if (!rel || !isFiniteNumber(rel.x) || !isFiniteNumber(rel.z)) continue;
        const mapped = mapExportTraderType(tr.type);
        // Relative X/Z as-is (same convention as the official overlays).
        traders.push({
            x: rel.x,
            z: rel.z,
            kind: "Trader",
            color: mapped ? TRADER_TYPE_COLORS[mapped] : undefined,
            traderType: mapped,
        });
    }

    return { brokenTLs, traders };
}

/**
 * Load + parse the recorded map-features asset. Pass `enabled: false` to keep
 * the dynamic import (and its network chunk) from loading until a toggle is on.
 */
export function useRecordedMapFeatures(enabled: boolean): UseQueryResult<RecordedMapFeatures> {
    return useQuery<RecordedMapFeatures>({
        queryKey: [...RECORDED_MAP_FEATURES_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async () => {
            const mod = (await import(
                "@/assets/MapFeaturesJson/map-features.json"
            )) as { default: RecordedMapFeaturesFile };
            return parseRecordedMapFeatures(mod.default ?? {});
        },
    });
}
