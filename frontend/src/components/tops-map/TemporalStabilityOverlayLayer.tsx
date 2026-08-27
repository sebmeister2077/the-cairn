import type { MapStats } from "@/components/MapViewer";
import type { StabilityOverlayBounds } from "@/lib/stability/types";

interface TemporalStabilityOverlayLayerProps {
  bounds: StabilityOverlayBounds | null;
  overlayUrl: string | null;
  stats: MapStats | null;
  imageWidth: number;
  imageHeight: number;
  zIndex?: number;
  opacity?: number;
}

/**
 * Renders the bundled temporal-stability depth-slice raster as an overlay
 * above the map tiles. Uses the same image-pixel projection as the climate
 * / rock-strata layers: world bounds → image-pixel rect via
 * `MapStats.start_x/z` + `width_blocks/height_blocks`.
 */
export function TemporalStabilityOverlayLayer({
  bounds,
  overlayUrl,
  stats,
  imageWidth,
  imageHeight,
  zIndex = 10,
  opacity = 0.7,
}: TemporalStabilityOverlayLayerProps) {
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
