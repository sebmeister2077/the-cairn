import { useMemo } from "react";

import type { MapStats } from "@/components/MapViewer";
import type { ResourceDeposit } from "@/lib/api";
import type { ResourcesOverlayState } from "@/hooks/useResourcesOverlay";

const VS_CHUNK_SIZE = 32;

interface ResourcesOverlayLayerProps {
  state: ResourcesOverlayState;
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active TOPS tileSet. */
  imageWidth: number;
  imageHeight: number;
  onDepositClick?: (deposit: ResourceDeposit) => void;
  /** Currently-selected deposit to highlight, if any. */
  selectedDeposit?: ResourceDeposit | null;
}

/**
 * Overlay JSX rendered inside MapViewer's transformed (pan/zoom) container.
 * All positions/sizes are in *image-space pixels* — the parent transform
 * scales the layer to screen coordinates.
 *
 * Heatmap layers: rendered as one `<img>` per chunk PNG, identically to the
 * base TOPS tile layout. Deposits: rendered as small absolutely-positioned
 * `<button>`s for clickability.
 */
export function ResourcesOverlayLayer({
  state,
  stats,
  imageWidth,
  imageHeight,
  onDepositClick,
  selectedDeposit,
}: ResourcesOverlayLayerProps) {
  const {
    manifest,
    activeLayers,
    opacity,
    depositsVisible,
    depositTypeVisibility,
    deposits,
    tilesFor,
    bestLevelFor,
  } = state;

  // Lookup color per deposit type id.
  const depositColorById = useMemo(() => {
    const m = new Map<string, string>();
    if (manifest) for (const t of manifest.deposit_types) m.set(t.id, t.color);
    return m;
  }, [manifest]);

  if (!manifest || !stats || imageWidth <= 0 || imageHeight <= 0) return null;

  // Pixels-per-block for the currently active TOPS resolution.
  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const toImgX = (worldX: number) => (worldX - stats.start_x) * ppbX;
  const toImgZ = (worldZ: number) => (worldZ - stats.start_z) * ppbZ;

  // Heatmap chunk size in image-space pixels. Each exporter tile covers
  // 32x32 blocks regardless of its own pixel dimensions (the manifest's
  // ``tile_pixels_per_chunk`` is informational only — the rendered img is
  // resized to the chunk's image-space footprint).
  const tileImgW = VS_CHUNK_SIZE * ppbX;
  const tileImgH = VS_CHUNK_SIZE * ppbZ;

  // Deposit dot radius in image-space pixels. Constant in image-space means
  // dots scale with the map: at the tightest zoom they're a few screen px,
  // when zoomed in they grow. Picked to be visible across typical zooms.
  const dotRadiusImg = Math.max(2, 2 * ppbX);
  const selectedRadiusImg = dotRadiusImg * 1.6;

  return (
    <>
      {/* Heatmap layers — drawn in the order declared by the manifest so
          later layers paint over earlier ones. */}
      {manifest.layers.map((layer) => {
        if (layer.kind !== "heatmap") return null;
        if (!activeLayers[layer.id]) return null;
        const level = bestLevelFor(layer.id);
        if (level == null) return null;
        const tiles = tilesFor(layer.id, level);
        if (tiles.length === 0) return null;
        return (
          <div key={layer.id} className="absolute inset-0 pointer-events-none" style={{ opacity }}>
            {tiles.map((t) => (
              <img
                key={`${layer.id}:${t.cx}-${t.cy}`}
                src={t.url}
                alt=""
                draggable={false}
                decoding="async"
                style={{
                  position: "absolute",
                  left: toImgX(t.cx * VS_CHUNK_SIZE),
                  top: toImgZ(t.cy * VS_CHUNK_SIZE),
                  width: tileImgW,
                  height: tileImgH,
                  imageRendering: "pixelated",
                  pointerEvents: "none",
                }}
              />
            ))}
          </div>
        );
      })}

      {/* Deposit dots. */}
      {depositsVisible &&
        deposits.map((d, i) => {
          if (depositTypeVisibility[d.type] === false) return null;
          const cx = toImgX(d.x);
          const cy = toImgZ(d.z);
          const isSelected =
            selectedDeposit != null &&
            selectedDeposit.x === d.x &&
            selectedDeposit.y === d.y &&
            selectedDeposit.z === d.z &&
            selectedDeposit.type === d.type;
          const r = isSelected ? selectedRadiusImg : dotRadiusImg;
          const color = depositColorById.get(d.type) ?? "#ffffff";
          return (
            <button
              type="button"
              key={`${d.type}:${d.x},${d.y},${d.z}:${i}`}
              onClick={(e) => {
                e.stopPropagation();
                onDepositClick?.(d);
              }}
              title={`${d.type} @ (${d.x}, ${d.y}, ${d.z})`}
              style={{
                position: "absolute",
                left: cx - r,
                top: cy - r,
                width: r * 2,
                height: r * 2,
                borderRadius: "50%",
                backgroundColor: color,
                border: isSelected
                  ? "2px solid rgba(255,255,255,0.95)"
                  : "1px solid rgba(0,0,0,0.7)",
                boxShadow: isSelected
                  ? "0 0 0 1px rgba(0,0,0,0.6), 0 0 6px rgba(255,255,255,0.6)"
                  : "0 0 0 0.5px rgba(0,0,0,0.4)",
                padding: 0,
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            />
          );
        })}
    </>
  );
}
