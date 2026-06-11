/**
 * Phase 2 / Phase D — region picker for region-restricted contributions.
 *
 * Renders the TOPS map inside the same {@link MapViewer} the public viewer
 * page uses, so contributors get the full pan / zoom / resolution-swap UX
 * (and the landmark overlay) when drawing the rectangle that bounds their
 * upload.
 *
 * UX model:
 * - "Draw region" toggle button. When OFF the viewer behaves like the
 *   public TOPS map (pan + wheel-zoom + toolbar). When ON, pan/zoom
 *   interactions are locked and pointer drags on the map define the
 *   selection rectangle; releasing the pointer commits the bounds. The
 *   toolbar zoom buttons remain functional in both modes.
 * - Existing selection (drawn previously, or restored from server state)
 *   is always rendered as a translucent rectangle.
 * - "Landmarks" toggle mirrors the TOPS viewer behaviour: off → only
 *   "Server" kind landmarks (always-on POIs) are shown; on → full set.
 *
 * Coordinate math: ``value`` is held in world blocks. The overlay renders
 * inside MapViewer's transformed image-space container, so child elements
 * are positioned in image-natural pixels and pointer-event clientX/Y
 * convert via the element's bounding-rect width (which already includes
 * zoom scaling).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, X } from "lucide-react";
import {
  getTopsMapLevel,
  type ContributionRegion,
  type TopsMapLevelChunks,
  type TopsMapResolutionMeta,
} from "@/lib/api";
import { MapViewer, type MapStats, type MapTileSet, type WorldPointMarker } from "./MapViewer";
import { useLandmarksOverlay } from "@/hooks/useOverlayData";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface Props {
  /** Available levels (from `/tops-map-stats`). Used to populate the
   *  resolution-swap candidate list. */
  availableLevels: TopsMapResolutionMeta[];
  /** World-block bounds the user has selected, or `null` for "no region
   *  → gap-fill mode". */
  value: ContributionRegion | null;
  onChange: (region: ContributionRegion | null) => void;
  /** Optional cap (in chunks) for non-admin contributors. */
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
/** Admin safety ceiling — admins are exempt from the per-user cap but
 *  a single huge drag produces useless coarse renders downstream. */
const ADMIN_HARD_CHUNK_CAP = 10_000;

function levelInfoStaleTimeMs(info: TopsMapLevelChunks | undefined): number {
  if (!info?.expires_at) return 0;
  const expiresAtMs = new Date(info.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, expiresAtMs - Date.now() - 2 * 60 * 1000);
}

function isLevelInfoExpired(info: TopsMapLevelChunks | undefined): boolean {
  if (!info?.expires_at) return false;
  const expiresAtMs = new Date(info.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= Date.now();
}

function levelToTileSet(info: TopsMapLevelChunks): MapTileSet {
  return {
    id: info.level,
    imageWidth: info.image_w,
    imageHeight: info.image_h,
    chunks: info.chunks.map((c) => {
      const px = c.cx * info.chunk_w;
      const py = c.cy * info.chunk_h;
      return {
        cx: c.cx,
        cy: c.cy,
        url: c.url,
        px,
        py,
        w: Math.min(info.chunk_w, info.image_w - px),
        h: Math.min(info.chunk_h, info.image_h - py),
      };
    }),
  };
}

export function ContributionRegionPicker({
  availableLevels,
  value,
  onChange,
  tileAreaCap = null,
  tileSizeBlocks = TILE_SIZE_DEFAULT,
  disabled = false,
}: Props) {
  const queryClient = useQueryClient();

  // Choose the lowest-resolution completed level as the *initial* view so
  // we don't waste bandwidth before the user zooms. The viewer's
  // ``enhanceTilesFn`` will swap in a higher one automatically.
  const initialLevel = useMemo(() => {
    const complete = availableLevels.filter((l) => l.status === "complete");
    if (complete.length === 0) return null;
    return complete.reduce((a, b) =>
      (a.max_dimension ?? Infinity) <= (b.max_dimension ?? Infinity) ? a : b,
    );
  }, [availableLevels]);

  const [activeLevelNumber, setActiveLevelNumber] = useState<number | null>(null);
  useEffect(() => {
    setActiveLevelNumber((prev) => prev ?? initialLevel?.level ?? null);
  }, [initialLevel]);

  const levelInfoQuery = useQuery<TopsMapLevelChunks>({
    queryKey: ["tops-map-level", activeLevelNumber],
    queryFn: () => {
      if (activeLevelNumber == null) {
        throw new Error("No resolution level available yet");
      }
      return getTopsMapLevel(activeLevelNumber);
    },
    enabled: activeLevelNumber != null,
    staleTime: ({ state }) => levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
    refetchOnMount: "always",
  });

  const tileSet = useMemo<MapTileSet | null>(() => {
    const info = levelInfoQuery.data;
    if (!info || isLevelInfoExpired(info)) return null;
    return levelToTileSet(info);
  }, [levelInfoQuery.data]);

  // World bounds for coordinate math — taken from the active level so
  // they always match the visible tile set. (Across levels of the same
  // map ``start_x`` / ``width_blocks`` are identical, so the rectangle
  // stays anchored to the correct world coords during a resolution swap.)
  const stats = useMemo<MapStats | null>(() => {
    const info = levelInfoQuery.data;
    if (!info) return null;
    return {
      pieces: 0,
      size_mb: 0,
      width_chunks: Math.round(info.width_blocks / tileSizeBlocks),
      height_chunks: Math.round(info.height_blocks / tileSizeBlocks),
      width_blocks: info.width_blocks,
      height_blocks: info.height_blocks,
      start_x: info.start_x,
      start_z: info.start_z,
    };
  }, [levelInfoQuery.data, tileSizeBlocks]);

  // Auto-enhance: pick the smallest completed level whose ``max_dimension``
  // covers the requested target. Mirrors the pattern in
  // {@link TOPSMapViewPage}.
  const selectLevelForZoom = useCallback(
    async (targetMaxDim: number): Promise<MapTileSet> => {
      const completed = availableLevels
        .filter((r) => r.status === "complete")
        .slice()
        .sort((a, b) => a.max_dimension - b.max_dimension);
      const candidate =
        completed.find((r) => r.max_dimension >= targetMaxDim) ?? completed[completed.length - 1];
      if (!candidate) throw new Error("No completed resolution available");

      const info = await queryClient.fetchQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", candidate.level],
        queryFn: () => getTopsMapLevel(candidate.level),
        staleTime: ({ state }) =>
          levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
      });
      if (!info.chunks?.length) throw new Error("Resolution chunks unavailable");
      return levelToTileSet(info);
    },
    [availableLevels, queryClient],
  );

  // Drawing-mode toggle & landmark toggle.
  const [drawing, setDrawing] = useState(false);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const landmarksQuery = useLandmarksOverlay();
  const allLandmarks = landmarksQuery.data?.data;
  const landmarkPoints = useMemo<WorldPointMarker[]>(() => {
    if (!allLandmarks) return [];
    return showLandmarks ? allLandmarks : allLandmarks.filter((p) => p.kind === "Server");
  }, [allLandmarks, showLandmarks]);

  // In-progress drag rectangle (in image-natural pixel coords). When set,
  // overrides ``value`` for rendering so the user sees their selection
  // grow live without committing until pointer-up.
  const [dragRect, setDragRect] = useState<PixelRect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Center the map on the existing selection once when the level info
  // first loads (and again whenever ``value`` becomes non-null after a
  // prior null). Stable focus reference so MapViewer doesn't re-fly
  // continuously while we're rendering.
  const focusPoint = useMemo(() => {
    if (!value) return undefined;
    return {
      x: Math.floor((value.min_x + value.max_x) / 2),
      z: Math.floor((value.min_z + value.max_z) / 2),
    };
  }, [value]);

  if (availableLevels.length === 0) {
    return (
      <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        No TOPS map preview is available yet — the region picker needs at least one generated map
        level.
      </div>
    );
  }
  if (!initialLevel) {
    return (
      <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        No completed TOPS map level — generate one first.
      </div>
    );
  }
  const error = levelInfoQuery.error instanceof Error ? levelInfoQuery.error.message : null;

  const selectionTiles = value ? regionTileArea(value, tileSizeBlocks) : 0;
  const overCap = tileAreaCap != null && selectionTiles > tileAreaCap;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : drawing ? (
            <span>
              Drag on the map to select the region your upload should overwrite. The toolbar zoom
              buttons still work while drawing.
            </span>
          ) : (
            <span className="text-muted-foreground">
              Pan and zoom to find the area, then enable “Draw region” to select bounds.
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="flex items-center gap-2 text-xs">
            <Switch
              checked={showLandmarks}
              onCheckedChange={setShowLandmarks}
              aria-label="Toggle landmarks"
              disabled={disabled}
            />
            Landmarks
          </Label>
          <Button
            type="button"
            size="sm"
            variant={drawing ? "default" : "outline"}
            onClick={() => setDrawing((v) => !v)}
            disabled={disabled || !tileSet}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            {drawing ? "Drawing…" : "Draw region"}
          </Button>
          {value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDragRect(null);
                dragStartRef.current = null;
                onChange(null);
              }}
              disabled={disabled}
            >
              <X className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>
      </div>
      <MapViewer
        tileSet={tileSet}
        stats={stats}
        alt="TOPS map region picker"
        height="540px"
        focusPoint={focusPoint}
        focusZoom={2}
        overlayPoints={landmarkPoints}
        interactionsLocked={drawing}
        enhanceTilesFn={selectLevelForZoom}
        onTileSetEnhanced={(next) => {
          // Drop the override so the active-level effect doesn't re-scale
          // pan/zoom — mirrors the comment in TOPSMapViewPage.
          if (typeof next.id === "number") setActiveLevelNumber(next.id);
        }}
        overlayRender={({ zoom, imgNatural }) => {
          const rect = dragRect ?? regionToPixelRect(value, stats, imgNatural);
          return (
            <DrawingOverlay
              imgNatural={imgNatural}
              zoom={zoom}
              rect={rect}
              drawing={drawing && !disabled}
              onStart={(pt) => {
                dragStartRef.current = pt;
                setDragRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
              }}
              onMove={(pt) => {
                const s = dragStartRef.current;
                if (!s) return;
                setDragRect({
                  x: Math.min(pt.x, s.x),
                  y: Math.min(pt.y, s.y),
                  w: Math.abs(pt.x - s.x),
                  h: Math.abs(pt.y - s.y),
                });
              }}
              onEnd={() => {
                const r = dragRect;
                const start = dragStartRef.current;
                dragStartRef.current = null;
                setDragRect(null);
                if (!r || !stats) return;
                // Reject pinpoint-tap "drags" (e.g. user just clicked) so
                // a stray click doesn't accidentally clear or create a
                // 1-pixel region.
                if (!start || (r.w < 2 && r.h < 2)) return;
                const region = pixelRectToRegion(r, stats, imgNatural);
                const clamped = clampRegionToCap(region, tileAreaCap, tileSizeBlocks);
                onChange(clamped);
              }}
            />
          );
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {value ? (
          <>
            <span>
              Region: x [{value.min_x}, {value.max_x}], z [{value.min_z}, {value.max_z}] blocks
            </span>
            <span>· {selectionTiles.toLocaleString()} chunks</span>
            {tileAreaCap != null && (
              <span className={overCap ? "text-destructive" : ""}>
                · cap {tileAreaCap.toLocaleString()} chunks
                {overCap ? " (over!)" : ""}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            No region selected — your upload will gap-fill unmapped chunks only (legacy mode).
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay: renders the rectangle and, when in drawing mode, captures the
// pointer drag. Lives inside MapViewer's transformed container so its
// coordinate system is image-natural pixels.
// ---------------------------------------------------------------------------
function DrawingOverlay({
  imgNatural,
  zoom,
  rect,
  drawing,
  onStart,
  onMove,
  onEnd,
}: {
  imgNatural: { w: number; h: number };
  zoom: number;
  rect: PixelRect | null;
  drawing: boolean;
  onStart: (pt: { x: number; y: number }) => void;
  onMove: (pt: { x: number; y: number }) => void;
  onEnd: () => void;
}) {
  // Translate pointer event → image-natural pixel using the surface's
  // bounding-rect width (which already reflects MapViewer's pan/zoom
  // transform), so we don't have to know the current pan offsets.
  function eventToPixel(ev: React.PointerEvent<HTMLDivElement>) {
    const r = ev.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return {
      x: ((ev.clientX - r.left) * imgNatural.w) / r.width,
      y: ((ev.clientY - r.top) * imgNatural.h) / r.height,
    };
  }

  const strokeWidth = Math.max(1 / zoom, 0.5);

  return (
    <div
      className="absolute inset-0"
      style={{
        left: 0,
        top: 0,
        width: imgNatural.w,
        height: imgNatural.h,
        // Only capture pointer events while drawing — otherwise pan/zoom
        // gestures need to pass through to MapViewer.
        pointerEvents: drawing ? "auto" : "none",
        cursor: drawing ? "crosshair" : "default",
        touchAction: "none",
      }}
      onPointerDown={(ev) => {
        if (!drawing) return;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        onStart(eventToPixel(ev));
      }}
      onPointerMove={(ev) => {
        if (!drawing) return;
        onMove(eventToPixel(ev));
      }}
      onPointerUp={(ev) => {
        if (!drawing) return;
        ev.currentTarget.releasePointerCapture(ev.pointerId);
        onEnd();
      }}
      onPointerCancel={(ev) => {
        if (!drawing) return;
        ev.currentTarget.releasePointerCapture(ev.pointerId);
        onEnd();
      }}
    >
      {rect && rect.w > 0 && rect.h > 0 && (
        <div
          className="absolute"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            backgroundColor: "rgba(56, 189, 248, 0.20)",
            border: `${strokeWidth * 2}px solid rgba(14, 165, 233, 0.95)`,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// World ↔ image-pixel conversion helpers. ``stats`` carries the level's
// world extent; ``imgNatural`` is the current tile set's natural pixel
// size (handed in by MapViewer).
// ---------------------------------------------------------------------------
function pixelRectToRegion(
  rect: PixelRect,
  stats: MapStats,
  imgNatural: { w: number; h: number },
): ContributionRegion {
  const block_per_px_x = stats.width_blocks / imgNatural.w;
  const block_per_px_z = stats.height_blocks / imgNatural.h;
  const min_x = Math.floor(stats.start_x + rect.x * block_per_px_x);
  const max_x = Math.floor(stats.start_x + (rect.x + rect.w) * block_per_px_x);
  const min_z = Math.floor(stats.start_z + rect.y * block_per_px_z);
  const max_z = Math.floor(stats.start_z + (rect.y + rect.h) * block_per_px_z);
  return { min_x, max_x, min_z, max_z };
}

function regionToPixelRect(
  region: ContributionRegion | null,
  stats: MapStats | null,
  imgNatural: { w: number; h: number },
): PixelRect | null {
  if (!region || !stats) return null;
  const px_per_block_x = imgNatural.w / stats.width_blocks;
  const px_per_block_z = imgNatural.h / stats.height_blocks;
  const x = (region.min_x - stats.start_x) * px_per_block_x;
  const y = (region.min_z - stats.start_z) * px_per_block_z;
  const w = (region.max_x - region.min_x + 1) * px_per_block_x;
  const h = (region.max_z - region.min_z + 1) * px_per_block_z;
  return { x, y, w, h };
}

function regionTileArea(region: ContributionRegion, tileSize: number): number {
  const tx_min = Math.floor(region.min_x / tileSize);
  const tx_max = Math.floor(region.max_x / tileSize);
  const tz_min = Math.floor(region.min_z / tileSize);
  const tz_max = Math.floor(region.max_z / tileSize);
  return Math.max(0, tx_max - tx_min + 1) * Math.max(0, tz_max - tz_min + 1);
}

/**
 * Shrinks ``region`` symmetrically around its centre until its chunk-area
 * fits within ``cap``. ``cap=null`` falls back to {@link ADMIN_HARD_CHUNK_CAP}.
 * Keeps the bounds aligned to whole tiles (so the drag rectangle and the
 * submitted region stay consistent with the backend's tile rounding).
 */
function clampRegionToCap(
  region: ContributionRegion,
  cap: number | null,
  tileSize: number,
): ContributionRegion {
  const effectiveCap = cap == null ? ADMIN_HARD_CHUNK_CAP : cap;
  const area = regionTileArea(region, tileSize);
  if (area <= effectiveCap) return region;

  const tx_min = Math.floor(region.min_x / tileSize);
  const tx_max = Math.floor(region.max_x / tileSize);
  const tz_min = Math.floor(region.min_z / tileSize);
  const tz_max = Math.floor(region.max_z / tileSize);
  const width = tx_max - tx_min + 1;
  const height = tz_max - tz_min + 1;
  const scale = Math.sqrt(effectiveCap / (width * height));
  const new_w = Math.max(1, Math.floor(width * scale));
  const new_h = Math.max(1, Math.floor(height * scale));
  const cx = Math.floor((tx_min + tx_max) / 2);
  const cz = Math.floor((tz_min + tz_max) / 2);
  const new_tx_min = cx - Math.floor(new_w / 2);
  const new_tx_max = new_tx_min + new_w - 1;
  const new_tz_min = cz - Math.floor(new_h / 2);
  const new_tz_max = new_tz_min + new_h - 1;
  return {
    min_x: new_tx_min * tileSize,
    max_x: (new_tx_max + 1) * tileSize - 1,
    min_z: new_tz_min * tileSize,
    max_z: (new_tz_max + 1) * tileSize - 1,
  };
}
