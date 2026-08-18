// React Query loader for the recorded (in-game session export) map features:
// broken translocators and traders. The source is a pair of split JSON assets
// bundled with the frontend, one per feature category
// (`frontend/src/assets/MapFeaturesJson/map-features.translocators.json` and
// `…/map-features.traders.json`). Each file is a self-describing envelope
// (`{ generatedUtc, upstream, worldSpawn, category, count, features[] }`)
// emitted verbatim by the VSProxy `--map-export` split writer. We pull them
// in via dynamic `import()` — this keeps them out of the main bundle and only
// downloads the chunks once a user actually enables one of the recorded-features
// toggles.
//
// Coordinate handling (see plan): markers are POSITIONED using the file's
// spawn-relative `rel` coordinates with z kept AS-IS (not negated like the
// backend GeoJSON overlays). Broken-TL hover tooltips surface relative X/Z
// plus the ABSOLUTE Y (the true in-game altitude).

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorldPointMarker } from "@/components/MapViewer";
import { TRADER_TYPE_COLORS, mapExportTraderType, type TraderType } from "@/lib/trader-types";
import { loadMapFeatures } from "@/lib/mapFeatures";

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

function parseRecordedMapFeatures(
    translocatorFeatures: RecordedTranslocator[],
    traderFeatures: RecordedTrader[],
): RecordedMapFeatures {
    const brokenTLs: WorldPointMarker[] = [];
    for (const tl of translocatorFeatures) {
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
    for (const tr of traderFeatures) {
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
 * Load + parse the recorded map-features assets. Pass `enabled: false` to keep
 * the network fetches from running until a toggle is on. The two split files are
 * fetched in parallel (from R2 when configured, else the committed bundle) and
 * each is missing-safe (a category with no data resolves to an empty list).
 */
export function useRecordedMapFeatures(enabled: boolean): UseQueryResult<RecordedMapFeatures> {
    return useQuery<RecordedMapFeatures>({
        queryKey: [...RECORDED_MAP_FEATURES_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async ({ signal }) => {
            const [translocatorFeatures, traderFeatures] = await Promise.all([
                loadMapFeatures<RecordedTranslocator>("translocators", signal),
                loadMapFeatures<RecordedTrader>("traders", signal),
            ]);
            return parseRecordedMapFeatures(translocatorFeatures, traderFeatures);
        },
    });
}
