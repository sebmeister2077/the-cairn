import type { MapStats, MapTileSet } from "@/components/MapViewer";
import type { TopsMapLevelChunks, TopsMapResolutionMeta } from "@/lib/api";

export const STALE_TIME = 12 * 60 * 60 * 1000; // 12 hours
// "Recently added" window for the favourites+recent filter (request #6 from
// the fullscreen redesign): TLs whose `meta.addedAt` is within this many ms
// of "now" are considered fresh and union'd into the visible set when the
// user toggles "Emphasize recently added".
export const RECENT_TL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface TopsMapStatsResponse extends MapStats {
    default_level?: number | null;
    resolutions?: TopsMapResolutionMeta[];
}

/**
 * Compute how long (ms) the cached level info should be considered fresh based
 * on its embedded `expires_at`. We refresh a couple of minutes early so the
 * frontend never tries to render with URLs that have just expired.
 */
export function levelInfoStaleTimeMs(info: TopsMapLevelChunks | undefined): number {
    if (!info?.expires_at) return 0;
    const expiresAtMs = new Date(info.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs)) return 0;
    // Refresh 2 minutes before expiry.
    return Math.max(0, expiresAtMs - Date.now() - 2 * 60 * 1000);
}

/** Returns true if the cached level info's presigned URLs are already past expiry. */
export function isLevelInfoExpired(info: TopsMapLevelChunks | undefined): boolean {
    if (!info?.expires_at) return false;
    const expiresAtMs = new Date(info.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs)) return false;
    return expiresAtMs <= Date.now();
}

/**
 * Convert a level-info payload into the tile set the viewer renders.
 * Boundary chunks use the remainder dimensions so they line up exactly with
 * the assembled image bounds.
 */
export function levelToTileSet(info: TopsMapLevelChunks): MapTileSet {
    return {
        // Identity is just the level number. URL rotations keep the same id so
        // the viewer doesn't reset pan/zoom every time presigned URLs refresh.
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
