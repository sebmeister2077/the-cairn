// Shape of artifacts produced by the temporal-stability worldgen exporter.
// Unlike climate (one raster per scalar layer), stability ships one raster
// per depth slice (Y = 10..130, step 10). Each slice provides:
//  - a colorized PNG (`*_y<Y>.png`) for instant display
//  - a raw-encoded PNG (`*_y<Y>.raw.png`) where `(R*256+G)/10000` decodes to
//    the stability scalar (0..1.5)
//  - a `*_y<Y>.world.json` georeferencing file (origin + blocksPerPixel + y)
// A single root summary JSON carries the color anchors, per-slice stats and
// the decode formula shared by every slice.

/** Available depth slices baked by the exporter. */
export type StabilityYSlice = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110 | 120 | 130;

export const STABILITY_Y_SLICES: ReadonlyArray<StabilityYSlice> = [
    10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
];

export const STABILITY_Y_MIN = 10;
export const STABILITY_Y_MAX = 130;
export const STABILITY_Y_STEP = 10;

/** Snap an arbitrary Y (e.g. from a slider) to the nearest available slice. */
export function snapToStabilitySlice(y: number): StabilityYSlice {
    let best: StabilityYSlice = STABILITY_Y_SLICES[0];
    let bestDist = Infinity;
    for (const s of STABILITY_Y_SLICES) {
        const d = Math.abs(s - y);
        if (d < bestDist) {
            bestDist = d;
            best = s;
        }
    }
    return best;
}

export interface StabilityColorAnchor {
    value: number;
    hex: string;
}

export interface StabilitySliceStats {
    min: number;
    avg: number;
    max: number;
}

export interface StabilitySliceMeta {
    y: number;
    colorPng: string;
    rawPng: string;
    stats: StabilitySliceStats;
}

export interface StabilityRootMeta {
    seed: number;
    center: { x: number; z: number };
    halfSizeBlocks: number;
    outputPx: number;
    seaLevel: number;
    mapSizeY: number;
    worldBox: { minX: number; minZ: number; maxX: number; maxZ: number };
    rawDecodeFormula: string;
    stabilityRange: { min: number; max: number };
    colorAnchors: StabilityColorAnchor[];
    assumptions: string[];
    slices: StabilitySliceMeta[];
}

export interface StabilityWorld {
    originBlockX: number;
    originBlockZ: number;
    blocksPerPixelX: number;
    blocksPerPixelZ: number;
    widthPx: number;
    heightPx: number;
    y: number;
    imagePngRelative: string;
    imageRawPngRelative?: string;
    rawDecodeFormula?: string;
}

export interface LoadedStabilityColor {
    y: StabilityYSlice;
    /** Bundled PNG asset URL — do NOT revoke. */
    url: string;
    width: number;
    height: number;
    world: StabilityWorld;
}

export interface LoadedStabilityRaw {
    y: StabilityYSlice;
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    world: StabilityWorld;
    /** Decode a raw pixel's R/G bytes into the stability scalar (0..1.5). */
    decode: (r: number, g: number) => number;
}

export interface StabilityOverlayBounds {
    /** Centered (TOPS) world-block coords of the overlay rectangle. */
    originX: number;
    originZ: number;
    extentX: number;
    extentZ: number;
}

/** Raw decode shared by every slice: `stability = (R*256 + G) / 10000`. */
export function decodeStability(r: number, g: number): number {
    return (r * 256 + g) / 10000;
}
