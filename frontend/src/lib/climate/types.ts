// Shape of artifacts produced by the climate-extract worldgen tool.
// Each "layer" (tempavg/tempmin/tempmax/rainfall/geoactivity) ships:
//  - a colorized PNG (`*.png`) for instant display
//  - a raw-encoded PNG (`*.raw.png`) where `(R*256+G)` decodes to the
//    actual scalar value (formula in the layer meta)
//  - a `*.world.json` georeferencing file (origin + blocksPerPixel)
// All layers share a single root `climate_*.json` containing seed,
// world bounds, and per-layer color anchors + stats.

export type ClimateLayerKind =
    | "tempavg"
    | "tempmin"
    | "tempmax"
    | "rainfall"
    | "geoactivity";

/** UI-level grouping. "temperature" expands to one of the three temp* layers. */
export type ClimateSubToggle = "off" | "temperature" | "rainfall" | "geoactivity";

export type ClimateTempVariant = "tempavg" | "tempmin" | "tempmax";

/** Threshold mode for the Temperature panel.
 *  - "none":   show the raw temperature gradient (no masking).
 *  - "crop":   AND-mask between `tempmin >= crop.minTempC` and
 *              `tempmax <= crop.maxTempC` for the selected `CropId`.
 *  - "custom": single-layer custom min/max range on the active variant.
 */
export type ClimateThresholdMode = "none" | "crop" | "custom";

/** Crops the player can plant. All values are °C tolerances scraped from
 *  Vintage Story's gameplay data — `minTempC` is where the plant dies of
 *  cold, `maxTempC` is where it dies of heat. A location supports
 *  year-round growth iff its annual `tempmin >= minTempC` and its annual
 *  `tempmax <= maxTempC`. Flax is the only non-food entry (used for linen). */
export type CropId =
    | "carrot"
    | "flax"
    | "onion"
    | "spelt"
    | "turnip"
    | "parsnip"
    | "rice"
    | "rye"
    | "soybean"
    | "amaranth"
    | "bellpepper"
    | "cassava"
    | "peanut"
    | "pineapple"
    | "sunflower"
    | "pumpkin"
    | "cabbage";

export interface CropTolerance {
    id: CropId;
    minTempC: number;
    maxTempC: number;
    kind: "food" | "linen";
}

export const CROPS: ReadonlyArray<CropTolerance> = [
    { id: "amaranth", minTempC: 6, maxTempC: 42, kind: "food" },
    { id: "bellpepper", minTempC: 8, maxTempC: 34, kind: "food" },
    { id: "cabbage", minTempC: -5, maxTempC: 35, kind: "food" },
    { id: "carrot", minTempC: -10, maxTempC: 32, kind: "food" },
    { id: "cassava", minTempC: 4, maxTempC: 44, kind: "food" },
    { id: "flax", minTempC: -5, maxTempC: 40, kind: "linen" },
    { id: "onion", minTempC: -1, maxTempC: 40, kind: "food" },
    { id: "parsnip", minTempC: -10, maxTempC: 32, kind: "food" },
    { id: "peanut", minTempC: 10, maxTempC: 42, kind: "food" },
    { id: "pineapple", minTempC: 6, maxTempC: 48, kind: "food" },
    { id: "pumpkin", minTempC: -5, maxTempC: 40, kind: "food" },
    { id: "rice", minTempC: 8, maxTempC: 46, kind: "food" },
    { id: "rye", minTempC: -12, maxTempC: 27, kind: "food" },
    { id: "soybean", minTempC: -5, maxTempC: 40, kind: "food" },
    { id: "spelt", minTempC: -5, maxTempC: 40, kind: "food" },
    { id: "sunflower", minTempC: -5, maxTempC: 40, kind: "food" },
    { id: "turnip", minTempC: -5, maxTempC: 27, kind: "food" },
];

export interface ColorAnchor {
    value: number;
    hex: string;
}

export interface LayerStats {
    min: number;
    avg: number;
    max: number;
}

export interface ClimateLayerMeta {
    layer: ClimateLayerKind;
    description: string;
    colorPng: string;
    rawPng: string;
    rawDecodeFormula: string;
    colorAnchors: ColorAnchor[];
    stats: LayerStats;
}

export interface ClimateRootMeta {
    seed: number;
    center: { x: number; z: number };
    halfSizeBlocks: number;
    outputPx: number;
    anchorY: number;
    regionSize: number;
    noiseSizeClimate: number;
    blocksPerNoisePx: number;
    worldBox: { minX: number; minZ: number; maxX: number; maxZ: number };
    worldConfig: Record<string, string>;
    assumptions: string[];
    layers: ClimateLayerMeta[];
}

export interface ClimateWorld {
    originBlockX: number;
    originBlockZ: number;
    blocksPerPixelX: number;
    blocksPerPixelZ: number;
    widthPx: number;
    heightPx: number;
    imagePngRelative: string;
    imageRawPngRelative?: string;
    rawDecodeFormula?: string;
}

export interface LoadedClimateColor {
    kind: ClimateLayerKind;
    /** Bundled PNG asset URL — do NOT revoke. */
    url: string;
    width: number;
    height: number;
    world: ClimateWorld;
}

/** Decoder receives byte values from the raw PNG and returns the scalar value. */
export type ClimateDecoder = (r: number, g: number) => number;

export interface LoadedClimateRaw {
    kind: ClimateLayerKind;
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    world: ClimateWorld;
    /** Decode formula identifier ("temp" | "unit"). The worker re-derives the
     *  same maths for hot loops — keeping the function reference here is
     *  for cursor probe / non-worker callers. */
    decodeKind: "temp" | "unit";
    decode: ClimateDecoder;
}

export interface ClimateOverlayBounds {
    /** Centered (TOPS) world-block coords of the overlay rectangle. */
    originX: number;
    originZ: number;
    extentX: number;
    extentZ: number;
}
