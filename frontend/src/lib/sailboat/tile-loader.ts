// Proxy-backed tile loader for the sailboat route planner.
//
// WC tiles have no CORS headers, so a cross-origin `<img>`/`fetch` can't be
// read back as pixels. We route the bytes through our same-origin backend
// which re-serves them with permissive CORS; the resulting image is untainted
// and `getImageData`-able.
//
// Two backend endpoints are used:
//   • `POST /api/webcartographer/tiles` — bulk: many tiles in one request,
//     base64-encoded, fetched concurrently upstream. Primary path.
//   • `GET  /api/webcartographer/tile`  — single tile; used as a per-tile
//     fallback when the batch endpoint fails or flags a tile as errored.
//
// Runs in a Web Worker (uses `OffscreenCanvas` + `createImageBitmap`), but is
// equally usable on the main thread.

import { buildWaterMask, DEFAULT_WATER_COLORS, DEFAULT_WATER_TOLERANCE, type WaterColor } from "./water-mask";
import type { TileCoord, TileSource } from "./sailboat-routing";
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

interface BatchTileEntry {
    x: number;
    y: number;
    found: boolean;
    data?: string;
    error?: boolean;
}

/** Decode a base64 string to raw bytes (worker-safe — no Buffer/Node APIs). */
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** Build a bulk {@link TileSource} that fetches tiles through the batch proxy
 *  and decodes each to a water mask. Missing (404) tiles resolve to null; a
 *  tile the batch endpoint couldn't fetch for another reason is retried
 *  individually so transient upstream hiccups don't masquerade as "no data". */
export function createProxyTileSource(cfg: TileLoaderConfig): TileSource {
    const zoom = cfg.zoom ?? SAILBOAT_ZOOM;
    const colors = cfg.colors ?? DEFAULT_WATER_COLORS;
    const tolerance = cfg.tolerance ?? DEFAULT_WATER_TOLERANCE;
    const proxyBase = cfg.proxyBase.replace(/\/+$/, "");

    async function decodeMask(bytes: Uint8Array): Promise<Uint8Array> {
        const blob = new Blob([bytes as BlobPart]);
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
    }

    /** Single-tile fetch + decode. Returns null on 404; throws on other errors. */
    async function loadSingle(cx: number, cy: number): Promise<Uint8Array | null> {
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
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return decodeMask(bytes);
    }

    async function loadBatch(
        coords: ReadonlyArray<TileCoord>,
    ): Promise<Array<Uint8Array | null>> {
        if (coords.length === 0) return [];
        let entries: Map<string, BatchTileEntry> | null = null;
        try {
            const res = await fetch(`${proxyBase}/webcartographer/tiles`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    base_url: cfg.baseUrl,
                    z: zoom,
                    ext: cfg.ext,
                    coords: coords.map((c) => [c.cx, c.cy]),
                }),
            });
            if (res.ok) {
                const json = (await res.json()) as { tiles: BatchTileEntry[] };
                entries = new Map(json.tiles.map((t) => [`${t.x}_${t.y}`, t]));
            }
        } catch {
            // Network error on the batch call — fall through to per-tile fetches.
            entries = null;
        }

        return Promise.all(
            coords.map(async (c) => {
                const entry = entries?.get(`${c.cx}_${c.cy}`);
                // No batch result, or a non-404 upstream error for this tile:
                // retry it on its own so a transient failure isn't mistaken
                // for missing data.
                if (!entry || entry.error) {
                    return loadSingle(c.cx, c.cy);
                }
                if (!entry.found || !entry.data) return null;
                return decodeMask(base64ToBytes(entry.data));
            }),
        );
    }

    return { loadBatch };
}
