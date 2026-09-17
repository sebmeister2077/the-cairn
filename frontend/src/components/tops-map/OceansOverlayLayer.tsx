import { useEffect, useMemo, useState } from "react";
import type { MapStats } from "@/components/MapViewer";
import oceanImg from "@/assets/Oceans/oceans.svg";

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

// VS world centre in blocks (1024000 / 2). The map viewer works in
// spawn-centred coords (spawn ≈ 0,0 → `start_x/start_z` = -512000) while
// `oceans.json` bodies are stored in VS-absolute coords (origin 0, centre
// ~512000). Both axes convert with `abs - OFFSET` and NO Z negation — the
// same transform the rock-strata raster uses to sit on this map
// (`ROCKSTRATA_WORLD_CENTER_OFFSET`); the raster tiles already bake in the
// N/S orientation, so absolute-space extents must not be flipped.
const WORLD_CENTER_OFFSET = 512000;

interface OceanBody {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface OceansData {
  bodies: OceanBody[];
}

interface OceansOverlayLayerProps {
  stats: MapStats | null;
  /** Natural pixel dimensions of the currently active TOPS tileSet. */
  imageWidth: number;
  imageHeight: number;
  /** Optional opacity (0-1). Defaults to 0.55 so map tiles stay readable. */
  opacity?: number;
  /** Visible world rectangle (viewer frame, spawn-centred). When set, only
   *  bodies intersecting it are rendered so panned-away boxes don't inflate
   *  the DOM. Null/undefined renders every body. */
  viewportBounds?: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

/**
 * Renders the preprocessed "oceans" raster as a background layer behind
 * the TOPS map tiles, plus the full catalogue of ocean bodies from
 * `oceans.json` drawn as translucent water rectangles. The raster only
 * covers a small area around spawn; the JSON list covers every ocean
 * across the whole ~1M-block world, so together they show oceans even in
 * regions the user has not explored.
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
  viewportBounds,
}: OceansOverlayLayerProps) {
  // Lazy-load the ~1 MB body catalogue only while the overlay is mounted
  // (i.e. enabled) so it never lands in the main bundle.
  const [bodies, setBodies] = useState<OceanBody[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("@/assets/Oceans/oceans.json")
      .then((m) => {
        if (!cancelled) setBodies((m.default as OceansData).bodies ?? []);
      })
      .catch(() => {
        if (!cancelled) setBodies([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const boxes = useMemo(() => {
    if (!bodies || !stats || imageWidth <= 0 || imageHeight <= 0) return [];
    if (stats.width_blocks <= 0 || stats.height_blocks <= 0) return [];

    const ppbX = imageWidth / stats.width_blocks;
    const ppbZ = imageHeight / stats.height_blocks;

    const toPxX = (absX: number) => (absX - WORLD_CENTER_OFFSET - stats.start_x) * ppbX;
    const toPxY = (absZ: number) => (absZ - WORLD_CENTER_OFFSET - stats.start_z) * ppbZ;

    // Cull to the visible rect (in the same viewer frame the bodies convert
    // to: absolute - OFFSET). Pad by one viewport span so boxes are already
    // mounted before they scroll in during the 300ms-debounced pan lag.
    let cull: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
    if (viewportBounds) {
      const padX = viewportBounds.maxX - viewportBounds.minX || 0;
      const padZ = viewportBounds.maxZ - viewportBounds.minZ || 0;
      cull = {
        minX: viewportBounds.minX - padX,
        maxX: viewportBounds.maxX + padX,
        minZ: viewportBounds.minZ - padZ,
        maxZ: viewportBounds.maxZ + padZ,
      };
    }

    const out: Array<{ key: number; left: number; top: number; width: number; height: number }> =
      [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (cull) {
        const bMinX = b.minX - WORLD_CENTER_OFFSET;
        const bMaxX = b.maxX - WORLD_CENTER_OFFSET;
        const bMinZ = b.minZ - WORLD_CENTER_OFFSET;
        const bMaxZ = b.maxZ - WORLD_CENTER_OFFSET;
        if (bMaxX < cull.minX || bMinX > cull.maxX || bMaxZ < cull.minZ || bMinZ > cull.maxZ) {
          continue;
        }
      }
      const x1 = toPxX(b.minX);
      const x2 = toPxX(b.maxX);
      const y1 = toPxY(b.minZ);
      const y2 = toPxY(b.maxZ);
      out.push({
        key: i,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    }
    return out;
  }, [bodies, stats, imageWidth, imageHeight, viewportBounds]);

  if (!stats || imageWidth <= 0 || imageHeight <= 0) return null;

  const ppbX = imageWidth / stats.width_blocks;
  const ppbZ = imageHeight / stats.height_blocks;

  const left = (OCEANS_WORLD_BBOX.min_x - stats.start_x) * ppbX;
  const top = (OCEANS_WORLD_BBOX.min_z - stats.start_z) * ppbZ;
  const width = (OCEANS_WORLD_BBOX.max_x - OCEANS_WORLD_BBOX.min_x) * ppbX;
  const height = (OCEANS_WORLD_BBOX.max_z - OCEANS_WORLD_BBOX.min_z) * ppbZ;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: -1 }} aria-hidden>
      {/* Ocean bodies from oceans.json — translucent water rectangles so
          they read as sea rather than the dot used for landmarks. */}
      {boxes.map((b) => (
        <div
          key={b.key}
          style={{
            position: "absolute",
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
            background: "rgba(56, 132, 199, 0.35)",
            border: "1px solid rgba(56, 132, 199, 0.55)",
            borderRadius: 2,
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      ))}
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
          opacity,
          // Override the global `img { max-width: 100% }` reset so the
          // overlay can render at its true world-scaled size (which may
          // exceed the transformed container's width).
          maxWidth: "none",
          imageRendering: "pixelated",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
