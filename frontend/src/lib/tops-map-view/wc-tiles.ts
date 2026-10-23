import type { MapStats } from "@/components/tops-map-viewer/MapViewer";

/**
 * WebCartographer-compatible tile parameters and viewer constants.
 *
 * WebCartographer (https://gitlab.com/th3dilli_vintagestory/WebCartographer)
 * exports an OpenLayers-XYZ tile pyramid covering a fixed 1,024,000-block
 * square centred on the world origin, with a top-left tile-grid origin and
 * 10 zoom levels whose resolutions (world blocks per pixel) halve at each
 * step from 512 down to 1. See `worldExtent.js` on any WC host.
 */
export const WC_EXTENT_HALF_BLOCKS = 512_000;
export const WC_WORLD_BLOCKS = WC_EXTENT_HALF_BLOCKS * 2;
export const WC_TILE_SIZE_PX = 256;
export const WC_RESOLUTIONS = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1] as const;
export const WC_MAX_ZOOM = WC_RESOLUTIONS.length - 1;

/**
 * Select the pyramid level whose native resolution is CLOSEST (in log space)
 * to the requested on-screen scale `pixelsPerBlock`.
 *
 * `WC_RESOLUTIONS[z]` is the number of world blocks a single source pixel
 * covers at level `z`; drawing each block as `pixelsPerBlock` screen px means
 * one source pixel spans `res * ppb` screen px, so a 256px tile is drawn at
 * `256 * res * ppb` screen px.
 *
 * The upstream WebCartographer viewer runs OpenLayers with
 * `constrainResolution: true`, which snaps the view to an exact pyramid
 * resolution and therefore always paints tiles at their native 256px. To
 * mirror that tile economy without giving up this viewer's smooth continuous
 * zoom, we round to the NEAREST level (OpenLayers' default
 * `getZForResolution` behaviour) instead of always to the finer one. Rounding
 * down to the finer level kept `res * ppb` in `(0.5, 1]`, shrinking tiles to
 * as little as 128px and covering the viewport with up to 4x the tiles;
 * rounding to nearest keeps `res * ppb` in `[1/√2, √2]` (tiles ~181–362px),
 * so the viewport needs roughly the same tile count as the official map.
 */
export function wcZoomLevelForPpb(pixelsPerBlock: number): number {
  const targetRes = 1 / Math.max(pixelsPerBlock, 1e-6);
  // Accept a level up to √2 coarser than the exact target (the geometric
  // midpoint between adjacent levels) before stepping to the next finer one.
  const threshold = targetRes * Math.SQRT2;
  for (let z = 0; z <= WC_MAX_ZOOM; z++) {
    if (WC_RESOLUTIONS[z] <= threshold) return z;
  }
  return WC_MAX_ZOOM;
}

/**
 * On-screen pixels-per-block at which we'd like the viewer to start so a
 * meaningful chunk of the explored world is visible without first having to
 * zoom out. ~0.004 px/block = ~4000 blocks per 16px = comfortable overview
 * of the global map.
 */
export const INITIAL_PIXELS_PER_BLOCK = 0.004;

export const MIN_PIXELS_PER_BLOCK = 0.0005;
/** A single block stretched across 8 screen pixels — useful for inspecting
 * landmark details. */
export const MAX_PIXELS_PER_BLOCK = 8;

/** Below this zoom the trader-claim dot field is hidden — the ~thousands of
 *  boxes would otherwise smear into an unreadable wall when zoomed way out. */
export const CLAIM_MIN_PIXELS_PER_BLOCK = 0.02;

/** Fill for a claim flagged as having NO actual trader (beta leftover). */
export const CLAIM_EMPTY_COLOR = "#ef4444"; // red-500

export const WHEEL_ZOOM_FACTOR = 1.3;
export const BUTTON_ZOOM_FACTOR = 1.75;

/**
 * Render this many extra tile widths around the viewport. The upstream
 * WebCartographer (OpenLayers) loads essentially only the tiles that cover
 * the viewport and leans on already-cached coarser tiles while panning, so
 * we match it with `0` — any momentary gap at the edge while a fresh tile
 * loads is already filled by the parent/child fallback-draw passes in the
 * render loop. Bump this back to `1` if you'd rather trade extra tile
 * requests for a pre-loaded buffer that hides edge pop-in during fast pans.
 */
export const TILE_OVERSCAN_TILES = 0;

/**
 * Maximum number of decoded tile bitmaps to keep alive at once. Each
 * 256×256 RGBA tile is ~256KB in memory, so 1800 ≈ 450MB worst-case — a
 * comfortable budget for desktop browsers while still allowing fast
 * pan/zoom across multiple pyramid levels (each level visited adds another
 * viewport's worth of tiles, and we want previous levels to survive so
 * zooming back doesn't refetch).
 */
export const TILE_CACHE_LIMIT = 1800;

/**
 * How many parent pyramid levels above the current one to consult when a
 * tile at the current level hasn't loaded yet. Each step up halves the
 * number of fallback tiles to scan, so this is cheap; it lets us paint
 * *something* (a coarser ancestor) the moment the user crosses a zoom
 * threshold, even if they jumped multiple levels at once.
 */
export const TILE_FALLBACK_PARENT_LEVELS = 8;

/**
 * Synthetic {@link MapStats} mirroring the WC world extent — all our overlays
 * (TLs, traders, landmarks, oceans, route planner) project world-block coords
 * through this so they line up pixel-for-pixel with the imported tiles.
 *
 * `pieces` and `size_mb` are admin-stats-header fields that have no meaning
 * for the WC path; they stay at zero.
 */
export const WC_STATS: MapStats = {
  pieces: 0,
  size_mb: 0,
  width_chunks: WC_WORLD_BLOCKS / 32,
  height_chunks: WC_WORLD_BLOCKS / 32,
  width_blocks: WC_WORLD_BLOCKS,
  height_blocks: WC_WORLD_BLOCKS,
  start_x: -WC_EXTENT_HALF_BLOCKS,
  start_z: -WC_EXTENT_HALF_BLOCKS,
};

/** Duration of the per-tile fade-in animation, in ms. */
export const TILE_FADE_MS = 280;

/** Strip a trailing slash (and surrounding whitespace) from a host base URL. */
export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** State of one cached tile image. */
export interface TileEntry {
  status: "loading" | "loaded" | "error";
  img?: HTMLImageElement;
  /** `performance.now()` timestamp the image finished loading; used to
   * fade tiles in over {@link TILE_FADE_MS} for a subtle progressive-
   * reveal effect when the user pans into unexplored regions or crosses
   * a zoom threshold. */
  loadedAt?: number;
}
