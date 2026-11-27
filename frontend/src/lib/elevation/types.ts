// Shape of the terrain height-map artifacts produced by the Rapids Exporter
// mod (`/rapids heightmap`) and downsampled by
// `tools/prepare-rapids-export/prepare_rapids_export.py`:
//  - a colorized + hillshaded WebP for instant display (relief mode)
//  - an 8-bit greyscale raw PNG where `height = R` is the Y of the highest
//    solid terrain block (hover readout + band mode)
//  - one `world.json` georef per raster (same origin as climate/stability)
// See docs/multiplayer/rapids-exporter-format.md §3.

export type ElevationMode = "relief" | "band";

/** Highest storable terrain height on TOPS (`mapSizeY - 2`). */
export const ELEVATION_Y_MAX = 254;
/** Minimum Y a worldgen rapid source can sit at. */
export const RAPID_MIN_Y = 133;

export interface ElevationWorld {
    originBlockX: number;
    originBlockZ: number;
    blocksPerPixelX: number;
    blocksPerPixelZ: number;
    widthPx: number;
    heightPx: number;
    imagePngRelative: string;
    imageRawPngRelative?: string;
    seaLevel: number;
    mapSizeY: number;
    stats: { min: number; max: number };
    generatedUtc?: string;
}

export interface LoadedElevationRaw {
    /** Decoded RGBA; greyscale, so `height = rgba[i * 4]`. */
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    world: ElevationWorld;
}

export interface ElevationOverlayBounds {
    /** Centered (TOPS) world-block coords of the overlay rectangle. */
    originX: number;
    originZ: number;
    extentX: number;
    extentZ: number;
}

export interface ElevationSample {
    /** Y of the highest solid terrain block. */
    y: number;
    /** True when the column is below the water surface (Y < seaLevel - 1). */
    isWater: boolean;
    /** Blocks of water above the terrain (0 on land). */
    depth: number;
    /** Blocks above the water surface (negative under water). */
    aboveSea: number;
    /** Blocks per raw pixel, i.e. the sampling resolution. */
    resolutionBlocks: number;
}

export interface ElevationBandPreset {
    id: string;
    min: number;
    max: number;
}

export const ELEVATION_BAND_PRESETS: ReadonlyArray<ElevationBandPreset> = [
    { id: "rapids", min: RAPID_MIN_Y, max: ELEVATION_Y_MAX },
    { id: "land", min: 110, max: ELEVATION_Y_MAX },
    { id: "mountains", min: 175, max: ELEVATION_Y_MAX },
    { id: "shallow", min: 95, max: 108 },
];

/** Legend stops from the exporter (doc §3.3). Land stops are keyed by the Y
 *  they correspond to on TOPS (sea level 110, top 254). */
export const ELEVATION_LAND_STOPS: ReadonlyArray<{ y: number; hex: string }> = [
    { y: 110, hex: "#3E7D3A" },
    { y: 130, hex: "#6E9B3E" },
    { y: 150, hex: "#B8B65A" },
    { y: 175, hex: "#A37E4A" },
    { y: 199, hex: "#7E6A5A" },
    { y: 225, hex: "#A8A8A8" },
    { y: 247, hex: "#F5F5F5" },
];

export const ELEVATION_WATER_SHALLOW = "#6BA7D8";
export const ELEVATION_WATER_DEEP = "#0B2E59";
