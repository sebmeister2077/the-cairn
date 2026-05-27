import type { MapStats } from "@/components/MapViewer";
import oceanImg from "@/assets/Oceans/oceans_transparent.png";

// The oceans image is a 140k-block-radius scan centred on the player
// origin (0, 0). At 8751 px wide that works out to ~32 blocks/pixel
// (280000 / 8751 ≈ 32), matching the `blocksPerPixel: 32` field in
// `oceans.json`. Coordinates here are already in the player-absolute
// frame used by `MapStats.start_x/start_z`, so no further shift is
// required.
const OCEANS_RADIUS_BLOCKS = 140000;
const OCEANS_WORLD_BBOX = {
  min_x: -OCEANS_RADIUS_BLOCKS,
  max_x: OCEANS_RADIUS_BLOCKS,
  min_z: -OCEANS_RADIUS_BLOCKS,
  max_z: OCEANS_RADIUS_BLOCKS,
} as const;

interface OceansOverlayLayerProps {
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active TOPS tileSet. */
  imageWidth: number;
  imageHeight: number;
  /** Optional opacity (0-1). Defaults to 0.55 so map tiles stay readable. */
  opacity?: number;
}

/**
 * Renders the preprocessed "oceans" raster as a background layer behind
 * the TOPS map tiles. The single PNG (8751x8751, alpha-keyed by
 * `backend/process_oceans_image.py`) is positioned in image-space pixels
 * so the MapViewer pan/zoom transform scales it in lockstep with the
 * tiles.
 *
 * Stacking: `zIndex: -1` sits the layer *behind* the regular map tiles
 * inside the same transformed stacking context (created by the parent's
 * `transform`), so oceans only show through in regions the user has not
 * yet explored. `pointer-events: none` lets clicks pass through.
 */
export function OceansOverlayLayer({
  stats,
  imageWidth,
  imageHeight,
  opacity = 0.55,
}: OceansOverlayLayerProps) {
  if (!stats || imageWidth <= 0 || imageHeight <= 0) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const left = (OCEANS_WORLD_BBOX.min_x - stats.start_x) * ppbX;
  const top = (OCEANS_WORLD_BBOX.min_z - stats.start_z) * ppbZ;
  const width = (OCEANS_WORLD_BBOX.max_x - OCEANS_WORLD_BBOX.min_x) * ppbX;
  const height = (OCEANS_WORLD_BBOX.max_z - OCEANS_WORLD_BBOX.min_z) * ppbZ;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ opacity, zIndex: -1 }}
      aria-hidden
    >
      <img
        src={oceanImg}
        alt=""
        draggable={false}
        decoding="async"
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          maxWidth: "none",
          imageRendering: "pixelated",
          pointerEvents: "none",
          // TEMP DEBUG — bright outline so the bbox is visible even when
          // pixels are transparent or hidden behind tiles.
          //   outline: "4px solid red",
          //   outlineOffset: "-2px",
        }}
      />
    </div>
  );
}
