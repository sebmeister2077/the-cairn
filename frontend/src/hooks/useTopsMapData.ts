/**
 * Lightweight hook that returns the global TOPS map's `tileSet` + `stats`
 * for components that just want to render the map (no resolution selector,
 * no URL syncing, no admin tooling).
 *
 * Internally reuses the same React Query keys as {@link TOPSMapViewPage} so
 * the heavy `getTopsMapStats` + `getTopsMapLevel` payloads are shared
 * across pages.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
    getTopsMapStats,
    getTopsMapLevel,
    type TopsMapLevelChunks,
    type TopsMapResolutionMeta,
} from "@/lib/api";
import type { MapStats, MapTileSet } from "@/components/MapViewer";

const STALE_TIME = 12 * 60 * 60 * 1000;

interface TopsMapStatsResponse extends MapStats {
    default_level?: number | null;
    resolutions?: TopsMapResolutionMeta[];
}

function levelInfoStaleTimeMs(info: TopsMapLevelChunks | undefined): number {
    if (!info?.expires_at) return 0;
    const expiresAtMs = new Date(info.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs)) return 0;
    return Math.max(0, expiresAtMs - Date.now() - 2 * 60 * 1000);
}

function isLevelInfoExpired(info: TopsMapLevelChunks | undefined): boolean {
    if (!info?.expires_at) return false;
    const expiresAtMs = new Date(info.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs)) return false;
    return expiresAtMs <= Date.now();
}

function levelToTileSet(info: TopsMapLevelChunks): MapTileSet {
    return {
        id: info.level,
        imageWidth: info.image_w,
        imageHeight: info.image_h,
        chunks: info.chunks.map((c) => {
            const px = c.cx * info.chunk_w;
            const py = c.cy * info.chunk_h;
            return {
                cx: c.cx,
                cy: c.cy,
                url: c.url,
                px,
                py,
                w: Math.min(info.chunk_w, info.image_w - px),
                h: Math.min(info.chunk_h, info.image_h - py),
            };
        }),
    };
}

export interface TopsMapData {
    tileSet: MapTileSet | null;
    stats: MapStats | null;
    isLoading: boolean;
    error: string | null;
}

/** Returns the TOPS map's default-level tile set and stats. */
export function useTopsMapData(): TopsMapData {
    const statsQuery = useQuery<TopsMapStatsResponse>({
        queryKey: ["tops-map-stats"],
        queryFn: getTopsMapStats,
        staleTime: STALE_TIME,
    });

    // Pick the server-recommended default; fall back to the highest completed level.
    const level = useMemo<number | null>(() => {
        const data = statsQuery.data;
        if (!data) return null;
        if (data.default_level != null && Number.isFinite(data.default_level)) {
            return data.default_level;
        }
        const completed = (data.resolutions ?? [])
            .filter((r) => r.status === "complete")
            .map((r) => r.level)
            .sort((a, b) => b - a);
        return completed[0] ?? null;
    }, [statsQuery.data]);

    const levelInfoQuery = useQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", level],
        queryFn: () => {
            if (level == null) throw new Error("No resolution level available yet");
            return getTopsMapLevel(level);
        },
        enabled: level != null,
        staleTime: ({ state }) => levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
    });

    const tileSet = useMemo(() => {
        const info = levelInfoQuery.data;
        if (!info || isLevelInfoExpired(info)) return null;
        return levelToTileSet(info);
    }, [levelInfoQuery.data]);

    const stats = useMemo<MapStats | null>(() => {
        const info = levelInfoQuery.data;
        const infoUsable = info && !isLevelInfoExpired(info);
        if (statsQuery.data) {
            if (!infoUsable) return statsQuery.data;
            return {
                ...statsQuery.data,
                width_blocks: info.width_blocks,
                height_blocks: info.height_blocks,
                start_x: info.start_x,
                start_z: info.start_z,
            };
        }
        if (!infoUsable) return null;
        return {
            pieces: 0,
            size_mb: 0,
            width_chunks: 0,
            height_chunks: 0,
            width_blocks: info.width_blocks,
            height_blocks: info.height_blocks,
            start_x: info.start_x,
            start_z: info.start_z,
        };
    }, [statsQuery.data, levelInfoQuery.data]);

    const error =
        statsQuery.error instanceof Error
            ? statsQuery.error.message
            : levelInfoQuery.error instanceof Error
                ? levelInfoQuery.error.message
                : null;

    return {
        tileSet,
        stats,
        isLoading: statsQuery.isFetching || (level != null && levelInfoQuery.isFetching && !tileSet),
        error,
    };
}
