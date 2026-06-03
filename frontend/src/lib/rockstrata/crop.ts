import type { RockMapWorld } from "./types";

export interface CropResult {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    /** World-block extent of the cropped window. */
    originBlockX: number;
    originBlockZ: number;
    extentBlocksX: number;
    extentBlocksZ: number;
}

/**
 * Crop the source RGBA buffer to a window of `2 * halfBlocks` world
 * blocks centered on `(centerX, centerZ)`. Independent X/Z scales are
 * honoured throughout (per spec hard constraint).
 *
 * The window is clamped to the source image bounds, so a crop that
 * would extend past the export's edge silently shrinks instead of
 * sampling out-of-bounds pixels.
 */
export function cropAroundCenter(
    src: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    world: RockMapWorld,
    centerX: number,
    centerZ: number,
    halfBlocks: number,
): CropResult {
    const { originBlockX, originBlockZ, blocksPerPixelX, blocksPerPixelZ } = world;

    let pxMin = Math.floor((centerX - halfBlocks - originBlockX) / blocksPerPixelX);
    let pxMax = Math.ceil((centerX + halfBlocks - originBlockX) / blocksPerPixelX);
    let pyMin = Math.floor((centerZ - halfBlocks - originBlockZ) / blocksPerPixelZ);
    let pyMax = Math.ceil((centerZ + halfBlocks - originBlockZ) / blocksPerPixelZ);

    pxMin = Math.max(0, Math.min(srcWidth, pxMin));
    pxMax = Math.max(0, Math.min(srcWidth, pxMax));
    pyMin = Math.max(0, Math.min(srcHeight, pyMin));
    pyMax = Math.max(0, Math.min(srcHeight, pyMax));

    const w = Math.max(0, pxMax - pxMin);
    const h = Math.max(0, pyMax - pyMin);

    const out = new Uint8ClampedArray(w * h * 4);
    if (w > 0 && h > 0) {
        const rowBytes = w * 4;
        for (let y = 0; y < h; y++) {
            const srcRowStart = ((pyMin + y) * srcWidth + pxMin) * 4;
            out.set(src.subarray(srcRowStart, srcRowStart + rowBytes), y * rowBytes);
        }
    }

    return {
        rgba: out,
        width: w,
        height: h,
        originBlockX: originBlockX + pxMin * blocksPerPixelX,
        originBlockZ: originBlockZ + pyMin * blocksPerPixelZ,
        extentBlocksX: w * blocksPerPixelX,
        extentBlocksZ: h * blocksPerPixelZ,
    };
}

/** Convenience helper to encode an RGBA buffer to a PNG blob URL. */
export async function encodeRgbaToPngUrl(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
): Promise<string> {
    if (width <= 0 || height <= 0) {
        // Empty crop — return a tiny transparent PNG so consumers don't
        // need to special-case it.
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        const blob = await new Promise<Blob>((resolve, reject) =>
            c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
        );
        return URL.createObjectURL(blob);
    }
    const useOffscreen = typeof OffscreenCanvas !== "undefined";
    if (useOffscreen) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(rgba);
        ctx.putImageData(imageData, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return URL.createObjectURL(blob);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
    return URL.createObjectURL(blob);
}
