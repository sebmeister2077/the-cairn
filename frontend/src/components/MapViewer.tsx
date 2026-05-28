import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw, Crosshair, Loader2, Maximize2 } from "lucide-react";
import { TLLegendButton } from "@/components/TLLegendButton";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import { setShowFullscreen as setShowFullscreenAction } from "@/store/slices/mapView";
import { drawTraderMarker, drawTLEndpoint, drawTerminusMarker } from "@/lib/markerStyles";
import { useTranslation } from "@/lib/i18n";

// Marker icon styles are user-selectable from the Account → Appearance panel
// and live on the `mapView` redux slice (persisted via the root envelope).
// Defaults are gear-stack / spiral / tombstone — see `DEFAULT_*_STYLE`.

const WHEEL_ZOOM_FACTOR = 1.3;
const BUTTON_ZOOM_FACTOR = 1.75;
// Render this many extra tile widths around the viewport so panning never
// reveals empty edges before the next render lands.
const TILE_OVERSCAN_PX = 256;

export type MapStats = {
  pieces: number;
  size_mb: number;
  width_chunks: number;
  height_chunks: number;
  width_blocks: number;
  height_blocks: number;
  start_x: number;
  start_z: number;
};

export interface WorldLineSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Visual / data classification for the segment.
   *  - "default" (or undefined): seeded translocator (purple).
   *  - "user": user-contributed translocator (blue) — carries `meta`.
   */
  kind?: "default" | "user";
  meta?: {
    segmentId?: string;
    addedBy?: string;
    addedAt?: string;
  };
}

/** Route-preview overlay shown by features like the route planner. */
export interface RouteOverlay {
  /** TL segments to recolour as "part of the route". */
  tlSegments: WorldLineSegment[];
  /** Walk legs as world-space `[from, to]` pairs, drawn dashed. */
  walkLegs: Array<{ from: { x: number; z: number }; to: { x: number; z: number } }>;
  /** Origin pin (green). */
  from?: { x: number; z: number } | null;
  /** Destination pin (red). */
  to?: { x: number; z: number } | null;
}

export interface WorldPointMarker {
  x: number;
  z: number;
  label?: string;
  /** Visual classification. `"Trader"` markers are drawn as colored dots
   *  using `color` (defaulting to cyan if absent); `"Home"` is drawn as a
   *  house glyph (used for the user's saved favorite position); `"Terminus"`
   *  is drawn using the currently selected Terminus icon style; other kinds
   *  use the built-in landmark palette (cyan dot for Base/Misc, gold star
   *  for Server). */
  kind?: "Base" | "Server" | "Misc" | "Trader" | "Home" | "Terminus";
  /** Optional fill color for `"Trader"` markers. Hex string (e.g. "#16a34a"). */
  color?: string;
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
  chunks: MapTile[];
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
   * culling so only the chunks intersecting the visible area are in the DOM.
   * Avoids the giant `canvas.toBlob` round-trip needed for the single-image
   * path.
   */
  tileSet?: MapTileSet | null;
  /** Map stats used for coordinate overlay and "center on origin" button. */
  stats?: MapStats | null;
  alt?: string;
  /** CSS height of the canvas, e.g. "70vh" or "400px". */
  height?: string;
  /** When true, render a "fullscreen" button in the toolbar that calls `onRequestFullscreen`. */
  showFullscreenControl?: boolean;
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
  /** Notified after an enhance-chunks swap completes (e.g. so the parent can persist the new level). */
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
  /**
   * Optional world-space diameter (in blocks) the viewer should try to
   * fit around `focusPoint` when flying to it. When provided, overrides
   * `focusZoom` and the "never zoom out below current" clamp — the
   * viewer picks a zoom that keeps a region of this diameter in view,
   * which is what e.g. the route planner uses to ensure both endpoints
   * of a long TL pair stay on screen instead of fully zooming into the
   * midpoint.
   */
  focusSpanBlocks?: number;
  /**
   * Reported (debounced) whenever the user pans or zooms. `centerWorldX` /
   * `centerWorldZ` are the world-block coordinates currently under the
   * viewport center; `pixelsPerBlock` is the on-screen scale (independent of
   * which resolution level is active, so it survives resolution swaps).
   * `worldMinX`/`worldMaxX`/`worldMinZ`/`worldMaxZ` describe the world-block
   * rectangle currently visible in the viewport (useful for overlay layers
   * that need to fetch viewport-bound data).
   * Requires `stats` to be set.
   */
  onViewportChange?: (info: {
    centerWorldX: number;
    centerWorldZ: number;
    pixelsPerBlock: number;
    worldMinX: number;
    worldMaxX: number;
    worldMinZ: number;
    worldMaxZ: number;
  }) => void;
  /**
   * Optional JSX rendered inside the same transformed container as the base
   * tile imgs. Coordinates within `overlay` are interpreted in image-space
   * pixels (top-left = 0,0; full extent = imgNatural.{w,h}); the viewer's
   * pan/zoom transform applies automatically. Pointer events are enabled by
   * default so individual children can attach click handlers.
   */
  overlay?: React.ReactNode;
  /**
   * Render-prop variant of {@link overlay}. Receives the current internal
   * zoom along with the image-natural dimensions so consumers can size
   * their handles inversely to zoom (so they remain a constant on-screen
   * size). Coordinates returned in JSX are interpreted in image-space
   * pixels, exactly like {@link overlay}.
   */
  overlayRender?: (info: {
    zoom: number;
    imgNatural: { w: number; h: number };
    stats: MapStats | null;
  }) => React.ReactNode;
  /**
   * When true, panning (mouse drag) and wheel zooming are disabled. The
   * map still renders normally and the overlay still receives pointer
   * events — used by features that need an unambiguous overlay drag
   * gesture (e.g. moving a TL endpoint). The toolbar zoom buttons remain
   * functional.
   */
  interactionsLocked?: boolean;
  /**
   * Pointer behaviour mode.
   *   - `"default"` (or undefined): drag-to-pan / click-to-select-segment.
   *   - `"pick"`: a single click anywhere reports the world coord via
   *     `onWorldClick` and DOES NOT pan/select. Used by the route planner
   *     to capture a From/To endpoint.
   */
  cursorMode?: "default" | "pick";
  /** Fires on a single click when `cursorMode === "pick"`. */
  onWorldClick?: (x: number, z: number) => void;
  /**
   * Optional route overlay drawn on top of all other overlay layers.
   * `tlSegments` are recoloured emerald to indicate "used by the active
   * route"; `walkLegs` become dashed polylines between hops; `from` / `to`
   * render as pinned markers (green = origin, red = destination). All
   * coordinates are in world-space (the same +Z=north convention used by
   * the rest of the viewer).
   */
  routeOverlay?: RouteOverlay | null;
  /**
   * When true, render a small "color palette" button in the toolbar that
   * opens a popover explaining what each translocator overlay color means.
   * Off by default — enable on pages that show the TL overlay.
   */
  showTLLegend?: boolean;
  /**
   * When true (and {@link showTLLegend} is true), the legend popover also
   * documents the light-blue "your new TLs" color used on the Contribute
   * TLs page. Has no effect on its own.
   */
  tlLegendShowContributeColors?: boolean;
  /**
   * When true, the canvas renders an animated CSS starfield behind the
   * tiles instead of the default flat dark background. Empty/uncovered
   * tile area shows the cosmos through the transparent PNGs.
   */
  starfield?: boolean;
  /**
   * Optional view to restore once `stats` and the first tile/image have
   * loaded. Applied at most once per mount; subsequent updates are ignored
   * (so this is meant to be sourced from the URL on initial page load).
   */
  initialView?: {
    centerWorldX: number;
    centerWorldZ: number;
    pixelsPerBlock: number;
  };
  /**
   * Optional world-block point used by the toolbar "center" button. When
   * omitted, the button centers on the world origin (0, 0). When provided,
   * the button recenters on this point instead — useful for previews that
   * focus on a region not anchored at the spawn origin.
   */
  centerTarget?: { x: number; z: number } | null;
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
  focusSpanBlocks,
  onViewportChange,
  initialView,
  centerTarget = null,
  overlay,
  overlayRender,
  interactionsLocked = false,
  showTLLegend = false,
  tlLegendShowContributeColors = false,
  showFullscreenControl = false,
  starfield = false,
  cursorMode = "default",
  onWorldClick,
  routeOverlay = null,
}: MapViewerProps) {
  const { t } = useTranslation();
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
  const interactionsLockedRef = useRef(interactionsLocked);
  const cursorModeRef = useRef(cursorMode);
  // Tracks an in-flight focusPoint fly animation so user input (drag/wheel)
  // can cancel it cleanly without racing the rAF callback.
  const flyAnimRef = useRef<number | null>(null);
  const cancelFlyAnim = useCallback(() => {
    if (flyAnimRef.current != null) {
      cancelAnimationFrame(flyAnimRef.current);
      flyAnimRef.current = null;
    }
  }, []);

  /**
   * Smoothly interpolate (pan, zoom) toward a target using an eased rAF
   * loop. Reused by the focusPoint effect, the Reset and Center buttons,
   * etc. Skips animation when the delta is negligible or the OS prefers
   * reduced motion; in those cases it snaps and resolves immediately.
   *
   * Returns a function that cancels the animation early (in addition to
   * `cancelFlyAnim`, which the user-input handlers already call).
   */
  const animatePanZoomTo = useCallback(
    (targetPan: { x: number; y: number }, targetZoom: number) => {
      cancelFlyAnim();

      const startPan = { ...panRef.current };
      const startZoom = zoomRef.current;
      const dx = targetPan.x - startPan.x;
      const dy = targetPan.y - startPan.y;
      const dz = targetZoom - startZoom;

      const prefersReducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const negligible = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.001;
      if (prefersReducedMotion || negligible) {
        setPan(targetPan);
        setZoom(targetZoom);
        return;
      }

      const screenDist = Math.hypot(dx, dy);
      const duration = Math.min(550, Math.max(220, screenDist * 0.6));
      const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const startTs = performance.now();
      const step = (now: number) => {
        const elapsed = now - startTs;
        const t = Math.min(1, elapsed / duration);
        const k = easeInOutCubic(t);
        setPan({ x: startPan.x + dx * k, y: startPan.y + dy * k });
        setZoom(startZoom + dz * k);
        if (t < 1) {
          flyAnimRef.current = requestAnimationFrame(step);
        } else {
          flyAnimRef.current = null;
        }
      };
      flyAnimRef.current = requestAnimationFrame(step);
    },
    [cancelFlyAnim],
  );

  const dispatch = useAppDispatch();
  const isFullscreen = useReduxState("mapView.isFullscreen");
  const traderStyle = useReduxState("mapView.traderStyle");
  const tlStyle = useReduxState("mapView.tlStyle");
  const terminusStyle = useReduxState("mapView.terminusStyle");
  const setIsFullscreen = useCallback(
    (next: boolean) => dispatch(setShowFullscreenAction(next)),
    [dispatch],
  );

  useEffect(() => {
    interactionsLockedRef.current = interactionsLocked;
  }, [interactionsLocked]);
  useEffect(() => {
    cursorModeRef.current = cursorMode;
  }, [cursorMode]);
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
      return [] as Array<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        kind?: "default" | "user";
      }>;
    }

    const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;

    const projected: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      kind?: "default" | "user";
    }> = [];
    for (const seg of overlaySegments) {
      const x1 = toImgX(seg.x1);
      const y1 = toImgY(seg.z1);
      const x2 = toImgX(seg.x2);
      const y2 = toImgY(seg.z2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      projected.push({ x1, y1, x2, y2, kind: seg.kind });
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

  // Project the route overlay (used TLs, walk legs, pins) into image-space
  // pixels using the same map-stats math as the segments / points layers.
  // Computed here (not inside the canvas effect) so it can be memoised and
  // shared if we ever add a non-canvas renderer.
  const projectedRouteOverlay = useMemo(() => {
    if (!stats || !routeOverlay || imgNatural.w <= 0 || imgNatural.h <= 0) {
      return null;
    }
    const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;
    const tlSegs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const s of routeOverlay.tlSegments) {
      const x1 = toImgX(s.x1);
      const y1 = toImgY(s.z1);
      const x2 = toImgX(s.x2);
      const y2 = toImgY(s.z2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      tlSegs.push({ x1, y1, x2, y2 });
    }
    const walkLegs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const leg of routeOverlay.walkLegs) {
      const x1 = toImgX(leg.from.x);
      const y1 = toImgY(leg.from.z);
      const x2 = toImgX(leg.to.x);
      const y2 = toImgY(leg.to.z);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      walkLegs.push({ x1, y1, x2, y2 });
    }
    const projectPin = (p: { x: number; z: number } | null | undefined) => {
      if (!p) return null;
      const x = toImgX(p.x);
      const y = toImgY(p.z);
      if (![x, y].every(Number.isFinite)) return null;
      return { x, y };
    };
    // Identifier set used by the canvas pass to suppress the default
    // purple/blue stroke on route TLs (we redraw them in emerald instead).
    const tlIdSet = new Set<string>();
    for (const s of routeOverlay.tlSegments) {
      tlIdSet.add(`${s.x1},${s.z1},${s.x2},${s.z2}`);
      tlIdSet.add(`${s.x2},${s.z2},${s.x1},${s.z1}`);
    }
    return {
      tlSegs,
      walkLegs,
      from: projectPin(routeOverlay.from),
      to: projectPin(routeOverlay.to),
      tlIdSet,
    };
  }, [imgNatural.h, imgNatural.w, routeOverlay, stats]);

  // Set of segment indices to skip in the default-colour pass because the
  // route overlay will redraw them in emerald — keeps the route highlight
  // visually unambiguous instead of layering colours.
  const routeTLBaseSkipIndices = useMemo(() => {
    if (!overlaySegments || !projectedRouteOverlay) return new Set<number>();
    const out = new Set<number>();
    for (let i = 0; i < overlaySegments.length; i++) {
      const s = overlaySegments[i];
      if (projectedRouteOverlay.tlIdSet.has(`${s.x1},${s.z1},${s.x2},${s.z2}`)) {
        out.add(i);
      }
    }
    return out;
  }, [overlaySegments, projectedRouteOverlay]);

  const projectedOverlayPoints = useMemo(() => {
    if (
      !stats ||
      !overlayPoints ||
      overlayPoints.length === 0 ||
      imgNatural.w <= 0 ||
      imgNatural.h <= 0
    ) {
      return [] as Array<{ x: number; y: number; label?: string; kind?: string; color?: string }>;
    }

    const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;

    const projected: Array<{
      x: number;
      y: number;
      label?: string;
      kind?: string;
      color?: string;
    }> = [];
    for (const pt of overlayPoints) {
      const x = toImgX(pt.x);
      const y = toImgY(pt.z);
      if (![x, y].every(Number.isFinite)) continue;
      projected.push({ x, y, label: pt.label, kind: pt.kind, color: pt.color });
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

  // Compute which chunks intersect the visible viewport (plus an overscan
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
    for (const t of activeTileSet.chunks) {
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

    const rect = el.getBoundingClientRect();

    // When the caller supplies a desired span (route planner does this so
    // long TL pairs don't blow past the viewport), fit-to-span: pick the
    // zoom that lets the requested diameter occupy ~85% of the smaller
    // viewport dimension, clamped to the viewer's overall zoom range.
    // This branch deliberately bypasses the `Math.max(focusZoom, current)`
    // logic below so the camera CAN zoom out when needed.
    let targetZoom: number;
    if (focusSpanBlocks && focusSpanBlocks > 0 && rect.width > 0 && rect.height > 0) {
      const blocksPerImgPx = stats.width_blocks / imgNatural.w;
      const minViewportPx = Math.min(rect.width, rect.height);
      const spanImgPx = focusSpanBlocks / blocksPerImgPx;
      const fitZoom = (minViewportPx * 0.85) / Math.max(1, spanImgPx);
      targetZoom = Math.min(20, Math.max(0.1, fitZoom));
    } else {
      targetZoom = Math.max(focusZoom, zoomRef.current);
    }

    const imgX = ((focusPoint.x - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const imgY = ((focusPoint.z - stats.start_z) / stats.height_blocks) * imgNatural.h;

    animatePanZoomTo(
      {
        x: rect.width / 2 - imgX * targetZoom,
        y: rect.height / 2 - imgY * targetZoom,
      },
      targetZoom,
    );
  }, [focusPoint, focusZoom, focusSpanBlocks, imgNatural, stats, animatePanZoomTo]);

  // Cleanup any leftover animation frame on unmount.
  useEffect(() => () => cancelFlyAnim(), [cancelFlyAnim]);

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

    if (
      projectedOverlaySegments.length === 0 &&
      projectedOverlayPoints.length === 0 &&
      !projectedRouteOverlay
    )
      return;

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
    // User-contributed translocators are drawn in blue so they're visually
    // distinct from the seeded purple ones. Hover style stays unified.
    const userLineColor = "rgba(37, 99, 235, 0.95)";
    const userGlowColor = "rgba(30, 58, 138, 0.55)";
    const userPortalOuter = "rgba(59, 130, 246, 0.95)";

    const baseWidth = Math.max(0.9, 2.3 / Math.max(zoom, 0.1));
    const glowWidth = baseWidth * 2.4;

    if (projectedOverlaySegments.length > 0) {
      // Split into default vs user-contributed so each kind gets its own
      // colour pass. The single-batch draw is preserved per-kind to keep
      // stroke calls minimal. Indices flagged by `routeTLBaseSkipIndices`
      // are skipped here because the route overlay redraws them in emerald
      // below — layering both colours would obscure the route highlight.
      const defaultSegs: typeof projectedOverlaySegments = [];
      const userSegs: typeof projectedOverlaySegments = [];
      for (let i = 0; i < projectedOverlaySegments.length; i++) {
        if (routeTLBaseSkipIndices.has(i)) continue;
        const seg = projectedOverlaySegments[i];
        if (seg.kind === "user") userSegs.push(seg);
        else defaultSegs.push(seg);
      }

      const drawLinePass = (segs: typeof projectedOverlaySegments, line: string, glow: string) => {
        if (segs.length === 0) return;
        ctx.strokeStyle = glow;
        ctx.lineWidth = glowWidth;
        ctx.beginPath();
        for (const seg of segs) {
          ctx.moveTo(seg.x1, seg.y1);
          ctx.lineTo(seg.x2, seg.y2);
        }
        ctx.stroke();

        ctx.strokeStyle = line;
        ctx.lineWidth = baseWidth;
        ctx.beginPath();
        for (const seg of segs) {
          ctx.moveTo(seg.x1, seg.y1);
          ctx.lineTo(seg.x2, seg.y2);
        }
        ctx.stroke();
      };

      drawLinePass(defaultSegs, baseLineColor, glowColor);
      drawLinePass(userSegs, userLineColor, userGlowColor);

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
      const drawPortalDots = (segs: typeof projectedOverlaySegments, outer: string) => {
        for (const seg of segs) {
          drawTLEndpoint(ctx, seg.x1, seg.y1, zoom, tlStyle, outer);
          drawTLEndpoint(ctx, seg.x2, seg.y2, zoom, tlStyle, outer);
        }
      };
      // Silence unused-var warnings while keeping the values around for the
      // legacy `portal` style (which reads sizes directly inside the helper).
      void outerRadius;
      void innerRadius;
      drawPortalDots(defaultSegs, portalOuter);
      drawPortalDots(userSegs, userPortalOuter);
    }

    if (projectedOverlayPoints.length > 0) {
      const pointOuter = Math.max(2.1, 3.6 / Math.max(zoom, 0.1));
      const pointInner = Math.max(1, pointOuter * 0.48);

      // Regular (Base etc.) points — cyan dot with white core.
      ctx.fillStyle = "rgba(34, 211, 238, 0.92)";
      for (const pt of projectedOverlayPoints) {
        if (
          pt.kind === "Server" ||
          pt.kind === "Trader" ||
          pt.kind === "Home" ||
          pt.kind === "Terminus"
        )
          continue;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointOuter, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
      for (const pt of projectedOverlayPoints) {
        if (
          pt.kind === "Server" ||
          pt.kind === "Trader" ||
          pt.kind === "Home" ||
          pt.kind === "Terminus"
        )
          continue;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointInner, 0, Math.PI * 2);
        ctx.fill();
      }

      // Trader markers — gear-stack icon (rusty gears = VS in-game currency).
      for (const pt of projectedOverlayPoints) {
        if (pt.kind !== "Trader") continue;
        const color = pt.color ?? "rgba(34, 211, 238, 0.92)";
        drawTraderMarker(ctx, pt.x, pt.y, zoom, traderStyle, color);
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

      // Home (favorite location) markers — small house glyph in warm amber
      // with a dark outline so it stays legible over any biome tile. Drawn
      // last so it sits on top of every other point kind.
      const homeSize = Math.max(2.2, 3.6 / Math.max(zoom, 0.1));
      const homeStroke = Math.max(0.3, 0.55 / Math.max(zoom, 0.1));
      const drawHouse = (cx: number, cy: number) => {
        const half = homeSize;
        const bodyTopY = cy - half * 0.15;
        const bodyBottomY = cy + half;
        const leftX = cx - half;
        const rightX = cx + half;
        const roofPeakY = cy - half;
        // Outline path: roof triangle + body rectangle as one closed shape.
        ctx.beginPath();
        ctx.moveTo(leftX, bodyBottomY);
        ctx.lineTo(leftX, bodyTopY);
        ctx.lineTo(cx, roofPeakY);
        ctx.lineTo(rightX, bodyTopY);
        ctx.lineTo(rightX, bodyBottomY);
        ctx.closePath();
      };
      ctx.lineJoin = "round";
      ctx.lineWidth = homeStroke;
      for (const pt of projectedOverlayPoints) {
        if (pt.kind !== "Home") continue;
        drawHouse(pt.x, pt.y);
        ctx.fillStyle = pt.color ?? "rgba(245, 158, 11, 0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
        ctx.stroke();
        // Door: small dark rectangle in the lower-center for legibility.
        const doorW = homeSize * 0.32;
        const doorH = homeSize * 0.55;
        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        ctx.fillRect(pt.x - doorW / 2, pt.y + homeSize - doorH, doorW, doorH);
      }

      // Terminus markers — special one-way teleporter (death-return). Drawn
      // as a tombstone silhouette.
      for (const pt of projectedOverlayPoints) {
        if (pt.kind !== "Terminus") continue;
        drawTerminusMarker(ctx, pt.x, pt.y, zoom, terminusStyle);
      }
    }

    // ----- Route overlay (drawn last so it sits on top of every other layer).
    if (projectedRouteOverlay) {
      // 1. Walk legs: dashed slate-200 line with a thin dark outline so they
      //    stay legible against any biome tile. We draw the outline first
      //    (slightly wider, solid black) then the dashed bright line on top.
      if (projectedRouteOverlay.walkLegs.length > 0) {
        const dashUnit = Math.max(4, 8 / Math.max(zoom, 0.1));
        const walkLineWidth = Math.max(0.9, 2.0 / Math.max(zoom, 0.1));
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(15, 23, 42, 0.7)";
        ctx.lineWidth = walkLineWidth * 2.2;
        ctx.beginPath();
        for (const leg of projectedRouteOverlay.walkLegs) {
          ctx.moveTo(leg.x1, leg.y1);
          ctx.lineTo(leg.x2, leg.y2);
        }
        ctx.stroke();

        ctx.setLineDash([dashUnit, dashUnit * 0.75]);
        ctx.strokeStyle = "rgba(226, 232, 240, 0.98)";
        ctx.lineWidth = walkLineWidth;
        ctx.beginPath();
        for (const leg of projectedRouteOverlay.walkLegs) {
          ctx.moveTo(leg.x1, leg.y1);
          ctx.lineTo(leg.x2, leg.y2);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 2. Route TL segments: emerald with subtle glow + bright portal dots.
      if (projectedRouteOverlay.tlSegs.length > 0) {
        const routeBase = Math.max(1.1, 2.8 / Math.max(zoom, 0.1));
        const routeGlow = routeBase * 2.4;
        ctx.strokeStyle = "rgba(6, 78, 59, 0.6)";
        ctx.lineWidth = routeGlow;
        ctx.beginPath();
        for (const seg of projectedRouteOverlay.tlSegs) {
          ctx.moveTo(seg.x1, seg.y1);
          ctx.lineTo(seg.x2, seg.y2);
        }
        ctx.stroke();

        ctx.strokeStyle = "rgba(16, 185, 129, 0.98)";
        ctx.lineWidth = routeBase;
        ctx.beginPath();
        for (const seg of projectedRouteOverlay.tlSegs) {
          ctx.moveTo(seg.x1, seg.y1);
          ctx.lineTo(seg.x2, seg.y2);
        }
        ctx.stroke();

        const dotOuter = Math.max(2.0, 3.4 / Math.max(zoom, 0.1));
        const dotInner = Math.max(0.9, dotOuter * 0.5);
        ctx.fillStyle = "rgba(16, 185, 129, 0.98)";
        for (const seg of projectedRouteOverlay.tlSegs) {
          ctx.beginPath();
          ctx.arc(seg.x1, seg.y1, dotOuter, 0, Math.PI * 2);
          ctx.arc(seg.x2, seg.y2, dotOuter, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "rgba(236, 253, 245, 0.98)";
        for (const seg of projectedRouteOverlay.tlSegs) {
          ctx.beginPath();
          ctx.arc(seg.x1, seg.y1, dotInner, 0, Math.PI * 2);
          ctx.arc(seg.x2, seg.y2, dotInner, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 3. From / To pins. Inverted teardrop with letter ("A" / "B"). Sized
      //    in screen pixels by dividing by zoom so they read the same at
      //    every zoom level.
      const pinRadius = Math.max(4.5, 7.5 / Math.max(zoom, 0.1));
      const pinStroke = Math.max(0.5, 1.0 / Math.max(zoom, 0.1));
      const drawPin = (cx: number, cy: number, fill: string, label: string) => {
        ctx.beginPath();
        ctx.arc(cx, cy - pinRadius, pinRadius, Math.PI * 0.2, Math.PI * 0.8, true);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
        ctx.lineWidth = pinStroke;
        ctx.stroke();
        // Inner letter.
        ctx.fillStyle = "rgba(248, 250, 252, 0.98)";
        const fontSize = Math.max(3.5, pinRadius * 1.1);
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cy - pinRadius);
      };
      if (projectedRouteOverlay.from) {
        drawPin(
          projectedRouteOverlay.from.x,
          projectedRouteOverlay.from.y,
          "rgba(34, 197, 94, 0.98)",
          "A",
        );
      }
      if (projectedRouteOverlay.to) {
        drawPin(
          projectedRouteOverlay.to.x,
          projectedRouteOverlay.to.y,
          "rgba(239, 68, 68, 0.98)",
          "B",
        );
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
    projectedRouteOverlay,
    routeTLBaseSkipIndices,
    zoom,
    traderStyle,
    tlStyle,
    terminusStyle,
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
      // Home markers are icon-only; never render their label badge.
      if (pt.kind === "Home") continue;
      // Terminus markers are also icon-only — the icon itself is a unique
      // skull/cross/rift, so the literal "Terminus" label would just add
      // visual noise.
      if (pt.kind === "Terminus") continue;

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
      // Wheel-zoom stays available even when interactions are locked —
      // locking only disables panning so the user can still zoom in/out
      // while dragging endpoint handles or otherwise interacting with the
      // overlay.
      e.preventDefault();
      // Cancel any in-flight fly so the user's wheel input wins.
      if (flyAnimRef.current != null) {
        cancelAnimationFrame(flyAnimRef.current);
        flyAnimRef.current = null;
      }
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
      const el = containerRef.current;
      if (!el) return;
      const z = currentZoom ?? zoomRef.current;
      const rect = el.getBoundingClientRect();
      // When a custom centerTarget is supplied, recenter on that world-block
      // point instead of (0, 0).
      const target =
        centerTarget && Number.isFinite(centerTarget.x) && Number.isFinite(centerTarget.z)
          ? centerTarget
          : { x: 0, z: 0 };
      const imgX = ((target.x - stats.start_x) / stats.width_blocks) * imgNatural.w;
      const imgY = ((target.z - stats.start_z) / stats.height_blocks) * imgNatural.h;
      animatePanZoomTo({ x: rect.width / 2 - imgX * z, y: rect.height / 2 - imgY * z }, z);
    },
    [animatePanZoomTo, stats, imgNatural, centerTarget],
  );

  // Tile-mode initial centering — runs once per tileSet id, after the
  // container has measured itself AND stats have loaded. Mirrors the
  // `<img onLoad>` -> centerView call that the blob path uses.
  // We deliberately wait for `stats` so the first centering call uses the
  // origin-aware branch of `centerView`; otherwise the map snaps to a
  // corner-anchored position and the ref then prevents any re-centering.
  // Skipped while an unconsumed `initialView` is pending so we don't fight
  // with the URL-restore effect below.
  const initialViewAppliedRef = useRef(false);
  useEffect(() => {
    if (!activeTileSet || containerSize.w === 0 || !stats) return;
    if (centeredTileIdRef.current === activeTileSet.id) return;
    if (initialView && !initialViewAppliedRef.current) return;
    centeredTileIdRef.current = activeTileSet.id;
    centerView(activeTileSet.imageWidth, activeTileSet.imageHeight, zoomRef.current);
  }, [activeTileSet, containerSize.w, centerView, stats, initialView]);

  // Restore a previously-shared view (from URL params) once everything we
  // need is on screen. Runs at most once per mount.
  useEffect(() => {
    if (initialViewAppliedRef.current) return;
    if (!initialView) return;
    if (!stats || imgNatural.w === 0 || imgNatural.h === 0) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;
    if (!activeTileSet && !activeUrl) return;

    const { centerWorldX, centerWorldZ, pixelsPerBlock } = initialView;
    if (
      !Number.isFinite(centerWorldX) ||
      !Number.isFinite(centerWorldZ) ||
      !Number.isFinite(pixelsPerBlock) ||
      pixelsPerBlock <= 0
    ) {
      initialViewAppliedRef.current = true;
      return;
    }

    // Convert world-space pixels-per-block into the viewer's internal zoom,
    // which is multiplied against the current image's natural width.
    const internalZoom = Math.min(
      Math.max((pixelsPerBlock * stats.width_blocks) / imgNatural.w, 0.1),
      20,
    );
    const imgX = ((centerWorldX - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const imgY = ((centerWorldZ - stats.start_z) / stats.height_blocks) * imgNatural.h;
    setZoom(internalZoom);
    setPan({
      x: containerSize.w / 2 - imgX * internalZoom,
      y: containerSize.h / 2 - imgY * internalZoom,
    });
    if (activeTileSet) centeredTileIdRef.current = activeTileSet.id;
    initialViewAppliedRef.current = true;
  }, [initialView, stats, imgNatural, containerSize, activeTileSet, activeUrl]);

  // Report the current viewport (world center + on-screen scale) to the
  // parent, debounced so we don't spam URL updates while panning.
  useEffect(() => {
    if (!onViewportChange) return;
    if (!stats || imgNatural.w === 0 || imgNatural.h === 0) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;
    const handle = setTimeout(() => {
      const cx = containerSize.w / 2;
      const cy = containerSize.h / 2;
      const imgX = (cx - pan.x) / zoom;
      const imgY = (cy - pan.y) / zoom;
      const worldX = (imgX / imgNatural.w) * stats.width_blocks + stats.start_x;
      const worldZ = (imgY / imgNatural.h) * stats.height_blocks + stats.start_z;
      const pixelsPerBlock = (zoom * imgNatural.w) / stats.width_blocks;
      if (![worldX, worldZ, pixelsPerBlock].every(Number.isFinite)) return;
      // World bounds of the visible viewport (in blocks).
      const halfWblocks = containerSize.w / 2 / pixelsPerBlock;
      const halfHblocks = containerSize.h / 2 / pixelsPerBlock;
      onViewportChange({
        centerWorldX: worldX,
        centerWorldZ: worldZ,
        pixelsPerBlock,
        worldMinX: worldX - halfWblocks,
        worldMaxX: worldX + halfWblocks,
        worldMinZ: worldZ - halfHblocks,
        worldMaxZ: worldZ + halfHblocks,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [pan, zoom, stats, imgNatural, containerSize, onViewportChange]);

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
    const el = containerRef.current;
    if (!el || imgNatural.w === 0 || imgNatural.h === 0) return;
    const rect = el.getBoundingClientRect();
    const z = 1;
    let targetPan: { x: number; y: number };
    if (stats) {
      const imgX = ((0 - stats.start_x) / stats.width_blocks) * imgNatural.w;
      const imgY = ((0 - stats.start_z) / stats.height_blocks) * imgNatural.h;
      targetPan = { x: rect.width / 2 - imgX * z, y: rect.height / 2 - imgY * z };
    } else {
      targetPan = {
        x: (rect.width - imgNatural.w * z) / 2,
        y: (rect.height - imgNatural.h * z) / 2,
      };
    }
    animatePanZoomTo(targetPan, z);
  }, [animatePanZoomTo, imgNatural, stats]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (interactionsLockedRef.current) return;
    // In pick mode we never start a pan — the click is reserved for
    // selecting a world-space endpoint (route planner etc.). The actual
    // selection happens in `handleOverlayClick` below.
    if (cursorModeRef.current === "pick") return;
    // Any deliberate user input supersedes the in-flight fly animation.
    if (flyAnimRef.current != null) {
      cancelAnimationFrame(flyAnimRef.current);
      flyAnimRef.current = null;
    }
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
        // Always compute world coords so the overlay keeps tracking the
        // cursor even when the user pans outside the map image. The
        // image-to-world transform is linear so extrapolation is valid.
        const blockX = Math.floor((imgX / imgNatural.w) * stats.width_blocks + stats.start_x);
        const blockZ = Math.floor((imgY / imgNatural.h) * stats.height_blocks + stats.start_z);
        setHoverCoords({ x: blockX, z: blockZ });

        if (imgX >= 0 && imgX < imgNatural.w && imgY >= 0 && imgY < imgNatural.h) {
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

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      // Pick mode: convert the click position into world-block coordinates
      // (mirroring the pan/zoom math in `handleMouseMove`) and report via
      // `onWorldClick`. We intentionally do NOT also fire the segment-click
      // callback so route-planner picks don't side-effect TL selection.
      if (cursorModeRef.current === "pick" && onWorldClick && containerRef.current && stats) {
        const rect = containerRef.current.getBoundingClientRect();
        const imgX = (e.clientX - rect.left - panRef.current.x) / zoomRef.current;
        const imgY = (e.clientY - rect.top - panRef.current.y) / zoomRef.current;
        if (imgX < 0 || imgX >= imgNatural.w || imgY < 0 || imgY >= imgNatural.h) return;
        const worldX = Math.floor((imgX / imgNatural.w) * stats.width_blocks + stats.start_x);
        const worldZ = Math.floor((imgY / imgNatural.h) * stats.height_blocks + stats.start_z);
        onWorldClick(worldX, worldZ);
        return;
      }
      if (!onOverlaySegmentClick || !overlaySegments || overlaySegments.length === 0) return;
      if (hoveredOverlayIndex === null) {
        onOverlaySegmentClick(null);
        return;
      }
      onOverlaySegmentClick(overlaySegments[hoveredOverlayIndex] ?? null);
    },
    [
      hoveredOverlayIndex,
      imgNatural.h,
      imgNatural.w,
      onOverlaySegmentClick,
      onWorldClick,
      overlaySegments,
      stats,
    ],
  );

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

  // if (!activeUrl && !activeTileSet) return null;

  const canvasClass = [
    "relative overflow-hidden",
    starfield ? "starfield" : "bg-black/90",
    bordered ? "rounded-md border" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2 p-2">
      {legend && (
        <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground border-b bg-muted/30">
          {legend}
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {toolbarStart}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={zoomOut}
          title={t("topsMap.zoomOut")}
        >
          <ZoomOut className="size-4" />
        </Button>
        {/* <span className="text-xs text-muted-foreground w-14 text-center">
          {Math.round(
            (zoomReferenceWidth > 0 && imgNatural.w > 0
              ? (zoom * imgNatural.w) / zoomReferenceWidth
              : zoom) * 100,
          )}%
        </span> */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={zoomIn}
          title={t("topsMap.zoomIn")}
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={resetView}
          title={t("topsMap.resetView")}
        >
          <RotateCcw className="size-4" />
        </Button>
        {stats && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => centerOnOrigin()}
            title={
              centerTarget
                ? t("topsMap.centerOnCoordinate", {
                    x: centerTarget.x,
                    z: centerTarget.z,
                  })
                : t("topsMap.centerOnOrigin")
            }
          >
            <Crosshair className="size-4" />
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-2">
          {t("topsMap.scrollToZoomDragToPan")}
        </span>
        {enhancing && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
            <Loader2 className="size-3 animate-spin" />
            {t("topsMap.enhancing")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {showFullscreenControl && !isFullscreen && (
            <Button
              type="button"
              variant="default"
              onClick={() => setIsFullscreen(true)}
              title={t("topsMap.enterFullscreenMapView")}
            >
              <Maximize2 className="size-4 mr-1" />
              {t("topsMap.fullscreen")}
            </Button>
          )}
          <div
            className={`grid transition-[grid-template-columns,opacity] duration-300 ease-out ${
              showTLLegend
                ? "grid-cols-[1fr] opacity-100"
                : "grid-cols-[0fr] opacity-0 pointer-events-none"
            }`}
            aria-hidden={!showTLLegend}
          >
            <div className="overflow-hidden min-w-0">
              <TLLegendButton showContributeColors={tlLegendShowContributeColors} />
            </div>
          </div>
        </div>
      </div>
      <div
        ref={containerRef}
        className={canvasClass}
        style={{
          height,
          cursor:
            cursorMode === "pick"
              ? "crosshair"
              : dragging
                ? "grabbing"
                : hoveredOverlayIndex !== null
                  ? "pointer"
                  : "grab",
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
                // heuristic ignores ancestor CSS transforms, so chunks whose
                // untransformed absolute position falls outside the viewport
                // (anything beyond the container width on level 4 = most of
                // them) never get requested. We already cull off-screen chunks
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
            {overlay}
            {overlayRender?.({ zoom, imgNatural, stats })}
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
