/**
 * Stitch chunked TOPS map tiles into a single image.
 *
 * Chunks are downloaded in parallel (bounded concurrency) and drawn onto an
 * offscreen canvas at the (cx, cy) grid position the backend assigned. The
 * `onProgress` callback fires after each chunk so callers can render the
 * canvas progressively.
 */

import type { TopsMapLevelChunks, TopsMapChunkRef } from "./api";

export interface StitchProgress {
    completed: number;
    total: number;
}

export interface StitchOptions {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (p: StitchProgress, canvas: HTMLCanvasElement) => void;
}

const DEFAULT_CONCURRENCY = 6;

async function loadChunk(ref: TopsMapChunkRef, signal?: AbortSignal): Promise<HTMLImageElement> {
    const res = await fetch(ref.url, { signal });
    if (!res.ok) throw new Error(`Failed to fetch chunk ${ref.cx},${ref.cy}: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = "async";
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`decode failed: ${ref.cx},${ref.cy}`));
            img.src = url;
        });
        return img;
    } finally {
        // Image element keeps its own reference; safe to revoke now.
        URL.revokeObjectURL(url);
    }
}

/**
 * Run `worker(item)` over `items` with at most `limit` in flight at once.
 */
async function pMapBounded<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Build an offscreen canvas containing the full stitched map for the level.
 * Rejects if `signal` aborts. Resolves with the canvas + total bytes drawn.
 */
export async function stitchChunksToCanvas(
    level: TopsMapLevelChunks,
    opts: StitchOptions = {},
): Promise<HTMLCanvasElement> {
    const { concurrency = DEFAULT_CONCURRENCY, signal, onProgress } = opts;
    const canvas = document.createElement("canvas");
    canvas.width = level.image_w;
    canvas.height = level.image_h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const total = level.chunks.length;
    let completed = 0;

    await pMapBounded(level.chunks, concurrency, async (chunk) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const img = await loadChunk(chunk, signal);
        // Each chunk's pixel origin in the assembled image. The backend uses
        // `chunk_w * cx` / `chunk_h * cy`; the last column/row absorbs any
        // remainder pixels (handled because we draw at the image's natural
        // size starting at the calculated origin).
        const px = chunk.cx * level.chunk_w;
        const py = chunk.cy * level.chunk_h;
        ctx.drawImage(img, px, py);
        completed += 1;
        onProgress?.({ completed, total }, canvas);
    });

    return canvas;
}

/** Convenience: stitch + export as a Blob (used for the existing `<img>` viewer). */
export async function stitchChunksToBlob(
    level: TopsMapLevelChunks,
    opts: StitchOptions = {},
): Promise<Blob> {
    const canvas = await stitchChunksToCanvas(level, opts);
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
            "image/png",
        );
    });
}
