// Shape of artifacts produced by the `rockstratafinder` Vintage Story mod.
// Three files per export: a PNG raster, a `<stamp>.json` legend/metadata
// file, and a `<stamp>.world.json` georeferencing file. The geomap_*
// triplet is structurally identical (legend = geological provinces).

export type RockStrataLayerKind = "rock" | "geo";

export interface LegendEntry {
    blockId: number;
    code: string;
    pixelCount: number;
    /** "#RRGGBB" — authoritative color→code mapping per file. */
    hexcolor: string;
}

export interface RockMapMeta {
    seed: number;
    center: { x: number; z: number };
    halfSizeBlocks: number;
    outputPx: number;
    seaLevel: number;
    approximation: string;
    worldBox: { minX: number; minZ: number; maxX: number; maxZ: number };
    legend: LegendEntry[];
}

export interface RockMapWorld {
    originBlockX: number;
    originBlockZ: number;
    blocksPerPixelX: number;
    blocksPerPixelZ: number;
    widthPx: number;
    heightPx: number;
    imagePngRelative: string;
}

export interface LoadedRockMap {
    layerKind: RockStrataLayerKind;
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    meta: RockMapMeta;
    world: RockMapWorld;
    legend: LegendEntry[];
}
