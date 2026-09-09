import type { MapStats } from "@/components/MapViewer";

interface AdminTraderAreaOverlayProps {
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active tileSet / WC image. */
  imageWidth: number;
  imageHeight: number;
  /** Selection box in the map/UI world frame (+Z = north). */
  box: { min_x: number; max_x: number; min_z: number; max_z: number } | null;
}

/**
 * Draws the admin "remove traders from this area" selection box in image-pixel
 * space so the MapViewer / WebCartographer pan+zoom transform scales it in
 * lockstep with the tiles and trader markers. World coordinates use the same
 * +Z = north frame as {@link MapStats.start_x}/`start_z` and the projected
 * overlay points, so the box lines up with the trader dots inside it.
 */
export function AdminTraderAreaOverlay({
  stats,
  imageWidth,
  imageHeight,
  box,
}: AdminTraderAreaOverlayProps) {
  if (!stats || imageWidth <= 0 || imageHeight <= 0 || !box) return null;
  if (stats.width_blocks <= 0 || stats.height_blocks <= 0) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const left = (box.min_x - stats.start_x) * ppbX;
  const top = (box.min_z - stats.start_z) * ppbZ;
  const width = (box.max_x - box.min_x) * ppbX;
  const height = (box.max_z - box.min_z) * ppbZ;

  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      <div
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          border: "2px solid #ef4444",
          background: "rgba(239, 68, 68, 0.12)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
