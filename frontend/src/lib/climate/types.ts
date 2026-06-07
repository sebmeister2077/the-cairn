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

/** Threshold mode for the Temperature panel. */
export type ClimateThresholdMode =
    | "none"
    | "year_round_5"
    | "frost_free_0"
    | "tropical_10"
    | "temperate_band"
    | "custom";

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
