/**
 * Phase 2 — region-restricted updates: lets a contributor draw a single
 * rectangle on the existing TOPS map preview to constrain which tiles
 * their upload should overwrite. Outputs world-block bounds.
 *
 * Implementation notes
 * --------------------
 * - Reuses the existing `getTopsMapLevel` + `stitchChunksToCanvas` pipeline
 *   so we don't re-render the map. We grab the lowest-resolution complete
 *   level (lowest pixel dimension == highest scale) and draw it once into
 *   an offscreen canvas, then blit to the visible canvas. The coarse level
 *   is plenty for picking a rectangle and avoids fetching gigabytes of
 *   high-res chunks.
 * - The rectangle is committed in world-block coordinates derived from the
 *   level's `start_x`, `start_z`, `image_w`, `image_h`, `width_blocks`,
 *   `height_blocks` fields.
 * - We do not snap to tile boundaries here — the backend rounds the bounds
 *   to whole tiles when filtering positions.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getTopsMapLevel,
  type ContributionRegion,
  type TopsMapLevelChunks,
  type TopsMapResolutionMeta,
} from "@/lib/api";
import { stitchChunksToCanvas } from "@/lib/stitch-chunks";
import { useEffectWithAbort } from "@/hooks/useEffectWithAbort";

interface Props {
  /** Available levels (from `/tops-map-stats`). The picker prefers the
   *  smallest "complete" level so the upfront load is cheap. */
  availableLevels: TopsMapResolutionMeta[];
  /** World-block bounds the user has selected, or `null` for "no region
   *  → gap-fill mode". */
  value: ContributionRegion | null;
  onChange: (region: ContributionRegion | null) => void;
  /** Optional cap (in tile-area) for non-admin contributors. */
  tileAreaCap?: number | null;
  /** Tile size in world blocks — used for the cap calculation banner. */
  tileSizeBlocks?: number;
  disabled?: boolean;
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TILE_SIZE_DEFAULT = 32;
const MAX_DISPLAY_DIM = 720;

export function ContributionRegionPicker({
  availableLevels,
  value,
  onChange,
  tileAreaCap = null,
  tileSizeBlocks = TILE_SIZE_DEFAULT,
  disabled = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const [level, setLevel] = useState<TopsMapLevelChunks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<PixelRect | null>(null);

  // Pick the "least heavy" complete level so we don't pull a gigabyte of
  // chunks just to let the user draw a rectangle.
  const targetLevel = useMemo(() => {
    const complete = availableLevels.filter((l) => l.status === "complete");
    if (complete.length === 0) return null;
    return complete.reduce((a, b) =>
      (a.max_dimension ?? Infinity) <= (b.max_dimension ?? Infinity) ? a : b,
    );
  }, [availableLevels]);

  useEffectWithAbort(
    ({ signal }) => {
      if (!targetLevel) return;
      setLoading(true);
      setError(null);
      (async () => {
        try {
          const lvl = await getTopsMapLevel(targetLevel.level);
          if (signal.aborted) return;
          const canvas = await stitchChunksToCanvas(lvl, {
            signal,
          });
          if (signal.aborted) return;
          offscreenRef.current = canvas;
          setLevel(lvl);
        } catch (e) {
          if (!signal.aborted) {
            setError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      })();
    },
    [targetLevel],
  );

  // Display scale: shrink the offscreen image to fit MAX_DISPLAY_DIM while
  // keeping aspect ratio.
  const display = useMemo(() => {
    if (!level) return null;
    const ratio = Math.min(MAX_DISPLAY_DIM / level.image_w, MAX_DISPLAY_DIM / level.image_h, 1);
    return {
      w: Math.max(1, Math.round(level.image_w * ratio)),
      h: Math.max(1, Math.round(level.image_h * ratio)),
      ratio,
    };
  }, [level]);

  // Render the underlying map + the current selection on top.
  useEffect(() => {
    const canvas = canvasRef.current;
    const off = offscreenRef.current;
    if (!canvas || !off || !display) return;
    canvas.width = display.w;
    canvas.height = display.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, display.w, display.h);

    const rect = dragRect ?? regionToPixelRect(value, level, display);
    if (rect) {
      ctx.fillStyle = "rgba(56, 189, 248, 0.25)";
      ctx.strokeStyle = "rgba(14, 165, 233, 0.95)";
      ctx.lineWidth = 2;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  }, [display, dragRect, value, level]);

  function eventToPixel(ev: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width, ev.clientX - rect.left));
    const y = Math.max(0, Math.min(canvas.height, ev.clientY - rect.top));
    return { x, y };
  }

  function handlePointerDown(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || !display || !level) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const pt = eventToPixel(ev);
    setDragStart(pt);
    setDragRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
  }

  function handlePointerMove(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart) return;
    const pt = eventToPixel(ev);
    setDragRect({
      x: Math.min(pt.x, dragStart.x),
      y: Math.min(pt.y, dragStart.y),
      w: Math.abs(pt.x - dragStart.x),
      h: Math.abs(pt.y - dragStart.y),
    });
  }

  function handlePointerUp(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart || !level || !display) return;
    ev.currentTarget.releasePointerCapture(ev.pointerId);
    const rect = dragRect;
    setDragStart(null);
    setDragRect(null);
    if (!rect || rect.w < 4 || rect.h < 4) {
      // Treat tiny selections as a clear, not a region.
      onChange(null);
      return;
    }
    const region = pixelRectToRegion(rect, level, display);
    onChange(region);
  }

  function clear() {
    setDragRect(null);
    setDragStart(null);
    onChange(null);
  }

  if (availableLevels.length === 0) {
    return (
      <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        No TOPS map preview is available yet — the region picker needs at least one generated map
        level.
      </div>
    );
  }
  if (!targetLevel) {
    return (
      <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        No completed TOPS map level — generate one first.
      </div>
    );
  }

  const selectionTiles = value ? regionTileArea(value, tileSizeBlocks) : 0;
  const overCap = tileAreaCap != null && selectionTiles > tileAreaCap;

  return (
    <div className="space-y-2">
      <div className="text-sm">
        {loading && <span>Loading map preview…</span>}
        {error && <span className="text-destructive">{error}</span>}
        {!loading && !error && (
          <span>
            Drag on the map to select the region your upload should overwrite. Outside the
            rectangle, existing tiles stay untouched.
          </span>
        )}
      </div>
      <div
        className="relative inline-block rounded border bg-muted"
        style={{ touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            cursor: disabled ? "not-allowed" : "crosshair",
            display: "block",
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {value ? (
          <>
            <span>
              Region: x [{value.min_x}, {value.max_x}], z [{value.min_z}, {value.max_z}] blocks
            </span>
            <span>· {selectionTiles.toLocaleString()} tiles</span>
            {tileAreaCap != null && (
              <span className={overCap ? "text-destructive" : ""}>
                · cap {tileAreaCap.toLocaleString()} tiles
                {overCap ? " (over!)" : ""}
              </span>
            )}
            <button
              type="button"
              className="rounded border px-2 py-0.5"
              onClick={clear}
              disabled={disabled}
            >
              Clear region
            </button>
          </>
        ) : (
          <span className="text-muted-foreground">
            No region selected — your upload will gap-fill unmapped tiles only (legacy mode).
          </span>
        )}
      </div>
    </div>
  );
}

function pixelRectToRegion(
  rect: PixelRect,
  level: TopsMapLevelChunks,
  display: { w: number; h: number; ratio: number },
): ContributionRegion {
  const px_to_block_x = level.width_blocks / display.w;
  const px_to_block_z = level.height_blocks / display.h;
  const min_x = Math.floor(level.start_x + rect.x * px_to_block_x);
  const max_x = Math.floor(level.start_x + (rect.x + rect.w) * px_to_block_x);
  const min_z = Math.floor(level.start_z + rect.y * px_to_block_z);
  const max_z = Math.floor(level.start_z + (rect.y + rect.h) * px_to_block_z);
  return { min_x, max_x, min_z, max_z };
}

function regionToPixelRect(
  region: ContributionRegion | null,
  level: TopsMapLevelChunks | null,
  display: { w: number; h: number; ratio: number } | null,
): PixelRect | null {
  if (!region || !level || !display) return null;
  const block_to_px_x = display.w / level.width_blocks;
  const block_to_px_z = display.h / level.height_blocks;
  const x = (region.min_x - level.start_x) * block_to_px_x;
  const y = (region.min_z - level.start_z) * block_to_px_z;
  const w = (region.max_x - region.min_x) * block_to_px_x;
  const h = (region.max_z - region.min_z) * block_to_px_z;
  return { x, y, w, h };
}

function regionTileArea(region: ContributionRegion, tileSize: number): number {
  const tx_min = Math.floor(region.min_x / tileSize);
  const tx_max = Math.floor(region.max_x / tileSize);
  const tz_min = Math.floor(region.min_z / tileSize);
  const tz_max = Math.floor(region.max_z / tileSize);
  return Math.max(0, tx_max - tx_min + 1) * Math.max(0, tz_max - tz_min + 1);
}
