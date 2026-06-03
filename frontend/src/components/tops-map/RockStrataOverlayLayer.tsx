import type { MapStats } from "@/components/MapViewer";
import type { RockStrataOverlayBounds } from "@/hooks/useRockStrataOverlay";

interface RockStrataOverlayLayerProps {
  bounds: RockStrataOverlayBounds | null;
  overlayUrl: string | null;
  stats: MapStats | null;
  /** Natural pixel dimensions of the active TOPS tileSet. */
  imageWidth: number;
  imageHeight: number;
  /** Z-stacking position. Defaults to 10 so the layer sits above the
   *  map tiles (which use auto z-index) inside the same transformed
   *  stacking context. Use a negative number to sit behind them like
   *  the oceans layer. */
  zIndex?: number;
  opacity?: number;
}

/**
 * Renders the cropped + filtered rock-strata raster as an overlay above
 * the TOPS map tiles. World-block bounds from the export's `world.json`
 * (after cropping in {@link useRockStrataOverlay}) are projected into
 * the active map's image-pixel space using `MapStats.start_x/start_z` +
 * `MapStats.width_blocks/height_blocks` — the same conversion used by
 * `OceansOverlayLayer` and `ContributionRegionPicker`.
 */
export function RockStrataOverlayLayer({
  bounds,
  overlayUrl,
  stats,
  imageWidth,
  imageHeight,
  zIndex = 10,
  opacity = 0.85,
}: RockStrataOverlayLayerProps) {
  if (!bounds || !overlayUrl || !stats) return null;
  if (imageWidth <= 0 || imageHeight <= 0) return null;
  if (stats.width_blocks <= 0 || stats.height_blocks <= 0) return null;
  if (bounds.extentX <= 0 || bounds.extentZ <= 0) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const left = (bounds.originX - stats.start_x) * ppbX;
  const top = (bounds.originZ - stats.start_z) * ppbZ;
  const width = bounds.extentX * ppbX;
  const height = bounds.extentZ * ppbZ;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ opacity, zIndex }} aria-hidden>
      <img
        src={overlayUrl}
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
        }}
      />
    </div>
  );
}
