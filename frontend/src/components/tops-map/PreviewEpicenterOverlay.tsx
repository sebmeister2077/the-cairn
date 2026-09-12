import type { MapStats } from "@/components/MapViewer";

interface PreviewEpicenterOverlayProps {
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active tileSet / WC image. */
  imageWidth: number;
  imageHeight: number;
  /** Epicenter centre in the map/UI world frame (+Z = north). */
  center: { x: number; z: number } | null;
  /** Inclusion radius, in blocks. */
  radiusBlocks: number;
}

/**
 * Draws the "mark elk-friendly" epicenter selection circle in image-pixel
 * space so the MapViewer / WebCartographer pan+zoom transform scales it in
 * lockstep with the tiles and TL markers. Everything inside the ring is what
 * epicenter mode will wire together.
 */
export function PreviewEpicenterOverlay({
  stats,
  imageWidth,
  imageHeight,
  center,
  radiusBlocks,
}: PreviewEpicenterOverlayProps) {
  if (!stats || imageWidth <= 0 || imageHeight <= 0 || !center) return null;
  if (stats.width_blocks <= 0 || stats.height_blocks <= 0) return null;
  if (radiusBlocks <= 0) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const cx = (center.x - stats.start_x) * ppbX;
  const cy = (center.z - stats.start_z) * ppbZ;
  const rx = radiusBlocks * ppbX;
  const ry = radiusBlocks * ppbZ;

  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      <div
        style={{
          position: "absolute",
          left: cx - rx,
          top: cy - ry,
          width: rx * 2,
          height: ry * 2,
          border: "2px solid #10b981",
          background: "rgba(16, 185, 129, 0.12)",
          borderRadius: "50%",
          boxSizing: "border-box",
        }}
      />
      {/* Centre crosshair so the exact epicenter is unambiguous. */}
      <div
        style={{
          position: "absolute",
          left: cx - 4,
          top: cy - 4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#10b981",
          boxShadow: "0 0 0 2px rgba(255,255,255,0.85)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
