// Water detection for the sailboat route planner.
//
// WebCartographer renders navigable water as a small set of EXACT, flat
// colours (no hill-shading), which makes them trivially separable from
// terrain: terrain pixels are continuously shaded and never land on these
// exact values. Empirically (sampling the TOPS map tiles):
//
//   • open water / lakes / ocean → (204, 200, 144)
//   • water vegetation (plants growing on water) → (156, 163, 97)
//
// Both are treated as navigable (canals are often plant-covered). A tiny
// tolerance absorbs any PNG/webp recompression drift; because terrain never
// comes within ~30 of these values, the exact threshold is not sensitive.
//
// The colours come from the VS/WebCartographer block palette and can differ
// on other worlds, so they are exported as configurable defaults keyed to the
// WebCartographer map source.

export interface WaterColor {
    r: number;
    g: number;
    b: number;
}

/** Default navigable-water colours for the TOPS WebCartographer palette. */
export const DEFAULT_WATER_COLORS: readonly WaterColor[] = [
    { r: 204, g: 200, b: 144 }, // open water / lake / ocean
    { r: 156, g: 163, b: 97 }, // water vegetation
];

/** L1 (Manhattan) colour-distance tolerance. Water is flat/exact, so this is
 *  generous headroom rather than a tuning knob. */
export const DEFAULT_WATER_TOLERANCE = 12;

/** True when (r, g, b) is within `tolerance` (L1) of any water colour. */
export function isWaterPixel(
    r: number,
    g: number,
    b: number,
    colors: readonly WaterColor[] = DEFAULT_WATER_COLORS,
    tolerance: number = DEFAULT_WATER_TOLERANCE,
): boolean {
    for (let i = 0; i < colors.length; i++) {
        const c = colors[i];
        const d = Math.abs(r - c.r) + Math.abs(g - c.g) + Math.abs(b - c.b);
        if (d <= tolerance) return true;
    }
    return false;
}

/**
 * Build a 1-byte-per-pixel water mask from a tile's RGBA data. Returns a
 * `Uint8Array` of length `width*height` where 1 = navigable water.
 */
export function buildWaterMask(
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    colors: readonly WaterColor[] = DEFAULT_WATER_COLORS,
    tolerance: number = DEFAULT_WATER_TOLERANCE,
): Uint8Array {
    const n = width * height;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        // Fully transparent pixels (e.g. padded tiles) are not water.
        if (data[o + 3] === 0) continue;
        if (isWaterPixel(data[o], data[o + 1], data[o + 2], colors, tolerance)) {
            mask[i] = 1;
        }
    }
    return mask;
}

/** Fraction of a mask that is water, in [0, 1]. Handy for tests / telemetry. */
export function waterFraction(mask: Uint8Array): number {
    if (mask.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < mask.length; i++) count += mask[i];
    return count / mask.length;
}
