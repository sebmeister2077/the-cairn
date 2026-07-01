import { useEffect, useMemo, useRef } from "react";
import type { MapStats } from "@/components/MapViewer";
import type { HeatmapBin } from "@/models/auction";

interface AuctionHeatmapOverlayLayerProps {
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active TOPS tileSet. */
  imageWidth: number;
  imageHeight: number;
  /** World-space heatmap bins (bottom-left corner + count per cell). */
  bins: HeatmapBin[];
  /** Bin edge length in world blocks. */
  binSize: number;
  /** "sell" renders blue, "buy" renders red. */
  variant: "sell" | "buy";
  /** Optional opacity (0-1). Defaults to 0.75. */
  opacity?: number;
}

const VARIANT_RGB: Record<"sell" | "buy", string> = {
  sell: "59,130,246", // blue-500
  buy: "239,68,68", // red-500
};

/**
 * Renders the auction "trade density" heatmap as a layer positioned in the
 * TOPS map's image-space, so the MapViewer pan/zoom transform scales it in
 * lockstep with the tiles. Mirrors the sizing approach used by
 * {@link OceansOverlayLayer}: world coordinates are converted to image pixels
 * via `imageWidth / stats.width_blocks`.
 *
 * The bins are drawn onto a low-resolution canvas (one texel per bin) whose
 * CSS box is stretched to the world-scaled size. The browser's bilinear
 * upscaling turns the discrete cells into a soft heat glow for free.
 */
export function AuctionHeatmapOverlayLayer({
  stats,
  imageWidth,
  imageHeight,
  bins,
  binSize,
  variant,
  opacity = 0.75,
}: AuctionHeatmapOverlayLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const bounds = useMemo(() => {
    if (bins.length === 0 || binSize <= 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxCount = 0;
    for (const b of bins) {
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + binSize);
      minZ = Math.min(minZ, b.z);
      maxZ = Math.max(maxZ, b.z + binSize);
      maxCount = Math.max(maxCount, b.count);
    }
    const cols = Math.max(1, Math.round((maxX - minX) / binSize));
    const rows = Math.max(1, Math.round((maxZ - minZ) / binSize));
    return { minX, maxX, minZ, maxZ, maxCount, cols, rows };
  }, [bins, binSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const rgb = VARIANT_RGB[variant];
    for (const b of bins) {
      const cx = Math.floor((b.x - bounds.minX) / binSize);
      const cz = Math.floor((b.z - bounds.minZ) / binSize);
      // sqrt gives a perceptual boost so low-traffic cells stay visible.
      const intensity = Math.sqrt(b.count / bounds.maxCount);
      ctx.fillStyle = `rgba(${rgb},${0.2 + intensity * 0.8})`;
      ctx.fillRect(cx, cz, 1, 1);
    }
  }, [bins, bounds, binSize, variant]);

  if (!stats || imageWidth <= 0 || imageHeight <= 0 || !bounds) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const left = (bounds.minX - stats.start_x) * ppbX;
  const top = (bounds.minZ - stats.start_z) * ppbZ;
  const width = (bounds.maxX - bounds.minX) * ppbX;
  const height = (bounds.maxZ - bounds.minZ) * ppbZ;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ opacity }} aria-hidden>
      <canvas
        ref={canvasRef}
        width={bounds.cols}
        height={bounds.rows}
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          maxWidth: "none",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
