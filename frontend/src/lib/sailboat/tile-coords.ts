// World ↔ WebCartographer tile/pixel coordinate math for the sailboat route
// planner. Mirrors the projection the viewer uses in
// `WebCartographerMapViewer`, but exposes it as pure helpers so the routing
// engine (and its worker) can map between world blocks and the tile pixels
// it reads water from.
//
// The planner always works at the finest pyramid level (`WC_MAX_ZOOM`), where
// one source pixel == one world block, so water detection is per-block.

import {
    WC_EXTENT_HALF_BLOCKS,
    WC_RESOLUTIONS,
    WC_TILE_SIZE_PX,
    WC_MAX_ZOOM,
    WC_WORLD_BLOCKS,
} from "@/lib/tops-map-view/wc-tiles";

/** Finest level — 1 world block per pixel. */
export const SAILBOAT_ZOOM = WC_MAX_ZOOM;

/** World-block coordinate of the top-left of the tile grid (both axes). */
export const WORLD_ORIGIN_BLOCK = -WC_EXTENT_HALF_BLOCKS;

export interface TilePixel {
    /** Tile column / row (the `{x}_{y}` in the tile URL). */
    cx: number;
    cy: number;
    /** Pixel within the tile, 0..WC_TILE_SIZE_PX-1. */
    px: number;
    py: number;
}

/** Number of tiles per side at a given pyramid level. */
export function tilesPerSide(zoom: number = SAILBOAT_ZOOM): number {
    return Math.ceil(WC_WORLD_BLOCKS / WC_RESOLUTIONS[zoom] / WC_TILE_SIZE_PX);
}

/** Map a world (x, z) to the tile + pixel that contains it. */
export function worldToTilePixel(
    worldX: number,
    worldZ: number,
    zoom: number = SAILBOAT_ZOOM,
): TilePixel {
    const resolution = WC_RESOLUTIONS[zoom];
    const tileSpan = WC_TILE_SIZE_PX * resolution;
    const bx = worldX - WORLD_ORIGIN_BLOCK;
    const bz = worldZ - WORLD_ORIGIN_BLOCK;
    const cx = Math.floor(bx / tileSpan);
    const cy = Math.floor(bz / tileSpan);
    const px = Math.floor((bx - cx * tileSpan) / resolution);
    const py = Math.floor((bz - cy * tileSpan) / resolution);
    return { cx, cy, px, py };
}

/** Centre world (x, z) of a given tile pixel. */
export function tilePixelToWorld(
    cx: number,
    cy: number,
    px: number,
    py: number,
    zoom: number = SAILBOAT_ZOOM,
): { x: number; z: number } {
    const resolution = WC_RESOLUTIONS[zoom];
    const tileSpan = WC_TILE_SIZE_PX * resolution;
    const x = WORLD_ORIGIN_BLOCK + cx * tileSpan + px * resolution + resolution / 2;
    const z = WORLD_ORIGIN_BLOCK + cy * tileSpan + py * resolution + resolution / 2;
    return { x, z };
}

// ── Finest-level (1 block/pixel) helpers used by the routing engine ─────────
//
// At `SAILBOAT_ZOOM` the global pixel index equals the world block shifted by
// the grid origin, so routing works in a single flat "global block" space.

/** World X/Z → global pixel index (finest level). */
export function worldToGlobalPixel(worldX: number, worldZ: number): { gx: number; gz: number } {
    return { gx: worldX - WORLD_ORIGIN_BLOCK, gz: worldZ - WORLD_ORIGIN_BLOCK };
}

/** Global pixel index → world X/Z (finest level). */
export function globalPixelToWorld(gx: number, gz: number): { x: number; z: number } {
    return { x: gx + WORLD_ORIGIN_BLOCK, z: gz + WORLD_ORIGIN_BLOCK };
}

/** Tile + in-tile pixel for a global pixel index (finest level). */
export function globalPixelToTile(gx: number, gz: number): TilePixel {
    const cx = gx >> 8; // / WC_TILE_SIZE_PX (256)
    const cy = gz >> 8;
    const px = gx & (WC_TILE_SIZE_PX - 1);
    const py = gz & (WC_TILE_SIZE_PX - 1);
    return { cx, cy, px, py };
}
