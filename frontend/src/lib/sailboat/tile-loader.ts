// Proxy-backed tile loader for the sailboat route planner.
//
// WC tiles have no CORS headers, so a cross-origin `<img>`/`fetch` can't be
// read back as pixels. We route the bytes through our same-origin backend
// (`GET /api/webcartographer/tile`) which re-serves them with permissive
// CORS; the resulting image is untainted and `getImageData`-able.
//
// Runs in a Web Worker (uses `OffscreenCanvas` + `createImageBitmap`), but is
// equally usable on the main thread.

import { buildWaterMask, DEFAULT_WATER_COLORS, DEFAULT_WATER_TOLERANCE, type WaterColor } from "./water-mask";
import type { LoadTileMask } from "./sailboat-routing";
import { SAILBOAT_ZOOM } from "./tile-coords";

export interface TileLoaderConfig {
    /** API base, e.g. "/api" or an absolute Render URL. */
    proxyBase: string;
    /** WebCartographer host the tiles live on. */
    baseUrl: string;
    /** Tile image extension served by the host. */
    ext: "png" | "webp";
    /** Pyramid level (defaults to the finest). */
    zoom?: number;
    colors?: readonly WaterColor[];
    tolerance?: number;
}

/** Build a {@link LoadTileMask} that fetches tiles through the proxy and
 *  decodes them to a water mask. Returns `null` for missing (404) tiles. */
export function createProxyTileLoader(cfg: TileLoaderConfig): LoadTileMask {
    const zoom = cfg.zoom ?? SAILBOAT_ZOOM;
    const colors = cfg.colors ?? DEFAULT_WATER_COLORS;
    const tolerance = cfg.tolerance ?? DEFAULT_WATER_TOLERANCE;
    const proxyBase = cfg.proxyBase.replace(/\/+$/, "");

    return async (cx: number, cy: number): Promise<Uint8Array | null> => {
        const url =
            `${proxyBase}/webcartographer/tile` +
            `?base_url=${encodeURIComponent(cfg.baseUrl)}` +
            `&z=${zoom}&x=${cx}&y=${cy}&ext=${cfg.ext}`;
        const res = await fetch(url);
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`tile fetch failed (${res.status}) for ${cx}_${cy}`);
        }
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
            bitmap.close();
            throw new Error("2D context unavailable for tile decode");
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const img = ctx.getImageData(0, 0, w, h);
        return buildWaterMask(img.data, w, h, colors, tolerance);
    };
}
