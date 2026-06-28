import type { RockMapWorld } from "./types";
import { encodePngUrl } from "./png";

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
    // Encode without a canvas: `toBlob`/`convertToBlob` are randomized by
    // anti-fingerprinting browsers (LibreWolf / Firefox
    // `privacy.resistFingerprinting`) the same way `getImageData` is, which
    // would re-introduce the "random colors" bug on the output side.
    return encodePngUrl(rgba, width, height);
}
