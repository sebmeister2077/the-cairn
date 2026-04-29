import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw, Crosshair, Loader2 } from "lucide-react";

const WHEEL_ZOOM_FACTOR = 1.3;
const BUTTON_ZOOM_FACTOR = 1.75;
// Render this many extra tile widths around the viewport so panning never
// reveals empty edges before the next render lands.
const TILE_OVERSCAN_PX = 256;

export interface MapStats {
  pieces: number;
  size_mb: number;
  width_chunks: number;
  height_chunks: number;
  width_blocks: number;
  height_blocks: number;
  start_x: number;
  start_z: number;
}

export interface WorldLineSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface WorldPointMarker {
  x: number;
  z: number;
  label?: string;
  kind?: "Base" | "Server" | "Misc";
}
export type LandmarkProperty = {
  label: string;
  type: "Base" | "Server" | "Misc";
  z?: number;
};

export interface MapTile {
  cx: number;
  cy: number;
  url: string;
  /** Image-space pixel origin of the tile's top-left corner. */
  px: number;
  py: number;
  /** Tile width/height in image-space pixels. */
  w: number;
  h: number;
}

export interface MapTileSet {
  /** Stable identity. When this changes the viewer treats it as a new map. */
  id: string | number;
  tiles: MapTile[];
  imageWidth: number;
  imageHeight: number;
}

interface MapViewerProps {
  /**
   * Base image URL. Mutually exclusive with `tileSet`. When this changes the
   * viewer resets (zoom/pan/enhance).
   */
  imageUrl?: string | null;
  /**
   * Tile-based source. When provided the viewer renders each tile as a
   * separately positioned `<img>` instead of one giant image, with viewport
   * culling so only the tiles intersecting the visible area are in the DOM.
   * Avoids the giant `canvas.toBlob` round-trip needed for the single-image
   * path.
   */
  tileSet?: MapTileSet | null;
  /** Map stats used for coordinate overlay and "center on origin" button. */
  stats?: MapStats | null;
  alt?: string;
  /** CSS height of the canvas, e.g. "70vh" or "400px". */
  height?: string;
  /**
   * When provided, auto-enhance fires when the user zooms in past a threshold.
   * The function must return a Blob of the map at a higher max dimension.
   */
  enhanceFn?: (maxDim: number) => Promise<Blob>;
  /**
   * Tile-mode equivalent of `enhanceFn`. When provided alongside `tileSet`,
   * the viewer awaits a higher-resolution `MapTileSet` and swaps in place
   * (with scale compensation), avoiding any monolithic encode/decode.
   */
  enhanceTilesFn?: (maxDim: number) => Promise<MapTileSet>;
  /** Notified after an enhance-tiles swap completes (e.g. so the parent can persist the new level). */
  onTileSetEnhanced?: (next: MapTileSet) => void;
  /** Extra buttons rendered before the zoom controls in the toolbar. */
  toolbarStart?: React.ReactNode;
  /** Row rendered above the toolbar (e.g. a legend). */
  legend?: React.ReactNode;
  /** Whether the canvas gets `rounded-md border`. Default true. */
  bordered?: boolean;
  /** Optional callback fired when the base image fails to load. */
  onImageError?: () => void;
  /** Optional world-space line segments rendered over the map image. */
  overlaySegments?: WorldLineSegment[];
  /** Optional world-space point markers rendered over the map image. */
  overlayPoints?: WorldPointMarker[];
  /** Optional callback fired when an overlay segment is clicked. */
  onOverlaySegmentClick?: (segment: WorldLineSegment | null) => void;
  /** Optional callback fired when an overlay segment is right-clicked (context menu). */
  onOverlaySegmentRightClick?: (segment: WorldLineSegment) => void;
  /**
   * Optional segment to render with the same highlighted style as the
   * hover state (e.g. a "pinned" selection from the parent). Compared by
   * value to the entries in `overlaySegments`.
   */
  highlightedSegment?: WorldLineSegment | null;
  /**
   * Optional set of segments to render with the highlighted style. Used by
   * features like "favorite TL groupings" to emphasise many segments at
   * once. Membership is determined by exact-coord match against entries in
   * `overlaySegments`. Combines additively with `highlightedSegment`.
   */
  highlightedSegments?: WorldLineSegment[];
  /**
   * When set to a new object, the viewer pans and zooms to that world coordinate.
   * Pass a new object reference each time to trigger navigation.
   */
  focusPoint?: { x: number; z: number };
  /** Zoom level to use when flying to a focusPoint. Default 4. */
  focusZoom?: number;
}

export function MapViewer({
  imageUrl,
  tileSet,
  stats = null,
  alt = "Map",
  height = "70vh",
  enhanceFn,
  enhanceTilesFn,
  onTileSetEnhanced,
  toolbarStart,
  legend,
  bordered = true,
  onImageError,
  overlaySegments,
  overlayPoints,
  onOverlaySegmentClick,
  onOverlaySegmentRightClick,
  highlightedSegment,
  highlightedSegments,
  focusPoint,
  focusZoom = 4,
}: MapViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  // Natural pixel size of the blob-mode `<img>`. In tile mode we derive
  // dimensions from the tileSet directly (see `imgNatural` below).
  const [blobImgNatural, setBlobImgNatural] = useState({ w: 0, h: 0 });
  const [hoveredOverlayIndex, setHoveredOverlayIndex] = useState<number | null>(null);
  const [renderedMaxDim, setRenderedMaxDim] = useState(4096);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);
  const [enhancedTileSet, setEnhancedTileSet] = useState<MapTileSet | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // Tile-mode bookkeeping: which tileSet id we've already centered on, so
  // URL-rotation refreshes don't re-center repeatedly.
  const centeredTileIdRef = useRef<string | number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const labelsCanvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(zoom);
  const prevFocusPointRef = useRef<{ x: number; z: number } | undefined>(undefined);
  const panRef = useRef(pan);
  const enhanceAbortRef = useRef<AbortController | null>(null);

  const activeUrl = enhancedUrl ?? imageUrl ?? null;
  const activeTileSet = enhancedTileSet ?? tileSet ?? null;
  const isTileMode = activeTileSet != null;

  // Image natural size: derived from the tileSet in tile mode, otherwise from
  // the loaded `<img>`. Derived (not stored) so we don't trigger an extra
  // render cycle when the tileSet changes.
  const imgNatural = useMemo(() => {
    if (activeTileSet) {
      return { w: activeTileSet.imageWidth, h: activeTileSet.imageHeight };
    }
    return blobImgNatural;
  }, [activeTileSet, blobImgNatural]);

  const projectedOverlaySegments = useMemo(() => {
    if (
      !stats ||
      !overlaySegments ||
      overlaySegments.length === 0 ||
      imgNatural.w <= 0 ||
      imgNatural.h <= 0
    ) {
      return [] as Array<{ x1: number; y1: number; x2: number; y2: number }>;
    }

    const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;

    const projected: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const seg of overlaySegments) {
      const x1 = toImgX(seg.x1);
      const y1 = toImgY(seg.z1);
      const x2 = toImgX(seg.x2);
      const y2 = toImgY(seg.z2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      projected.push({ x1, y1, x2, y2 });
    }

    return projected;
  }, [imgNatural.h, imgNatural.w, overlaySegments, stats]);

  // Indices within `overlaySegments` (and therefore `projectedOverlaySegments`,
  // which is built in the same order with entries skipped only for non-finite
  // coordinates — highlighted segments by definition have finite coords) that
  // should be drawn with the hover/highlight emphasis. Combines the single
  // `highlightedSegment` (back-compat) and the `highlightedSegments` list.
  const highlightedSegmentIndices = useMemo(() => {
    if (!overlaySegments || overlaySegments.length === 0) {
      return new Set<number>();
    }
    const targets = new Set<string>();
    if (highlightedSegment) {
      targets.add(
        `${highlightedSegment.x1},${highlightedSegment.z1},${highlightedSegment.x2},${highlightedSegment.z2}`,
      );
    }
    if (highlightedSegments) {
      for (const s of highlightedSegments) {
        targets.add(`${s.x1},${s.z1},${s.x2},${s.z2}`);
      }
    }
    if (targets.size === 0) return new Set<number>();
    const out = new Set<number>();
    for (let i = 0; i < overlaySegments.length; i++) {
      const s = overlaySegments[i];
      if (targets.has(`${s.x1},${s.z1},${s.x2},${s.z2}`)) {
        out.add(i);
      }
    }
    return out;
  }, [highlightedSegment, highlightedSegments, overlaySegments]);

  const projectedOverlayPoints = useMemo(() => {
    if (
      !stats ||
      !overlayPoints ||
      overlayPoints.length === 0 ||
      imgNatural.w <= 0 ||
      imgNatural.h <= 0
    ) {
      return [] as Array<{ x: number; y: number; label?: string; kind?: string }>;
    }

    const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;

    const projected: Array<{ x: number; y: number; label?: string; kind?: string }> = [];
    for (const pt of overlayPoints) {
      const x = toImgX(pt.x);
      const y = toImgY(pt.z);
      if (![x, y].every(Number.isFinite)) continue;
      projected.push({ x, y, label: pt.label, kind: pt.kind });
    }

    return projected;
  }, [imgNatural.h, imgNatural.w, overlayPoints, stats]);

  // Keep refs in sync with state so non-React callbacks always read current values
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  // Reset viewer state when the base image URL changes (new file / new query)
  useEffect(() => {
    setEnhancedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setBlobImgNatural({ w: 0, h: 0 });
    setRenderedMaxDim(4096);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoverCoords(null);
    setHoveredOverlayIndex(null);
    enhanceAbortRef.current?.abort();
    setEnhancing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Same reset for tile-mode source changes (parent swapped to a different
  // map identity — not just a level upgrade we did internally).
  const adoptedTileIdRef = useRef<string | number | null>(null);
  // Image dims of the previously-adopted tileSet, used to scale-compensate
  // pan/zoom when the parent swaps to a different resolution level of the
  // same world (so the user keeps looking at the same spot).
  const adoptedTileSizeRef = useRef<{ w: number; h: number } | null>(null);
  // Image width of the first tileSet adopted in this session. Used as the
  // "100%" reference for the zoom indicator so the displayed percentage
  // reflects actual on-screen scale and stays consistent across resolution
  // swaps (otherwise L1 @ zoom=1 and L4 @ zoom=1 both read 100% despite
  // being 8× apart visually).
  const [zoomReferenceWidth, setZoomReferenceWidth] = useState<number>(0);
  useEffect(() => {
    if (!tileSet) return;
    // Case 1: parent has caught up with an id we already enhanced to internally.
    // Drop the internal override but keep current pan/zoom.
    if (enhancedTileSet && tileSet.id === enhancedTileSet.id) {
      adoptedTileIdRef.current = tileSet.id;
      adoptedTileSizeRef.current = { w: tileSet.imageWidth, h: tileSet.imageHeight };
      setEnhancedTileSet(null);
      return;
    }
    // Case 2: same id we already adopted — nothing to do (e.g. URL rotation).
    if (adoptedTileIdRef.current === tileSet.id) return;

    const prevSize = adoptedTileSizeRef.current;
    adoptedTileIdRef.current = tileSet.id;
    adoptedTileSizeRef.current = { w: tileSet.imageWidth, h: tileSet.imageHeight };

    setEnhancedTileSet(null);
    // Preserve the previous threshold so a manual *downgrade* doesn't make
    // the auto-enhance effect immediately bounce back up to the higher level
    // (it compares `target <= renderedMaxDim * 1.8`). For upgrades the new
    // value wins as expected.
    setRenderedMaxDim((prev) => Math.max(prev, tileSet.imageWidth || 4096));
    setHoverCoords(null);
    setHoveredOverlayIndex(null);
    enhanceAbortRef.current?.abort();
    setEnhancing(false);

    if (prevSize && prevSize.w > 0 && tileSet.imageWidth > 0) {
      // Resolution swap of the same world: keep the user's zoom value as-is
      // (so picking a higher level actually reveals more detail rather than
      // canceling itself out by zooming out by the same factor), and only
      // recompute pan so the world point under the viewport center stays
      // pinned. Math: world point under center, in old image coords, is
      // imgX_old = (cx - pan_old) / zoom. The same world point in the new
      // image is imgX_new = imgX_old * scale where scale = newW / oldW.
      // Choose pan_new so that imgX_new * zoom + pan_new == cx.
      const scale = tileSet.imageWidth / prevSize.w;
      const el = containerRef.current;
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      const z = zoomRef.current;
      const oldPan = panRef.current;
      const imgXNew = ((cx - oldPan.x) / z) * scale;
      const imgYNew = ((cy - oldPan.y) / z) * scale;
      setPan({ x: cx - imgXNew * z, y: cy - imgYNew * z });
      // Suppress re-centering — we already preserved the user's view.
      centeredTileIdRef.current = tileSet.id;
    } else {
      // Initial adoption (no previous tileSet): full reset and re-center.
      setZoom(1);
      setPan({ x: 0, y: 0 });
      centeredTileIdRef.current = null;
      setZoomReferenceWidth(tileSet.imageWidth || 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileSet?.id]);

  // Auto-enhance: when zoomed in far enough, request a higher-resolution render
  useEffect(() => {
    if (imgNatural.w === 0) return;
    const enhancer = isTileMode ? enhanceTilesFn : enhanceFn;
    if (!enhancer) return;
    if (!isTileMode && !activeUrl) return;

    const el = containerRef.current;
    if (!el) return;
    const viewportW = el.clientWidth;
    const visibleImgPx = viewportW / zoom;
    const neededMaxDim = Math.ceil((imgNatural.w / visibleImgPx) * viewportW);
    // Tile mode supports the full range of pre-rendered levels (down to 2048
    // and up to "every pixel" full-res), so use the raw needed size. Blob
    // mode is bounded by what the on-the-fly renderer is willing to produce.
    const target = isTileMode
      ? Math.max(1, neededMaxDim)
      : Math.min(16384, Math.max(4096, neededMaxDim));
    // Hysteresis thresholds: only swap when we're well above (zoomed in past
    // current resolution's headroom) or well below (zoomed out so far that
    // we're rendering far more pixels than we need). The asymmetric ratios
    // keep us from oscillating around a single threshold while panning.
    const shouldUpgrade = target > renderedMaxDim * 1.8;
    // Downgrade only applies in tile mode — blob mode's enhanceFn doesn't
    // expose a way to fetch a smaller pre-rendered image.
    const shouldDowngrade = isTileMode && target * 3 < renderedMaxDim;
    if (!shouldUpgrade && !shouldDowngrade) return;

    const timer = setTimeout(async () => {
      enhanceAbortRef.current?.abort();
      const abort = new AbortController();
      enhanceAbortRef.current = abort;

      setEnhancing(true);
      try {
        if (isTileMode && enhanceTilesFn) {
          const next = await enhanceTilesFn(target);
          if (abort.signal.aborted) return;
          // Parent had no better candidate — stay on the current level.
          if (activeTileSet && next.id === activeTileSet.id) return;
          // Image is rendered as `translate(pan) scale(zoom)` over a div
          // sized to imageWidth, so a world point at image coord `ix`
          // appears at screen `ix*zoom + pan`. After dims change by `s` the
          // same world point is at `ix*s` in new coords. To keep the visible
          // result identical: ix*s*z' + p' = ix*z + p for all ix
          // ⇒ z' = z/s and p' = p (pan unchanged). This works for both
          // s > 1 (upgrade) and s < 1 (downgrade).
          const scaleW = next.imageWidth / imgNatural.w;
          setZoom((z) => z / scaleW);
          // Track the actual delivered resolution rather than the requested
          // target so the up/down hysteresis comparisons reflect reality
          // (e.g. when no level satisfies `target` and we get the highest
          // available instead).
          setRenderedMaxDim(next.imageWidth);
          // Mark this id as already-centered so the centering effect doesn't
          // re-center after we just scale-compensated the existing view.
          centeredTileIdRef.current = next.id;
          setEnhancedTileSet(next);
          onTileSetEnhanced?.(next);
          return;
        }
        if (!enhanceFn) return;
        const blob = await enhanceFn(target);
        if (abort.signal.aborted) return;

        // Pre-load to get natural dimensions for smooth scale compensation
        const newUrl = URL.createObjectURL(blob);
        const tmpImg = new window.Image();
        tmpImg.src = newUrl;
        await new Promise<void>((res, rej) => {
          tmpImg.onload = () => res();
          tmpImg.onerror = () => rej();
        });
        if (abort.signal.aborted) {
          URL.revokeObjectURL(newUrl);
          return;
        }

        // See comment above for the correct pan/zoom compensation: pan stays
        // put, only zoom is divided by the dimension ratio.
        const scaleW = tmpImg.naturalWidth / imgNatural.w;
        setZoom((z) => z / scaleW);
        setBlobImgNatural({ w: tmpImg.naturalWidth, h: tmpImg.naturalHeight });
        setRenderedMaxDim(target);
        setEnhancedUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return newUrl;
        });
      } catch {
        // silently ignore — user retains the current image
      } finally {
        if (!abort.signal.aborted) setEnhancing(false);
      }
    }, 800);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, imgNatural.w, renderedMaxDim, enhanceFn, enhanceTilesFn, isTileMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      enhanceAbortRef.current?.abort();
    };
  }, []);

  // Track container size so the viewport-culling memo can recompute on resize.
  // Deps include `activeUrl` / `activeTileSet` because the component returns
  // `null` until one of them is available; on the first render after content
  // hydrates from localStorage the container is freshly added to the DOM and
  // we need to (re-)attach the observer at that point.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeUrl, activeTileSet]);

  // Compute which tiles intersect the visible viewport (plus an overscan
  // margin). Keeps the DOM tile count bounded — typical viewport at level 4
  // (16384px) shows only a handful of the 256 chunks at any given zoom.
  const visibleTiles = useMemo(() => {
    if (!activeTileSet || containerSize.w === 0 || containerSize.h === 0) {
      return [] as MapTile[];
    }
    const viewMinX = (-pan.x - TILE_OVERSCAN_PX) / zoom;
    const viewMinY = (-pan.y - TILE_OVERSCAN_PX) / zoom;
    const viewMaxX = (containerSize.w - pan.x + TILE_OVERSCAN_PX) / zoom;
    const viewMaxY = (containerSize.h - pan.y + TILE_OVERSCAN_PX) / zoom;
    const out: MapTile[] = [];
    for (const t of activeTileSet.tiles) {
      if (t.px + t.w < viewMinX || t.py + t.h < viewMinY) continue;
      if (t.px > viewMaxX || t.py > viewMaxY) continue;
      out.push(t);
    }
    return out;
  }, [activeTileSet, containerSize.w, containerSize.h, pan.x, pan.y, zoom]);

  // Fly to focusPoint when it changes (new object reference = new navigation intent).
  useEffect(() => {
    if (!focusPoint || !stats || imgNatural.w === 0) return;
    if (prevFocusPointRef.current === focusPoint) return;
    prevFocusPointRef.current = focusPoint;

    const el = containerRef.current;
    if (!el) return;

    const targetZoom = Math.max(focusZoom, zoomRef.current);
    const imgX = ((focusPoint.x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const imgY = ((focusPoint.z - stats.start_z) / stats.height_blocks) * imgNatural.h;
    const rect = el.getBoundingClientRect();

    setPan({ x: rect.width / 2 - imgX * targetZoom, y: rect.height / 2 - imgY * targetZoom });
    setZoom(targetZoom);
  }, [focusPoint, focusZoom, imgNatural, stats]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Screen-space canvas: sized to the visible viewport, NOT to the map
    // image. This avoids exceeding browser canvas-dimension limits (~16384px
    // in Safari, ~32767px in Chrome/Firefox) at high resolution levels —
    // especially when overlay geometry (e.g. translocators from a previous
    // global map) reaches far outside the current partial map's bounds.
    // We compensate by applying pan/zoom inside the 2D context so draw calls
    // can keep using image-space coordinates as before.
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0 || imgNatural.w <= 0 || imgNatural.h <= 0) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    canvas.width = cw;
    canvas.height = ch;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (projectedOverlaySegments.length === 0 && projectedOverlayPoints.length === 0) return;

    // Apply the viewer's pan/zoom so subsequent draw calls can stay in
    // image-space coordinates. (Strokes scale with zoom; widths/radii below
    // already divide by zoom to compensate.)
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // High-contrast purple palette works better against the map's yellow/brown tones.
    const baseLineColor = "rgba(139, 92, 246, 0.95)";
    const hoverLineColor = "rgba(243, 232, 255, 1)";
    const glowColor = "rgba(76, 29, 149, 0.55)";
    const portalOuter = "rgba(168, 85, 247, 0.95)";
    const portalInner = "rgba(221, 214, 254, 0.98)";

    const baseWidth = Math.max(0.9, 2.3 / Math.max(zoom, 0.1));
    const glowWidth = baseWidth * 2.4;

    if (projectedOverlaySegments.length > 0) {
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = glowWidth;
      ctx.beginPath();
      for (const seg of projectedOverlaySegments) {
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
      ctx.stroke();

      ctx.strokeStyle = baseLineColor;
      ctx.lineWidth = baseWidth;
      ctx.beginPath();
      for (const seg of projectedOverlaySegments) {
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
      ctx.stroke();

      if (hoveredOverlayIndex !== null && projectedOverlaySegments[hoveredOverlayIndex]) {
        const seg = projectedOverlaySegments[hoveredOverlayIndex];
        ctx.strokeStyle = hoverLineColor;
        ctx.lineWidth = Math.max(baseWidth * 1.6, 1.6);
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      }

      // Pinned / externally highlighted segments — same style as hover so they
      // remain visually obvious even when the cursor moves elsewhere. Skip
      // the hovered one to avoid double-stroking.
      if (highlightedSegmentIndices.size > 0) {
        ctx.strokeStyle = hoverLineColor;
        ctx.lineWidth = Math.max(baseWidth * 1.6, 1.6);
        ctx.beginPath();
        for (const idx of highlightedSegmentIndices) {
          if (idx === hoveredOverlayIndex) continue;
          const seg = projectedOverlaySegments[idx];
          if (!seg) continue;
          ctx.moveTo(seg.x1, seg.y1);
          ctx.lineTo(seg.x2, seg.y2);
        }
        ctx.stroke();
      }

      const outerRadius = Math.max(1.8, 2.9 / Math.max(zoom, 0.1));
      const innerRadius = Math.max(0.8, outerRadius * 0.5);
      for (const seg of projectedOverlaySegments) {
        ctx.fillStyle = portalOuter;
        ctx.beginPath();
        ctx.arc(seg.x1, seg.y1, outerRadius, 0, Math.PI * 2);
        ctx.arc(seg.x2, seg.y2, outerRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = portalInner;
        ctx.beginPath();
        ctx.arc(seg.x1, seg.y1, innerRadius, 0, Math.PI * 2);
        ctx.arc(seg.x2, seg.y2, innerRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (projectedOverlayPoints.length > 0) {
      const pointOuter = Math.max(2.1, 3.6 / Math.max(zoom, 0.1));
      const pointInner = Math.max(1, pointOuter * 0.48);

      // Regular (Base etc.) points — cyan dot with white core.
      ctx.fillStyle = "rgba(34, 211, 238, 0.92)";
      for (const pt of projectedOverlayPoints) {
        if (pt.kind === "Server") continue;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointOuter, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
      for (const pt of projectedOverlayPoints) {
        if (pt.kind === "Server") continue;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointInner, 0, Math.PI * 2);
        ctx.fill();
      }

      // Spawn (Server) markers — larger gold five-point star with dark outline.
      const starOuter = Math.max(4.2, 7.2 / Math.max(zoom, 0.1));
      const starInner = starOuter * 0.45;
      const strokeW = Math.max(0.6, 1.1 / Math.max(zoom, 0.1));
      const drawStar = (cx: number, cy: number) => {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? starOuter : starInner;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };

      ctx.lineJoin = "round";
      ctx.lineWidth = strokeW;
      for (const pt of projectedOverlayPoints) {
        if (pt.kind !== "Server") continue;
        drawStar(pt.x, pt.y);
        ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
        ctx.stroke();
      }
    }
  }, [
    containerSize.h,
    containerSize.w,
    highlightedSegmentIndices,
    hoveredOverlayIndex,
    imgNatural.h,
    imgNatural.w,
    pan.x,
    pan.y,
    projectedOverlayPoints,
    projectedOverlaySegments,
    zoom,
  ]);

  // Screen-space labels canvas — drawn at container resolution so text is always crisp.
  useEffect(() => {
    const canvas = labelsCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || projectedOverlayPoints.length === 0) {
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const { clientWidth: w, clientHeight: h } = container;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const FONT_SIZE = 11;
    const PAD_X = 4;
    const PAD_Y = 2;
    const DOT_RADIUS_SCREEN = 4;

    ctx.font = `600 ${FONT_SIZE}px sans-serif`;
    ctx.textBaseline = "top";

    for (const pt of projectedOverlayPoints) {
      const raw = (pt.label ?? "").replace(/\s+/g, " ").trim();
      if (!raw) continue;

      // Convert image-space point to screen space.
      const sx = pt.x * zoom + pan.x;
      const sy = pt.y * zoom + pan.y;

      // Skip points outside the visible viewport.
      if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;

      const isServer = pt.kind === "Server";
      const text = raw.length > 30 ? `${raw.slice(0, 29)}\u2026` : raw;
      const textW = ctx.measureText(text).width;
      const textH = FONT_SIZE;
      const dotRadius = isServer ? DOT_RADIUS_SCREEN + 4 : DOT_RADIUS_SCREEN;
      const tx = sx + dotRadius + 3;
      const ty = sy - dotRadius - PAD_Y - textH;

      ctx.fillStyle = isServer ? "rgba(120, 53, 15, 0.88)" : "rgba(15, 23, 42, 0.80)";
      ctx.fillRect(tx - PAD_X, ty - PAD_Y, textW + PAD_X * 2, textH + PAD_Y * 2);

      ctx.fillStyle = isServer ? "rgba(254, 240, 138, 1)" : "rgba(236, 254, 255, 0.98)";
      ctx.fillText(text, tx, ty);
    }
  }, [pan, projectedOverlayPoints, zoom]);

  // Non-passive wheel listener to prevent page scroll inside the viewer
  const zoomToward = useCallback((focalX: number, focalY: number, newZoom: number) => {
    const oldZoom = zoomRef.current;
    const oldPan = panRef.current;
    const clamped = Math.min(Math.max(newZoom, 0.1), 20);
    const scale = clamped / oldZoom;
    setPan({
      x: focalX - (focalX - oldPan.x) * scale,
      y: focalY - (focalY - oldPan.y) * scale,
    });
    setZoom(clamped);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      zoomToward(e.clientX - rect.left, e.clientY - rect.top, zoomRef.current * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `activeTileSet` is included so the listener is (re)attached the moment
    // the container appears in the DOM after tileSet hydrates from cache.
    // Without it the wheel handler is never bound on the initial render and
    // the browser scrolls the page instead of zooming the map.
  }, [activeUrl, activeTileSet, zoomToward]);

  const centerView = useCallback(
    (width: number, height: number, currentZoom?: number) => {
      const el = containerRef.current;
      if (!el || width === 0 || height === 0) return;

      const z = currentZoom ?? zoomRef.current;
      const rect = el.getBoundingClientRect();

      if (stats) {
        const imgX = ((0 - stats.start_x) / stats.width_blocks) * width;
        const imgY = ((0 - stats.start_z) / stats.height_blocks) * height;
        setPan({ x: rect.width / 2 - imgX * z, y: rect.height / 2 - imgY * z });
        return;
      }

      setPan({ x: (rect.width - width * z) / 2, y: (rect.height - height * z) / 2 });
    },
    [stats],
  );

  const centerOnOrigin = useCallback(
    (currentZoom?: number) => {
      if (!stats || imgNatural.w === 0) return;
      centerView(imgNatural.w, imgNatural.h, currentZoom);
    },
    [centerView, stats, imgNatural],
  );

  // Tile-mode initial centering — runs once per tileSet id, after the
  // container has measured itself AND stats have loaded. Mirrors the
  // `<img onLoad>` -> centerView call that the blob path uses.
  // We deliberately wait for `stats` so the first centering call uses the
  // origin-aware branch of `centerView`; otherwise the map snaps to a
  // corner-anchored position and the ref then prevents any re-centering.
  useEffect(() => {
    if (!activeTileSet || containerSize.w === 0 || !stats) return;
    if (centeredTileIdRef.current === activeTileSet.id) return;
    centeredTileIdRef.current = activeTileSet.id;
    centerView(activeTileSet.imageWidth, activeTileSet.imageHeight, zoomRef.current);
  }, [activeTileSet, containerSize.w, centerView, stats]);

  const zoomIn = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomToward(rect.width / 2, rect.height / 2, zoomRef.current * BUTTON_ZOOM_FACTOR);
  }, [zoomToward]);

  const zoomOut = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomToward(rect.width / 2, rect.height / 2, zoomRef.current / BUTTON_ZOOM_FACTOR);
  }, [zoomToward]);

  const resetView = useCallback(() => {
    setZoom(1);
    centerView(imgNatural.w, imgNatural.h, 1);
  }, [centerView, imgNatural]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
      }
      if (containerRef.current && stats && imgNatural.w > 0) {
        const rect = containerRef.current.getBoundingClientRect();
        const imgX = (e.clientX - rect.left - panRef.current.x) / zoomRef.current;
        const imgY = (e.clientY - rect.top - panRef.current.y) / zoomRef.current;
        if (imgX >= 0 && imgX < imgNatural.w && imgY >= 0 && imgY < imgNatural.h) {
          const blockX = Math.floor((imgX / imgNatural.w) * stats.width_blocks + stats.start_x);
          const blockZ = Math.floor((imgY / imgNatural.h) * stats.height_blocks + stats.start_z);
          setHoverCoords({ x: blockX, z: blockZ });

          if (projectedOverlaySegments.length > 0) {
            const threshold = 8 / Math.max(zoomRef.current, 0.1);
            const thresholdSq = threshold * threshold;

            let hitIndex: number | null = null;
            let bestDistSq = Infinity;

            for (let i = 0; i < projectedOverlaySegments.length; i++) {
              const seg = projectedOverlaySegments[i];
              const abx = seg.x2 - seg.x1;
              const aby = seg.y2 - seg.y1;
              const apx = imgX - seg.x1;
              const apy = imgY - seg.y1;
              const abLenSq = abx * abx + aby * aby;
              const t =
                abLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq)) : 0;
              const cx = seg.x1 + t * abx;
              const cy = seg.y1 + t * aby;
              const dx = imgX - cx;
              const dy = imgY - cy;
              const distSq = dx * dx + dy * dy;

              if (distSq < thresholdSq && distSq < bestDistSq) {
                bestDistSq = distSq;
                hitIndex = i;
              }
            }

            setHoveredOverlayIndex(hitIndex);
          } else {
            setHoveredOverlayIndex(null);
          }
        } else {
          setHoverCoords(null);
          setHoveredOverlayIndex(null);
        }
      }
    },
    [dragging, dragStart, stats, imgNatural, projectedOverlaySegments],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);
  const handleMouseLeave = useCallback(() => {
    setDragging(false);
    setHoverCoords(null);
    setHoveredOverlayIndex(null);
  }, []);

  const handleOverlayClick = useCallback(() => {
    if (!onOverlaySegmentClick || !overlaySegments || overlaySegments.length === 0) return;
    if (hoveredOverlayIndex === null) {
      onOverlaySegmentClick(null);
      return;
    }
    onOverlaySegmentClick(overlaySegments[hoveredOverlayIndex] ?? null);
  }, [hoveredOverlayIndex, onOverlaySegmentClick, overlaySegments]);

  // Right-click handler: fires onOverlaySegmentRightClick when a segment is
  // hovered (used by the parent to "pin" a translocator selection). Always
  // suppresses the native context menu while hovering a segment so the gesture
  // is dedicated to pinning rather than the browser menu.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onOverlaySegmentRightClick || !overlaySegments || overlaySegments.length === 0) return;
      if (hoveredOverlayIndex === null) return;
      const seg = overlaySegments[hoveredOverlayIndex];
      if (!seg) return;
      e.preventDefault();
      onOverlaySegmentRightClick(seg);
    },
    [hoveredOverlayIndex, onOverlaySegmentRightClick, overlaySegments],
  );

  if (!activeUrl && !activeTileSet) return null;

  const canvasClass = ["relative overflow-hidden bg-black/90", bordered ? "rounded-md border" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2">
      {legend && (
        <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground border-b bg-muted/30">
          {legend}
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {toolbarStart}
        <Button type="button" variant="outline" size="sm" onClick={zoomOut} title="Zoom out">
          <ZoomOut className="size-4" />
        </Button>
        {/* <span className="text-xs text-muted-foreground w-14 text-center">
          {Math.round(
            (zoomReferenceWidth > 0 && imgNatural.w > 0
              ? (zoom * imgNatural.w) / zoomReferenceWidth
              : zoom) * 100,
          )}%
        </span> */}
        <Button type="button" variant="outline" size="sm" onClick={zoomIn} title="Zoom in">
          <ZoomIn className="size-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetView} title="Reset view">
          <RotateCcw className="size-4" />
        </Button>
        {stats && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => centerOnOrigin()}
            title="Center on 0, 0"
          >
            <Crosshair className="size-4" />
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-2">Scroll to zoom · Drag to pan</span>
        {enhancing && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
            <Loader2 className="size-3 animate-spin" />
            Enhancing…
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className={canvasClass}
        style={{
          height,
          cursor: dragging ? "grabbing" : hoveredOverlayIndex !== null ? "pointer" : "grab",
          touchAction: "none",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleOverlayClick}
        onContextMenu={handleContextMenu}
      >
        {isTileMode && activeTileSet ? (
          <div
            className="absolute select-none"
            style={{
              transformOrigin: "0 0",
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              width: activeTileSet.imageWidth,
              height: activeTileSet.imageHeight,
              imageRendering: zoom > 2 ? "pixelated" : "auto",
              willChange: "transform",
            }}
          >
            {visibleTiles.map((t) => (
              <img
                key={`${activeTileSet.id}:${t.cx}-${t.cy}`}
                src={t.url}
                alt=""
                draggable={false}
                // NB: do NOT set loading="lazy" here. The browser's lazy-load
                // heuristic ignores ancestor CSS transforms, so tiles whose
                // untransformed absolute position falls outside the viewport
                // (anything beyond the container width on level 4 = most of
                // them) never get requested. We already cull off-screen tiles
                // ourselves via `visibleTiles`, so every <img> rendered here
                // is genuinely on-screen and should fetch eagerly.
                decoding="async"
                style={{
                  position: "absolute",
                  left: t.px,
                  top: t.py,
                  width: t.w,
                  height: t.h,
                  pointerEvents: "none",
                  // Match the parent's image-rendering so per-tile scaling stays consistent.
                  imageRendering: "inherit",
                }}
              />
            ))}
          </div>
        ) : (
          <img
            ref={imgRef}
            src={activeUrl ?? undefined}
            alt={alt}
            draggable={false}
            className="absolute select-none"
            onError={onImageError}
            onLoad={() => {
              if (!imgRef.current || !containerRef.current) return;
              const w = imgRef.current.naturalWidth;
              const h = imgRef.current.naturalHeight;
              setBlobImgNatural({ w, h });
              centerView(w, h, zoomRef.current);
            }}
            style={{
              transformOrigin: "0 0",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              imageRendering: zoom > 2 ? "pixelated" : "auto",
              maxWidth: "none",
            }}
          />
        )}
        {stats &&
          ((overlaySegments && overlaySegments.length > 0) ||
            (overlayPoints && overlayPoints.length > 0)) && (
            <canvas ref={overlayCanvasRef} className="absolute inset-0 pointer-events-none" />
          )}
        {overlayPoints && overlayPoints.length > 0 && (
          <canvas ref={labelsCanvasRef} className="absolute inset-0 pointer-events-none" />
        )}
        {hoverCoords && (
          <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2.5 py-1 text-xs font-mono text-white pointer-events-none">
            X: {hoverCoords.x} &nbsp; Z: {hoverCoords.z}
          </div>
        )}
      </div>
    </div>
  );
}
