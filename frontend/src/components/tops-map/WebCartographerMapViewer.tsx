import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw, Crosshair, Maximize2 } from "lucide-react";
import { TLLegendButton } from "@/components/TLLegendButton";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import { setShowFullscreen as setShowFullscreenAction } from "@/store/slices/mapView";
import {
  drawTraderMarker,
  drawTLEndpoint,
  drawTerminusMarker,
  drawClaimDot,
} from "@/lib/markerStyles";
import { useTranslation } from "@/lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TRADER_TYPES,
  TRADER_TYPE_LABELS,
  CLAIM_UNCLASSIFIED_COLOR,
  type TraderType,
} from "@/lib/trader-types";
import type { TraderClaimMarker } from "@/hooks/useTraderClaims";
import type { PlayerClaim, PlayerClaimDensity } from "@/hooks/usePlayerClaims";
import {
  type ClaimTypeMap,
  type CachedOverlay,
  TRADER_CLAIM_TYPES_QUERY_KEY,
} from "@/hooks/useOverlayData";
import { useTraderColors } from "@/hooks/useTraderColors";
import { submitTraderClaimTypes, type ClaimTypeSubmitItem } from "@/lib/api";
import { registerWCTileServiceWorker, disableWCTileCache } from "@/lib/wcTileCache";
import type {
  MapStats,
  RouteOverlay,
  WorldLineSegment,
  WorldPointMarker,
} from "@/components/MapViewer";

/**
 * WebCartographer-compatible tile parameters.
 *
 * WebCartographer (https://gitlab.com/th3dilli_vintagestory/WebCartographer)
 * exports an OpenLayers-XYZ tile pyramid covering a fixed 1,024,000-block
 * square centred on the world origin, with a top-left tile-grid origin and
 * 10 zoom levels whose resolutions (world blocks per pixel) halve at each
 * step from 512 down to 1. See `worldExtent.js` on any WC host.
 */
const WC_EXTENT_HALF_BLOCKS = 512_000;
const WC_WORLD_BLOCKS = WC_EXTENT_HALF_BLOCKS * 2;
const WC_TILE_SIZE_PX = 256;
const WC_RESOLUTIONS = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1] as const;
const WC_MAX_ZOOM = WC_RESOLUTIONS.length - 1;

/**
 * On-screen pixels-per-block at which we'd like the viewer to start so a
 * meaningful chunk of the explored world is visible without first having to
 * zoom out. ~0.004 px/block = ~4000 blocks per 16px = comfortable overview
 * of the global map.
 */
const INITIAL_PIXELS_PER_BLOCK = 0.004;

const MIN_PIXELS_PER_BLOCK = 0.0005;
/** A single block stretched across 8 screen pixels — useful for inspecting
 * landmark details. */
const MAX_PIXELS_PER_BLOCK = 8;

/** Below this zoom the trader-claim dot field is hidden — the ~thousands of
 *  boxes would otherwise smear into an unreadable wall when zoomed way out. */
const CLAIM_MIN_PIXELS_PER_BLOCK = 0.02;

const WHEEL_ZOOM_FACTOR = 1.3;
const BUTTON_ZOOM_FACTOR = 1.75;

/**
 * Render this many extra tile widths around the viewport so panning never
 * exposes empty edges before the next request lands.
 */
const TILE_OVERSCAN_TILES = 1;

/**
 * Maximum number of decoded tile bitmaps to keep alive at once. Each
 * 256×256 RGBA tile is ~256KB in memory, so 1800 ≈ 450MB worst-case — a
 * comfortable budget for desktop browsers while still allowing fast
 * pan/zoom across multiple pyramid levels (each level visited adds another
 * viewport's worth of tiles, and we want previous levels to survive so
 * zooming back doesn't refetch).
 */
const TILE_CACHE_LIMIT = 1800;

/**
 * How many parent pyramid levels above the current one to consult when a
 * tile at the current level hasn't loaded yet. Each step up halves the
 * number of fallback tiles to scan, so this is cheap; it lets us paint
 * *something* (a coarser ancestor) the moment the user crosses a zoom
 * threshold, even if they jumped multiple levels at once.
 */
const TILE_FALLBACK_PARENT_LEVELS = 8;

/**
 * Synthetic {@link MapStats} mirroring the WC world extent — all our overlays
 * (TLs, traders, landmarks, oceans, route planner) project world-block coords
 * through this so they line up pixel-for-pixel with the imported tiles.
 *
 * `pieces` and `size_mb` are admin-stats-header fields that have no meaning
 * for the WC path; they stay at zero.
 */
const WC_STATS: MapStats = {
  pieces: 0,
  size_mb: 0,
  width_chunks: WC_WORLD_BLOCKS / 32,
  height_chunks: WC_WORLD_BLOCKS / 32,
  width_blocks: WC_WORLD_BLOCKS,
  height_blocks: WC_WORLD_BLOCKS,
  start_x: -WC_EXTENT_HALF_BLOCKS,
  start_z: -WC_EXTENT_HALF_BLOCKS,
};

function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** State of one cached tile image. */
interface TileEntry {
  status: "loading" | "loaded" | "error";
  img?: HTMLImageElement;
  /** `performance.now()` timestamp the image finished loading; used to
   * fade tiles in over {@link TILE_FADE_MS} for a subtle progressive-
   * reveal effect when the user pans into unexplored regions or crosses
   * a zoom threshold. */
  loadedAt?: number;
}

/** Duration of the per-tile fade-in animation, in ms. */
const TILE_FADE_MS = 280;

interface WebCartographerMapViewerProps {
  /** WC host (with or without trailing slash). Tiles served at
   * `${baseUrl}/data/world/{z}/{x}_{y}.${tileFormat}`. */
  baseUrl: string;
  /** Tile image extension served by the host. Stock WebCartographer uses
   * `png`; the translocator.moe mirror serves the same pyramid as `webp`.
   * Defaults to `png` when omitted. */
  tileFormat?: "png" | "webp";

  // ── Visual / layout ─────────────────────────────────────────────────────
  height?: string;
  alt?: string;
  bordered?: boolean;
  starfield?: boolean;
  showFullscreenControl?: boolean;
  showTLLegend?: boolean;
  tlLegendShowContributeColors?: boolean;
  toolbarStart?: React.ReactNode;
  legend?: React.ReactNode;

  // ── Overlay data ────────────────────────────────────────────────────────
  overlaySegments?: WorldLineSegment[];
  overlayPoints?: WorldPointMarker[];
  /**
   * Static trader-claim boxes rendered as small dots. Projected + culled +
   * hit-tested internally so the parent can pass the full (deduped) set. When
   * {@link claimMarkingEnabled} is on, clicking a dot opens a type picker.
   */
  claimMarkers?: TraderClaimMarker[];
  /** Claim id → assigned trader type, used to colour classified claim dots. */
  claimTypes?: ClaimTypeMap;
  /** Enable the click-to-mark type picker on claim dots. */
  claimMarkingEnabled?: boolean;
  /**
   * Whether the current user has an account. Marking a claim type requires a
   * real account (the API key's contribute permission is not enough — the
   * backend `/trader-claim-types` route returns 403 without a user), so the
   * picker only opens when this is true.
   */
  claimMarkingHasAccount?: boolean;
  /**
   * Player-claim concentration heatmap (density mode). A precomputed raster
   * blitted once per frame — panning/zooming only re-scales the image. */
  claimDensity?: (PlayerClaimDensity & { opacity: number }) | null;
  /** Filtered player claims drawn as footprint boxes + dots (search mode). */
  playerClaimMarkers?: PlayerClaim[];
  /** "always" labels every marker (search); "hover" labels only the hovered
   *  claim (all mode). */
  playerClaimLabelMode?: "always" | "hover";
  routeOverlay?: RouteOverlay | null;
  highlightedSegment?: WorldLineSegment | null;
  highlightedSegments?: WorldLineSegment[];
  /**
   * Optional per-segment color override keyed by canonical TL id
   * (`${x1},${z1},${x2},${z2}` — see `tlIdFor`). When a key is present, the
   * matching segment is drawn with that color (and a derived translucent
   * glow) instead of the default purple/blue. Used by the favorites "Only
   * selected" view to surface per-grouping colors and a shared-white for
   * TLs that belong to multiple active groupings.
   */
  segmentColors?: Map<string, string>;

  // ── Interaction ─────────────────────────────────────────────────────────
  onOverlaySegmentClick?: (segment: WorldLineSegment | null) => void;
  onOverlaySegmentRightClick?: (segment: WorldLineSegment) => void;
  cursorMode?: "default" | "pick";
  onWorldClick?: (x: number, z: number) => void;
  interactionsLocked?: boolean;
  /** Receives the cursor's centered (TOPS) world coordinate on every
   *  mousemove, and `null` on mouseleave. Used by overlays (climate
   *  probe, etc.) that need a live readout. */
  onHoverCoords?: (coords: { x: number; z: number } | null) => void;

  /**
   * Optional cursor-radius cull for the translocator overlay. When set,
   * only TLs whose `tlId` is in `alwaysShowTLIds` OR with at least one
   * endpoint within `radiusBlocks` world blocks of the mouse cursor are
   * drawn. When the cursor is outside the map, only the always-show set
   * renders. Drawing a soft circle outline at the cursor visualises the
   * active radius. Pure render-time cull — the parent is free to keep
   * passing the full segment list for stable memos and hit-testing.
   */
  radiusFilter?: {
    radiusBlocks: number;
    alwaysShowTLIds: ReadonlySet<string>;
  } | null;

  // ── Navigation ──────────────────────────────────────────────────────────
  focusPoint?: { x: number; z: number };
  focusZoom?: number;
  focusSpanBlocks?: number;
  initialView?: {
    centerWorldX: number;
    centerWorldZ: number;
    pixelsPerBlock: number;
  };
  centerTarget?: { x: number; z: number } | null;
  onViewportChange?: (info: {
    centerWorldX: number;
    centerWorldZ: number;
    pixelsPerBlock: number;
    worldMinX: number;
    worldMaxX: number;
    worldMinZ: number;
    worldMaxZ: number;
  }) => void;

  // ── Extra render slots ──────────────────────────────────────────────────
  /**
   * JSX rendered inside a transformed `<div>` above the canvas. Coordinates
   * are in image-space pixels (sized to the synthetic WC image). Used for
   * SVG-based layers like the oceans overlay.
   */
  overlay?: React.ReactNode;
  overlayRender?: (info: {
    zoom: number;
    imgNatural: { w: number; h: number };
    stats: MapStats | null;
  }) => React.ReactNode;
  /**
   * Same as {@link overlay} / {@link overlayRender} but rendered in a
   * transformed `<div>` *above* the tile canvas. Used for layers that
   * should sit on top of explored terrain (e.g. rock-strata raster),
   * unlike the regular overlay slot which sits below the canvas so
   * background imagery (oceans) only shows through unexplored cells.
   */
  overlayAbove?: React.ReactNode;
  overlayRenderAbove?: (info: {
    zoom: number;
    imgNatural: { w: number; h: number };
    stats: MapStats | null;
  }) => React.ReactNode;
}

/**
 * Canvas-based viewer for WebCartographer-style external map hosts.
 *
 * Unlike {@link MapViewer} (which renders one DOM `<img>` per visible tile),
 * this viewer paints all tiles into a single full-viewport `<canvas>` per
 * frame. That:
 *   - Avoids the per-frame DOM reconciliation cost of ~150 image elements,
 *     which is the dominant cost when panning across a busy region.
 *   - Lets us draw lower-pyramid-level tiles underneath while higher-level
 *     tiles are still in flight, so panning never reveals blank gaps.
 *   - Silently drops 404 tiles instead of rendering the browser's
 *     broken-image glyph (WC pyramids are sparse — every unexplored cell
 *     returns 404 and there's no JSON manifest of "which exist").
 *
 * Overlays (TLs, points, route, labels) are drawn on the same canvas after
 * the tiles; the JSX-style `overlayRender` slot is still supported via a
 * transformed `<div>` above the canvas for SVG/HTML overlays such as the
 * oceans layer.
 */
export function WebCartographerMapViewer({
  baseUrl,
  tileFormat,
  alt = "Map",
  height = "70vh",
  bordered = true,
  starfield = false,
  showFullscreenControl = false,
  showTLLegend = false,
  tlLegendShowContributeColors = false,
  toolbarStart,
  legend,
  overlaySegments,
  overlayPoints,
  claimMarkers,
  claimTypes,
  claimMarkingEnabled = false,
  claimMarkingHasAccount = false,
  claimDensity = null,
  playerClaimMarkers,
  playerClaimLabelMode = "always",
  routeOverlay = null,
  highlightedSegment,
  highlightedSegments,
  segmentColors,
  radiusFilter = null,
  onOverlaySegmentClick,
  onOverlaySegmentRightClick,
  cursorMode = "default",
  onWorldClick,
  interactionsLocked = false,
  onHoverCoords,
  focusPoint,
  focusZoom = 1,
  focusSpanBlocks,
  initialView,
  centerTarget = null,
  onViewportChange,
  overlay,
  overlayRender,
  overlayAbove,
  overlayRenderAbove,
}: WebCartographerMapViewerProps) {
  const { t } = useTranslation();
  const normalisedUrl = useMemo(() => normaliseBaseUrl(baseUrl), [baseUrl]);
  const tileExt: "png" | "webp" = tileFormat ?? "png";
  // Mirror through a ref so the stable `requestTile` callback (deps: [])
  // always reads the latest extension. Without this, switching from the
  // default PNG host to the translocator.moe WebP mirror at runtime would
  // keep requesting `.png` because the closure captured the initial value.
  const tileExtRef = useRef<"png" | "webp">(tileExt);
  useEffect(() => {
    tileExtRef.current = tileExt;
  }, [tileExt]);

  const dispatch = useAppDispatch();
  const isFullscreen = useReduxState("mapView.isFullscreen");
  const traderStyle = useReduxState("mapView.traderStyle");
  const tlStyle = useReduxState("mapView.tlStyle");
  const terminusStyle = useReduxState("mapView.terminusStyle");
  const traderColors = useTraderColors();
  const setIsFullscreen = useCallback(
    (next: boolean) => dispatch(setShowFullscreenAction(next)),
    [dispatch],
  );

  // ── Trader-claim marking ──────────────────────────────────────────────────
  const isAdminUser = useReduxState("auth.isAdmin");
  // Marking a claim type needs a real account (admins have one too); the
  // API key's contribute permission alone yields a 403 from the backend.
  // Mirrored into a ref so the stable `handleClick` closure can gate the
  // type-picker on auth without needing these as deps.
  const canMarkClaims = claimMarkingHasAccount || isAdminUser;
  const canMarkClaimsRef = useRef(canMarkClaims);
  useEffect(() => {
    canMarkClaimsRef.current = canMarkClaims;
  }, [canMarkClaims]);
  const claimQueryClient = useQueryClient();
  // Screen-projected claim dots from the last draw, for click/hover hit-tests.
  const projectedClaimsRef = useRef<
    Array<{ claimId: string; sx: number; sy: number; center: { x: number; y: number; z: number } }>
  >([]);
  const [hoveredClaimId, setHoveredClaimId] = useState<string | null>(null);
  const hoveredClaimIdRef = useRef<string | null>(null);
  // Screen-projected player-claim markers from the last draw + the currently
  // hovered one (all-mode owner-label-on-hover).
  const projectedPlayerClaimsRef = useRef<
    Array<{ sx: number; sy: number; x: number; z: number; label: string }>
  >([]);
  const [hoveredPlayerClaim, setHoveredPlayerClaim] = useState<{
    x: number;
    z: number;
    label: string;
  } | null>(null);
  const hoveredPlayerClaimRef = useRef<{ x: number; z: number; label: string } | null>(null);
  const [claimPopover, setClaimPopover] = useState<{
    claimId: string;
    center: { x: number; y: number; z: number };
    left: number;
    top: number;
  } | null>(null);
  const claimMutation = useMutation({
    mutationFn: (item: ClaimTypeSubmitItem) => submitTraderClaimTypes([item]),
    onSuccess: (_result, item) => {
      // Patch the in-memory claim-type overlay so the dot recolours instantly,
      // instead of reloading the whole trader_claim_types.json (which the R2
      // bucket may not even reflect yet).
      claimQueryClient.setQueryData<CachedOverlay<ClaimTypeMap>>(
        [...TRADER_CLAIM_TYPES_QUERY_KEY],
        (prev) => {
          const next: ClaimTypeMap = {
            ...(prev?.data ?? {}),
            [item.claim_id]: { trader_type: item.trader_type, source: "manual" },
          };
          return {
            etag: prev?.etag ?? "__empty__",
            expiresAt: prev?.expiresAt ?? Date.now() + 5 * 60_000,
            data: next,
          };
        },
      );
      setClaimPopover(null);
    },
  });

  // ── Refs ─────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Second canvas stacked above `canvasRef`, used purely for the dynamic
  // overlays (TLs, points, route, labels). Splitting tiles vs overlays
  // into separate canvases lets the parent slot a DOM-based layer (e.g.
  // rock-strata raster) between them, so it covers the terrain tiles
  // but stays beneath translocators / landmarks / traders.
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const tileCacheRef = useRef<{
    baseUrl: string;
    tileExt: "png" | "webp";
    cache: Map<string, TileEntry>;
  }>({
    baseUrl: normalisedUrl,
    tileExt,
    cache: new Map(),
  });
  if (tileCacheRef.current.baseUrl !== normalisedUrl || tileCacheRef.current.tileExt !== tileExt) {
    // Host or tile-format change: abandon old images (browser GCs them)
    // and start fresh so we don't serve stale `.png` blobs for a host
    // that now wants `.webp` (or vice versa).
    for (const entry of tileCacheRef.current.cache.values()) {
      if (entry.img) entry.img.src = "";
    }
    tileCacheRef.current = { baseUrl: normalisedUrl, tileExt, cache: new Map() };
  }

  /** Triggers a canvas redraw on the next animation frame. */
  const redrawRequestedRef = useRef(false);
  const redrawHandleRef = useRef<number | null>(null);

  // ── Viewport state ───────────────────────────────────────────────────────
  // `pixelsPerBlock` is the on-screen scale: 1 world block occupies this
  // many CSS pixels in the viewer. `centerWorldX/Z` is the world coordinate
  // currently under the viewport centre. Together they fully describe pan +
  // zoom in a way that's invariant under container resizes.
  const [pixelsPerBlock, setPixelsPerBlock] = useState(INITIAL_PIXELS_PER_BLOCK);
  const [centerWorldX, setCenterWorldX] = useState(0);
  const [centerWorldZ, setCenterWorldZ] = useState(0);

  const pixelsPerBlockRef = useRef(pixelsPerBlock);
  const centerWorldXRef = useRef(centerWorldX);
  const centerWorldZRef = useRef(centerWorldZ);
  useEffect(() => {
    pixelsPerBlockRef.current = pixelsPerBlock;
  }, [pixelsPerBlock]);
  useEffect(() => {
    centerWorldXRef.current = centerWorldX;
  }, [centerWorldX]);
  useEffect(() => {
    centerWorldZRef.current = centerWorldZ;
  }, [centerWorldZ]);

  // ── Container size (CSS px) ──────────────────────────────────────────────
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; cwX: number; cwZ: number } | null>(null);
  // Largest cursor displacement (CSS px) since the most recent mousedown.
  // Used to suppress an accidental overlay-segment click when the user was
  // really just panning the map — spawn-dense regions have almost no
  // empty space to drag from. Reset on each mousedown.
  const dragMaxDistRef = useRef(0);
  // Active pointers (touch/pen/mouse) keyed by pointerId — drives both
  // single-pointer pan and two-finger pinch-zoom on touch devices.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Live pinch gesture: distance + per-block scale captured when the second
  // finger lands, so subsequent moves scale relative to the gesture start.
  const pinchRef = useRef<{ startDist: number; startPpb: number } | null>(null);
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  const [hoveredSegmentIndex, setHoveredSegmentIndex] = useState<number | null>(null);
  // Per-marker hover tooltip (X/Y/Z) for point markers that carry a `tooltip`
  // payload (recorded broken translocators). `left`/`top` are container-
  // relative pixel coordinates of the cursor.
  const [hoveredPointTooltip, setHoveredPointTooltip] = useState<{
    left: number;
    top: number;
    x: number;
    y: number;
    z: number;
  } | null>(null);
  // Live cursor world position kept in a ref so the per-frame draw can
  // read it without forcing the projectedSegments memo to re-run on every
  // mousemove. Set to `null` whenever the cursor is outside the canvas.
  const cursorWorldRef = useRef<{ x: number; z: number } | null>(null);
  // Mirror the radiusFilter prop into a ref so the draw routine can
  // consult the latest value without becoming a memo dep.
  const radiusFilterRef = useRef<typeof radiusFilter>(radiusFilter);
  useEffect(() => {
    radiusFilterRef.current = radiusFilter;
    // Filter on/off transitions need an immediate redraw so the visible
    // set updates without waiting for the next mousemove.
    drawRef.current?.();
    scheduleRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radiusFilter]);
  const interactionsLockedRef = useRef(interactionsLocked);
  const cursorModeRef = useRef(cursorMode);
  useEffect(() => {
    interactionsLockedRef.current = interactionsLocked;
  }, [interactionsLocked]);
  useEffect(() => {
    cursorModeRef.current = cursorMode;
  }, [cursorMode]);

  // ── Pyramid level selection ──────────────────────────────────────────────
  // WC_RESOLUTIONS[z] = world blocks per source pixel at level z.
  // We're drawing each block as `pixelsPerBlock` screen px, so 1 source
  // pixel covers `res * ppb` screen px. To avoid upsampling (blurry) we
  // want `res * ppb <= 1` ⇒ `res <= 1/ppb`. Picking the COARSEST level
  // that still satisfies this minimises bandwidth and tile count without
  // sacrificing crispness; only when ppb exceeds the highest level's
  // native scale (max zoom-in) do we accept some upsampling at WC_MAX_ZOOM.
  const currentZoomLevel = useMemo(() => {
    const targetRes = 1 / Math.max(pixelsPerBlock, 1e-6);
    for (let z = 0; z <= WC_MAX_ZOOM; z++) {
      if (WC_RESOLUTIONS[z] <= targetRes) return z;
    }
    return WC_MAX_ZOOM;
  }, [pixelsPerBlock]);

  // ── Tile loading ─────────────────────────────────────────────────────────
  /**
   * Look up (or kick off a fetch of) the tile at the given pyramid coords.
   * Returns the cached entry — caller should `status === "loaded"` check
   * before drawing.
   */
  const requestTile = useCallback(
    (z: number, cx: number, cy: number): TileEntry => {
      const cache = tileCacheRef.current.cache;
      const key = `${z}/${cx}/${cy}`;
      const hit = cache.get(key);
      if (hit) {
        // Touch for LRU.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const entry: TileEntry = { status: "loading" };
      const img = new Image();
      img.decoding = "async";
      // No `crossOrigin` — we only `drawImage` these tiles, never read
      // pixels back, so tainting the canvas is fine. Requesting CORS would
      // force the WC host to send Access-Control-Allow-Origin headers and
      // images would fail to load entirely when those are absent.
      img.onload = () => {
        // Guard against an entry that was evicted while the request was in
        // flight — re-inserting here would silently bypass the cap.
        if (!cache.has(key)) return;
        entry.status = "loaded";
        entry.img = img;
        entry.loadedAt = performance.now();
        scheduleRedraw();
      };
      img.onerror = () => {
        if (!cache.has(key)) return;
        entry.status = "error";
        // Don't re-request — sparse WC pyramids have empty cells everywhere
        // and retrying would be a perpetual storm of 404s.
        scheduleRedraw();
      };
      img.src = `${tileCacheRef.current.baseUrl}/data/world/${z}/${cx}_${cy}.${tileExtRef.current}`;
      cache.set(key, entry);

      // LRU eviction: drop oldest entries when over budget. Abort in-flight
      // requests so we don't hold onto network resources we'll never use.
      while (cache.size > TILE_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldest?.img && oldest.status === "loading") {
          oldest.img.src = "";
        }
      }
      return entry;
    },
    // scheduleRedraw is stable (defined below with refs) — eslint may warn
    // here but we deliberately keep this callback identity stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Debounced loader for the current viewport. Called from the draw routine
   * each frame, but it only kicks off network fetches once the view has
   * been idle for ~120ms — so a fast wheel-zoom across many levels (or a
   * fling-pan) doesn't fire requests for every intermediate state. Right
   * before fetching, it cancels any still-in-flight request that's no
   * longer relevant (different level, or outside the new viewport) so the
   * browser's network queue isn't clogged with stale tiles.
   *
   * This is what OpenLayers (and therefore the upstream WebCartographer
   * UI) does internally — its `TileQueue` only loads tiles after movement
   * has settled, which is why their zoom-from-min-to-max produces ~120
   * requests instead of 1000+.
   */
  const fetchTimeoutRef = useRef<number | null>(null);
  const scheduleTileFetch = useCallback(() => {
    if (fetchTimeoutRef.current != null) {
      window.clearTimeout(fetchTimeoutRef.current);
    }
    fetchTimeoutRef.current = window.setTimeout(() => {
      fetchTimeoutRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const ppb = pixelsPerBlockRef.current;
      const cWx = centerWorldXRef.current;
      const cWz = centerWorldZRef.current;
      const targetRes = 1 / Math.max(ppb, 1e-6);
      let level = WC_MAX_ZOOM;
      for (let z = 0; z <= WC_MAX_ZOOM; z++) {
        if (WC_RESOLUTIONS[z] <= targetRes) {
          level = z;
          break;
        }
      }
      const resolution = WC_RESOLUTIONS[level];
      const tileSpanBlocks = WC_TILE_SIZE_PX * resolution;
      const tilesPerSide = Math.ceil(WC_WORLD_BLOCKS / resolution / WC_TILE_SIZE_PX);
      const halfWBlocks = cw / 2 / ppb;
      const halfHBlocks = ch / 2 / ppb;
      const startX = -WC_EXTENT_HALF_BLOCKS;
      const startZ = -WC_EXTENT_HALF_BLOCKS;
      const cxMin = Math.max(
        0,
        Math.floor((cWx - halfWBlocks - startX) / tileSpanBlocks) - TILE_OVERSCAN_TILES,
      );
      const cyMin = Math.max(
        0,
        Math.floor((cWz - halfHBlocks - startZ) / tileSpanBlocks) - TILE_OVERSCAN_TILES,
      );
      const cxMax = Math.min(
        tilesPerSide - 1,
        Math.floor((cWx + halfWBlocks - startX) / tileSpanBlocks) + TILE_OVERSCAN_TILES,
      );
      const cyMax = Math.min(
        tilesPerSide - 1,
        Math.floor((cWz + halfHBlocks - startZ) / tileSpanBlocks) + TILE_OVERSCAN_TILES,
      );

      // Cancel obsolete in-flight requests (different level or outside the
      // settled viewport). Setting `img.src = ""` aborts the network fetch
      // in all major browsers.
      const cache = tileCacheRef.current.cache;
      for (const [key, entry] of cache) {
        if (entry.status !== "loading" || !entry.img) continue;
        const slash1 = key.indexOf("/");
        const slash2 = key.indexOf("/", slash1 + 1);
        const kz = +key.slice(0, slash1);
        const kx = +key.slice(slash1 + 1, slash2);
        const ky = +key.slice(slash2 + 1);
        const inViewport = kz === level && kx >= cxMin && kx <= cxMax && ky >= cyMin && ky <= cyMax;
        if (inViewport) continue;
        entry.img.src = "";
        cache.delete(key);
      }

      for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cx = cxMin; cx <= cxMax; cx++) {
          requestTile(level, cx, cy);
        }
      }
    }, 120);
  }, [requestTile]);

  // ── Projection helpers (world ↔ image) ───────────────────────────────────
  const imgNatural = useMemo(() => {
    const resolution = WC_RESOLUTIONS[currentZoomLevel];
    const size = WC_WORLD_BLOCKS / resolution;
    return { w: size, h: size };
  }, [currentZoomLevel]);

  /**
   * Project world-block coords (x, z) into screen-space (CSS px) coords.
   * Both axes use the same scale factor `pixelsPerBlock`. Origin is at
   * the canvas top-left; +x = east, +z = south.
   */
  const projectWorld = useCallback(
    (wx: number, wz: number) => {
      return {
        x: (wx - centerWorldX) * pixelsPerBlock + containerSize.w / 2,
        y: (wz - centerWorldZ) * pixelsPerBlock + containerSize.h / 2,
      };
    },
    [centerWorldX, centerWorldZ, pixelsPerBlock, containerSize.w, containerSize.h],
  );

  /** Inverse of {@link projectWorld}. */
  const unprojectScreen = useCallback(
    (sx: number, sy: number) => {
      const ppb = pixelsPerBlockRef.current;
      return {
        x: (sx - containerSize.w / 2) / ppb + centerWorldXRef.current,
        z: (sy - containerSize.h / 2) / ppb + centerWorldZRef.current,
      };
    },
    [containerSize.w, containerSize.h],
  );

  // ── Projected overlay data ───────────────────────────────────────────────
  const projectedSegments = useMemo(() => {
    if (!overlaySegments || overlaySegments.length === 0) {
      return [] as Array<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        tlId: string;
        kind?: "default" | "user";
        color?: string;
      }>;
    }
    const out: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tlId: string;
      kind?: "default" | "user";
      color?: string;
    }> = [];
    for (const s of overlaySegments) {
      const a = projectWorld(s.x1, s.z1);
      const b = projectWorld(s.x2, s.z2);
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      const tlId = `${s.x1},${s.z1},${s.x2},${s.z2}`;
      const color = segmentColors?.get(tlId);
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, tlId, kind: s.kind, color });
    }
    return out;
  }, [overlaySegments, projectWorld, segmentColors]);

  const projectedPoints = useMemo(() => {
    if (!overlayPoints || overlayPoints.length === 0) {
      return [] as Array<{
        x: number;
        y: number;
        label?: string;
        kind?: string;
        color?: string;
        tooltip?: { x: number; y: number; z: number };
      }>;
    }
    const out: Array<{
      x: number;
      y: number;
      label?: string;
      kind?: string;
      color?: string;
      tooltip?: { x: number; y: number; z: number };
    }> = [];
    for (const p of overlayPoints) {
      const s = projectWorld(p.x, p.z);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      out.push({
        x: s.x,
        y: s.y,
        label: p.label,
        kind: p.kind,
        color: p.color,
        tooltip: p.tooltip,
      });
    }
    return out;
  }, [overlayPoints, projectWorld]);

  const projectedRoute = useMemo(() => {
    if (!routeOverlay) return null;
    const tlSegs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const s of routeOverlay.tlSegments) {
      const a = projectWorld(s.x1, s.z1);
      const b = projectWorld(s.x2, s.z2);
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      tlSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    const walkLegs: Array<{
      key?: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      elkState?: RouteOverlay["walkLegs"][number]["elkState"];
    }> = [];
    for (const leg of routeOverlay.walkLegs) {
      const a = projectWorld(leg.from.x, leg.from.z);
      const b = projectWorld(leg.to.x, leg.to.z);
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      walkLegs.push({ key: leg.key, x1: a.x, y1: a.y, x2: b.x, y2: b.y, elkState: leg.elkState });
    }
    const pin = (p: { x: number; z: number } | null | undefined) => {
      if (!p) return null;
      const s = projectWorld(p.x, p.z);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
      return s;
    };
    const tlIdSet = new Set<string>();
    for (const s of routeOverlay.tlSegments) {
      tlIdSet.add(`${s.x1},${s.z1},${s.x2},${s.z2}`);
      tlIdSet.add(`${s.x2},${s.z2},${s.x1},${s.z1}`);
    }
    return {
      tlSegs,
      walkLegs,
      from: pin(routeOverlay.from),
      to: pin(routeOverlay.to),
      tlIdSet,
      focusedWalkLegKey: routeOverlay.focusedWalkLegKey ?? null,
    };
  }, [routeOverlay, projectWorld]);

  const highlightedSegmentIndices = useMemo(() => {
    if (!overlaySegments || overlaySegments.length === 0) return new Set<number>();
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
      if (targets.has(`${s.x1},${s.z1},${s.x2},${s.z2}`)) out.add(i);
    }
    return out;
  }, [highlightedSegment, highlightedSegments, overlaySegments]);

  const routeTLBaseSkipIndices = useMemo(() => {
    if (!overlaySegments || !projectedRoute) return new Set<number>();
    const out = new Set<number>();
    for (let i = 0; i < overlaySegments.length; i++) {
      const s = overlaySegments[i];
      if (projectedRoute.tlIdSet.has(`${s.x1},${s.z1},${s.x2},${s.z2}`)) out.add(i);
    }
    return out;
  }, [overlaySegments, projectedRoute]);

  // ── Redraw scheduler (rAF-coalesced) ─────────────────────────────────────
  const drawRef = useRef<() => void>(() => {});
  const scheduleRedraw = useCallback(() => {
    if (redrawRequestedRef.current) return;
    redrawRequestedRef.current = true;
    redrawHandleRef.current = requestAnimationFrame(() => {
      redrawRequestedRef.current = false;
      redrawHandleRef.current = null;
      drawRef.current();
    });
  }, []);

  // ── The draw routine ─────────────────────────────────────────────────────
  drawRef.current = () => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !overlayCanvas || !container) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const sizeCanvas = (c: HTMLCanvasElement) => {
      if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
        c.width = Math.round(cw * dpr);
        c.height = Math.round(ch * dpr);
        c.style.width = `${cw}px`;
        c.style.height = `${ch}px`;
      }
    };
    sizeCanvas(canvas);
    sizeCanvas(overlayCanvas);

    const ctx = canvas.getContext("2d");
    const octx = overlayCanvas.getContext("2d");
    if (!ctx || !octx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Starfield is provided by the parent CSS class; clear to transparent
    // so it shows through where tiles are missing.
    ctx.clearRect(0, 0, cw, ch);
    octx.clearRect(0, 0, cw, ch);

    // ── Tiles ─────────────────────────────────────────────────────────────
    const ppb = pixelsPerBlockRef.current;
    const cWx = centerWorldXRef.current;
    const cWz = centerWorldZRef.current;
    const level = currentZoomLevel;
    const resolution = WC_RESOLUTIONS[level];
    /** Source tile span in world blocks. */
    const tileSpanBlocks = WC_TILE_SIZE_PX * resolution;
    /** Destination tile size in CSS px (what we draw to canvas). */
    const tileSpanScreen = tileSpanBlocks * ppb;

    // Total tiles per axis at this pyramid level.
    const tilesPerSide = Math.ceil(WC_WORLD_BLOCKS / resolution / WC_TILE_SIZE_PX);

    // World coords of the viewport corners.
    const halfWBlocks = cw / 2 / ppb;
    const halfHBlocks = ch / 2 / ppb;
    const viewWMinX = cWx - halfWBlocks;
    const viewWMinZ = cWz - halfHBlocks;
    const viewWMaxX = cWx + halfWBlocks;
    const viewWMaxZ = cWz + halfHBlocks;

    // Translate to tile coords (origin top-left = world (-512000, -512000)).
    const startX = -WC_EXTENT_HALF_BLOCKS;
    const startZ = -WC_EXTENT_HALF_BLOCKS;
    const cxMin = Math.max(
      0,
      Math.floor((viewWMinX - startX) / tileSpanBlocks) - TILE_OVERSCAN_TILES,
    );
    const cyMin = Math.max(
      0,
      Math.floor((viewWMinZ - startZ) / tileSpanBlocks) - TILE_OVERSCAN_TILES,
    );
    const cxMax = Math.min(
      tilesPerSide - 1,
      Math.floor((viewWMaxX - startX) / tileSpanBlocks) + TILE_OVERSCAN_TILES,
    );
    const cyMax = Math.min(
      tilesPerSide - 1,
      Math.floor((viewWMaxZ - startZ) / tileSpanBlocks) + TILE_OVERSCAN_TILES,
    );

    // Pixelated upsampling when stretched far beyond native resolution; a
    // smooth filter when downscaling so far-zoomed views don't shimmer.
    ctx.imageSmoothingEnabled = tileSpanScreen < WC_TILE_SIZE_PX * 1.2;
    ctx.imageSmoothingQuality = "low";

    // Optional parent-level fill-in: for every visible tile at the current
    // level that isn't loaded yet, walk up the pyramid and draw the
    // appropriate sub-rect of the first cached ancestor we find. This is
    // what OpenLayers (and therefore the upstream WebCartographer UI) does
    // — it means the moment the user crosses a zoom threshold, the screen
    // is filled by a coarser cached version while the higher-resolution
    // tiles stream in, instead of going blank. We do this BEFORE the main
    // pass so freshly-loaded current-level tiles paint over the fallback.
    //
    // We also record which tiles had fallback coverage so the main pass
    // can skip the fade-in animation for them — crossfading a sharper
    // image over an already-visible blurry version of the same area looks
    // muddy. Fading should only happen for genuinely-blank tiles.
    const tilesWithFallback = new Set<number>();
    const fallbackKey = (cx: number, cy: number) => cx * 100000 + cy;
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const maxUp = Math.min(level, TILE_FALLBACK_PARENT_LEVELS);
        for (let up = 1; up <= maxUp; up++) {
          const pz = level - up;
          const factor = 1 << up;
          const pcx = cx >> up;
          const pcy = cy >> up;
          const pKey = `${pz}/${pcx}/${pcy}`;
          const pEntry = tileCacheRef.current.cache.get(pKey);
          if (!pEntry || pEntry.status !== "loaded" || !pEntry.img) continue;

          // Source sub-rect inside the ancestor that covers this tile.
          const srcSize = WC_TILE_SIZE_PX / factor;
          const srcX = (cx & (factor - 1)) * srcSize;
          const srcY = (cy & (factor - 1)) * srcSize;

          const wx0 = startX + cx * tileSpanBlocks;
          const wz0 = startZ + cy * tileSpanBlocks;
          const sx = (wx0 - cWx) * ppb + cw / 2;
          const sy = (wz0 - cWz) * ppb + ch / 2;
          ctx.drawImage(
            pEntry.img,
            srcX,
            srcY,
            srcSize,
            srcSize,
            sx,
            sy,
            tileSpanScreen,
            tileSpanScreen,
          );
          tilesWithFallback.add(fallbackKey(cx, cy));
          break;
        }
      }
    }

    // Also try one level DOWN (children) — when zooming OUT we usually have
    // higher-resolution tiles still cached from before. Drawing those at a
    // smaller scale fills the viewport instantly while the new coarser
    // tiles load. Cheap because there are only 4 child tiles per parent.
    if (level < WC_MAX_ZOOM) {
      const childRes = WC_RESOLUTIONS[level + 1];
      const childSpanBlocks = WC_TILE_SIZE_PX * childRes;
      const childSpanScreen = childSpanBlocks * ppb;
      for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cx = cxMin; cx <= cxMax; cx++) {
          let drewChild = false;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const ccx = cx * 2 + dx;
              const ccy = cy * 2 + dy;
              const cKey = `${level + 1}/${ccx}/${ccy}`;
              const cEntry = tileCacheRef.current.cache.get(cKey);
              if (!cEntry || cEntry.status !== "loaded" || !cEntry.img) continue;
              const wx0 = startX + ccx * childSpanBlocks;
              const wz0 = startZ + ccy * childSpanBlocks;
              const sx = (wx0 - cWx) * ppb + cw / 2;
              const sy = (wz0 - cWz) * ppb + ch / 2;
              ctx.drawImage(cEntry.img, sx, sy, childSpanScreen, childSpanScreen);
              drewChild = true;
            }
          }
          if (drewChild) tilesWithFallback.add(fallbackKey(cx, cy));
        }
      }
    }

    // Main level pass. Reads from the cache only — actual `new Image()`
    // fetches are kicked off by `scheduleTileFetch` after a short idle so
    // a fast wheel-zoom across many levels doesn't fire 1000+ requests for
    // intermediate levels the user blows past.
    //
    // Tiles fade in over TILE_FADE_MS once they finish decoding so newly-
    // arrived imagery dissolves smoothly into genuinely-empty regions.
    // We skip the fade when a coarser/finer fallback was already drawn
    // for the same area — crossfading a sharper version over an existing
    // blurry version of the same imagery looks muddy; a hard swap reads
    // as a crisp focus-in instead. While anything is mid-fade we request
    // another animation frame so the alpha keeps progressing.
    const now = performance.now();
    let anyFading = false;
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const entry = tileCacheRef.current.cache.get(`${level}/${cx}/${cy}`);
        if (!entry || entry.status !== "loaded" || !entry.img) continue;
        const hadFallback = tilesWithFallback.has(fallbackKey(cx, cy));
        const age = entry.loadedAt != null ? now - entry.loadedAt : TILE_FADE_MS;
        const alpha = hadFallback || age >= TILE_FADE_MS ? 1 : Math.max(0, age / TILE_FADE_MS);
        if (alpha < 1) anyFading = true;
        const wx0 = startX + cx * tileSpanBlocks;
        const wz0 = startZ + cy * tileSpanBlocks;
        const sx = (wx0 - cWx) * ppb + cw / 2;
        const sy = (wz0 - cWz) * ppb + ch / 2;
        if (alpha < 1) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(entry.img, sx, sy, tileSpanScreen, tileSpanScreen);
          ctx.globalAlpha = 1;
        } else {
          ctx.drawImage(entry.img, sx, sy, tileSpanScreen, tileSpanScreen);
        }
      }
    }

    if (anyFading) scheduleRedraw();

    scheduleTileFetch();

    // ── Overlays ──────────────────────────────────────────────────────────
    // Painted on a separate canvas stacked above the tile canvas (and
    // above any DOM overlay slotted between the two — e.g. rock-strata),
    // so dynamic markers always stay on top regardless of overlay state.
    // From here on, all coordinates are already in screen-space px (the
    // projected* memos handle the world → screen conversion), so no
    // `ctx.translate / scale` is needed. Line widths and radii are
    // therefore quoted directly in screen pixels.
    const activeRadiusFilter = radiusFilterRef.current;
    let radiusCull: {
      cursorX: number;
      cursorY: number;
      radiusScreen: number;
      alwaysShowTLIds: ReadonlySet<string>;
    } | null = null;
    if (activeRadiusFilter) {
      const cursor = cursorWorldRef.current;
      const radiusScreen = activeRadiusFilter.radiusBlocks * ppb;
      // When the cursor is outside the canvas we still want to cull —
      // place the centre off-screen so only `alwaysShowTLIds` survive.
      const cursorX = cursor ? (cursor.x - cWx) * ppb + cw / 2 : -1e9;
      const cursorY = cursor ? (cursor.z - cWz) * ppb + ch / 2 : -1e9;
      radiusCull = {
        cursorX,
        cursorY,
        radiusScreen,
        alwaysShowTLIds: activeRadiusFilter.alwaysShowTLIds,
      };
    }
    // ── Player-claim density heatmap ──────────────────────────────────────
    // Precomputed raster (spawn-relative), blitted once. Panning only
    // re-scales the image, so this stays cheap however far you roam.
    if (claimDensity && claimDensity.opacity > 0) {
      const { canvas: dcanvas, originX, originZ, blocksPerCell, cols, rows } = claimDensity;
      const left = (originX - cWx) * ppb + cw / 2;
      const top = (originZ - cWz) * ppb + ch / 2;
      const w = cols * blocksPerCell * ppb;
      const h = rows * blocksPerCell * ppb;
      if (left < cw && top < ch && left + w > 0 && top + h > 0) {
        octx.save();
        octx.globalAlpha = claimDensity.opacity;
        octx.imageSmoothingEnabled = true;
        octx.drawImage(dcanvas, left, top, w, h);
        octx.restore();
      }
    }

    // ── Player-claim markers (search / all modes) ──────────────────────
    // In "search" the set is a single owner (labels always on); in "all" it's
    // every claim (owner label on hover only). Viewport-culled; hover-mode
    // positions are stashed for the pointer hit-test.
    if (playerClaimMarkers && playerClaimMarkers.length > 0) {
      const alwaysLabel = playerClaimLabelMode === "always" && playerClaimMarkers.length <= 60;
      const projected: Array<{ sx: number; sy: number; x: number; z: number; label: string }> = [];
      octx.save();
      octx.font = "600 11px system-ui, sans-serif";
      octx.textAlign = "center";
      octx.textBaseline = "bottom";
      for (const m of playerClaimMarkers) {
        const sx = (m.x - cWx) * ppb + cw / 2;
        const sy = (m.z - cWz) * ppb + ch / 2;
        if (sx < -40 || sx > cw + 40 || sy < -40 || sy > ch + 40) continue;
        const bx = (m.minX - cWx) * ppb + cw / 2;
        const by = (m.minZ - cWz) * ppb + ch / 2;
        const bw = Math.max(4, (m.maxX - m.minX) * ppb);
        const bh = Math.max(4, (m.maxZ - m.minZ) * ppb);
        octx.fillStyle = "rgba(244, 114, 182, 0.28)";
        octx.fillRect(bx, by, bw, bh);
        octx.lineWidth = 1.5;
        octx.strokeStyle = "rgba(236, 72, 153, 0.95)";
        octx.strokeRect(bx, by, bw, bh);
        octx.beginPath();
        octx.arc(sx, sy, 3, 0, Math.PI * 2);
        octx.fillStyle = "rgba(236, 72, 153, 1)";
        octx.fill();
        octx.lineWidth = 1;
        octx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        octx.stroke();
        const label = m.owner || m.description;
        if (alwaysLabel && label) {
          const tw = octx.measureText(label).width;
          octx.fillStyle = "rgba(15, 23, 42, 0.78)";
          octx.fillRect(sx - tw / 2 - 4, sy - 20, tw + 8, 15);
          octx.fillStyle = "#fff";
          octx.fillText(label, sx, sy - 6);
        }
        if (playerClaimLabelMode === "hover" && label) {
          projected.push({ sx, sy, x: m.x, z: m.z, label });
        }
      }
      // Hovered owner label on top (all-mode).
      if (playerClaimLabelMode === "hover" && hoveredPlayerClaim) {
        const hsx = (hoveredPlayerClaim.x - cWx) * ppb + cw / 2;
        const hsy = (hoveredPlayerClaim.z - cWz) * ppb + ch / 2;
        const label = hoveredPlayerClaim.label;
        const tw = octx.measureText(label).width;
        octx.fillStyle = "rgba(15, 23, 42, 0.9)";
        octx.fillRect(hsx - tw / 2 - 4, hsy - 20, tw + 8, 15);
        octx.fillStyle = "#fff";
        octx.fillText(label, hsx, hsy - 6);
      }
      octx.restore();
      projectedPlayerClaimsRef.current = projected;
    } else {
      projectedPlayerClaimsRef.current = [];
    }

    // ── Trader-claim dots ─────────────────────────────────────────────────
    // Drawn under the TL/trader overlays so real trader markers stay on top.
    // Projected + viewport-culled here (rather than in a memo) so panning a
    // large claim field never allocates thousands of objects per frame, and
    // zoom-gated so the world isn't a wall of dots when fully zoomed out.
    {
      const claims = claimMarkers;
      const projected: Array<{
        claimId: string;
        sx: number;
        sy: number;
        center: { x: number; y: number; z: number };
      }> = [];
      if (claims && claims.length > 0 && ppb >= CLAIM_MIN_PIXELS_PER_BLOCK) {
        const margin = 8;
        // zoom = 1 → constant on-screen size, matching the trader markers
        // (which pass zoom = 1). Previously scaled with ppb, so the dots
        // shrank the further you zoomed out.
        const zoom = 1;
        const types = claimTypes;
        for (const c of claims) {
          const sx = (c.x - cWx) * ppb + cw / 2;
          const sy = (c.z - cWz) * ppb + ch / 2;
          if (sx < -margin || sx > cw + margin || sy < -margin || sy > ch + margin) continue;
          const assigned = types?.[c.claimId];
          const color = assigned ? traderColors[assigned.trader_type] : CLAIM_UNCLASSIFIED_COLOR;
          const isHot = c.claimId === hoveredClaimId || c.claimId === claimPopover?.claimId;
          drawClaimDot(octx, sx, sy, zoom, color, isHot);
          projected.push({ claimId: c.claimId, sx, sy, center: c.center });
        }
      }
      projectedClaimsRef.current = projected;
    }
    drawOverlaysScreenSpace(octx, {
      segments: projectedSegments,
      points: projectedPoints,
      route: projectedRoute,
      hoveredSegmentIndex,
      highlightedSegmentIndices,
      routeTLBaseSkipIndices,
      tlStyle,
      traderStyle,
      terminusStyle,
      radiusCull,
    });

    // Subtle outline showing the active radius. Drawn after the TL
    // overlays so it sits above the lines/dots; only when the cursor is
    // actually over the canvas (the off-screen sentinel above would
    // otherwise paint a circle at -1e9, but that's culled by the canvas
    // anyway — we skip drawing for clarity).
    if (radiusCull && cursorWorldRef.current) {
      octx.save();
      octx.beginPath();
      octx.arc(radiusCull.cursorX, radiusCull.cursorY, radiusCull.radiusScreen, 0, Math.PI * 2);
      octx.lineWidth = 1.5;
      octx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      octx.setLineDash([6, 4]);
      octx.stroke();
      octx.setLineDash([]);
      octx.lineWidth = 1;
      octx.strokeStyle = "rgba(15, 23, 42, 0.45)";
      octx.stroke();
      octx.restore();
    }

    // ── Hover-point labels ────────────────────────────────────────────────
    if (projectedPoints.length > 0) {
      drawPointLabels(octx, projectedPoints, cw, ch);
    }
  };

  // Trigger redraw whenever anything that affects the picture changes.
  useEffect(() => {
    scheduleRedraw();
  }, [
    scheduleRedraw,
    pixelsPerBlock,
    centerWorldX,
    centerWorldZ,
    containerSize.w,
    containerSize.h,
    currentZoomLevel,
    projectedSegments,
    projectedPoints,
    projectedRoute,
    hoveredSegmentIndex,
    highlightedSegmentIndices,
    routeTLBaseSkipIndices,
    tlStyle,
    traderStyle,
    terminusStyle,
    traderColors,
    claimMarkers,
    claimTypes,
    claimDensity,
    playerClaimMarkers,
    playerClaimLabelMode,
    hoveredPlayerClaim,
    hoveredClaimId,
    claimPopover,
  ]);

  // Continuous redraw while a focused walk leg exists, so its pulsing
  // highlight animates. The draw itself derives phase from
  // `performance.now()`, so we just need to keep scheduling frames.
  useEffect(() => {
    const key = projectedRoute?.focusedWalkLegKey;
    if (!key) return;
    let raf = 0;
    const tick = () => {
      scheduleRedraw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [projectedRoute?.focusedWalkLegKey, scheduleRedraw]);

  // Cleanup any pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (redrawHandleRef.current != null) {
        cancelAnimationFrame(redrawHandleRef.current);
      }
      if (fetchTimeoutRef.current != null) {
        window.clearTimeout(fetchTimeoutRef.current);
      }
    };
  }, []);

  // Register the WC tile service worker on mount when the user has the
  // preference enabled (Account → Appearance → "Cache map tiles"). The
  // SW transparently caches `<img>` requests for
  // `*/data/world/{z}/{x}_{y}.png` in a persistent Cache Storage bucket
  // so reloads (and even re-visits days later) skip the network for
  // already-seen tiles. Cache invalidation is driven by the page via
  // `notifyWCTileCacheVersion(...)` whenever the upstream
  // landmarks/translocators `Last-Modified` advances. When the user
  // turns the toggle off we unregister + wipe so subsequent tile
  // requests go straight to the network.
  const wcTileCacheEnabled = useReduxState("mapView.wcTileCacheEnabled");
  useEffect(() => {
    if (wcTileCacheEnabled) {
      void registerWCTileServiceWorker();
    } else {
      void disableWCTileCache();
    }
  }, [wcTileCacheEnabled]);

  // ── Smooth camera animation ──────────────────────────────────────────────
  // Used by focusPoint / Reset / Centre / search-landmark navigation so the
  // viewport eases to the target instead of teleporting. Cancels itself the
  // moment the user touches the wheel / starts a drag so input always wins.
  const flyAnimRef = useRef<number | null>(null);
  const cancelFlyAnim = useCallback(() => {
    if (flyAnimRef.current != null) {
      cancelAnimationFrame(flyAnimRef.current);
      flyAnimRef.current = null;
    }
  }, []);
  const animateCameraTo = useCallback(
    (targetCx: number, targetCz: number, targetPpb: number) => {
      cancelFlyAnim();
      const clampedPpb = Math.min(MAX_PIXELS_PER_BLOCK, Math.max(MIN_PIXELS_PER_BLOCK, targetPpb));
      const startCx = centerWorldXRef.current;
      const startCz = centerWorldZRef.current;
      const startPpb = pixelsPerBlockRef.current;
      const dCx = targetCx - startCx;
      const dCz = targetCz - startCz;
      // Animate scale in log-space so each frame's perceived zoom change is
      // constant — linear-in-ppb feels glacial at low zooms and abrupt at
      // high zooms.
      const startLog = Math.log(startPpb);
      const endLog = Math.log(clampedPpb);
      const dLog = endLog - startLog;

      // Screen-space distance the centre will traverse, in *target* px.
      // Used to size the animation duration so long jumps still feel snappy.
      const screenDist = Math.hypot(dCx * clampedPpb, dCz * clampedPpb);
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const negligible =
        Math.abs(dCx) * clampedPpb < 0.5 &&
        Math.abs(dCz) * clampedPpb < 0.5 &&
        Math.abs(dLog) < 0.001;
      if (prefersReducedMotion || negligible) {
        setCenterWorldX(targetCx);
        setCenterWorldZ(targetCz);
        setPixelsPerBlock(clampedPpb);
        return;
      }
      const duration = Math.min(700, Math.max(260, screenDist * 0.5));
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const startTs = performance.now();
      const step = (now: number) => {
        const tNorm = Math.min(1, (now - startTs) / duration);
        const k = ease(tNorm);
        setCenterWorldX(startCx + dCx * k);
        setCenterWorldZ(startCz + dCz * k);
        setPixelsPerBlock(Math.exp(startLog + dLog * k));
        if (tNorm < 1) {
          flyAnimRef.current = requestAnimationFrame(step);
        } else {
          flyAnimRef.current = null;
        }
      };
      flyAnimRef.current = requestAnimationFrame(step);
    },
    [cancelFlyAnim],
  );
  useEffect(() => () => cancelFlyAnim(), [cancelFlyAnim]);

  // ── Initial view ─────────────────────────────────────────────────────────
  const initialViewAppliedRef = useRef(false);
  useEffect(() => {
    if (initialViewAppliedRef.current) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;
    if (!initialView) {
      initialViewAppliedRef.current = true;
      return;
    }
    const { centerWorldX: cx, centerWorldZ: cz, pixelsPerBlock: ppb } = initialView;
    if (![cx, cz, ppb].every(Number.isFinite) || ppb <= 0) {
      initialViewAppliedRef.current = true;
      return;
    }
    setCenterWorldX(cx);
    setCenterWorldZ(cz);
    setPixelsPerBlock(Math.min(MAX_PIXELS_PER_BLOCK, Math.max(MIN_PIXELS_PER_BLOCK, ppb)));
    initialViewAppliedRef.current = true;
  }, [initialView, containerSize.w, containerSize.h]);

  // ── focusPoint navigation ────────────────────────────────────────────────
  const prevFocusPointRef = useRef<{ x: number; z: number } | undefined>(undefined);
  useEffect(() => {
    if (!focusPoint) return;
    if (prevFocusPointRef.current === focusPoint) return;
    prevFocusPointRef.current = focusPoint;
    if (containerSize.w === 0 || containerSize.h === 0) return;

    let targetPpb: number;
    if (focusSpanBlocks && focusSpanBlocks > 0) {
      const minViewportPx = Math.min(containerSize.w, containerSize.h);
      targetPpb = (minViewportPx * 0.85) / Math.max(1, focusSpanBlocks);
      targetPpb = Math.min(MAX_PIXELS_PER_BLOCK, Math.max(MIN_PIXELS_PER_BLOCK, targetPpb));
    } else {
      // `focusZoom` from the legacy API: a multiplier vs the initial scale.
      targetPpb = Math.max(pixelsPerBlockRef.current, INITIAL_PIXELS_PER_BLOCK * focusZoom);
    }
    animateCameraTo(focusPoint.x, focusPoint.z, targetPpb);
  }, [focusPoint, focusSpanBlocks, focusZoom, containerSize.w, containerSize.h, animateCameraTo]);

  // ── Viewport-change reporting (debounced) ────────────────────────────────
  useEffect(() => {
    if (!onViewportChange) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;
    const handle = setTimeout(() => {
      const halfWBlocks = containerSize.w / 2 / pixelsPerBlock;
      const halfHBlocks = containerSize.h / 2 / pixelsPerBlock;
      onViewportChange({
        centerWorldX,
        centerWorldZ,
        pixelsPerBlock,
        worldMinX: centerWorldX - halfWBlocks,
        worldMaxX: centerWorldX + halfWBlocks,
        worldMinZ: centerWorldZ - halfHBlocks,
        worldMaxZ: centerWorldZ + halfHBlocks,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [
    onViewportChange,
    pixelsPerBlock,
    centerWorldX,
    centerWorldZ,
    containerSize.w,
    containerSize.h,
  ]);

  // ── Zoom helpers ─────────────────────────────────────────────────────────
  /**
   * Zoom toward a screen-space focal point — pinning the world coord under
   * `(focalX, focalY)` so it stays put while the scale changes.
   */
  const zoomToward = useCallback(
    (focalX: number, focalY: number, nextPpb: number) => {
      const clamped = Math.min(MAX_PIXELS_PER_BLOCK, Math.max(MIN_PIXELS_PER_BLOCK, nextPpb));
      if (clamped === pixelsPerBlockRef.current) return;
      const oldPpb = pixelsPerBlockRef.current;
      const w = containerSize.w || 1;
      const h = containerSize.h || 1;
      // World coord under the focal point before the zoom change.
      const worldX = (focalX - w / 2) / oldPpb + centerWorldXRef.current;
      const worldZ = (focalY - h / 2) / oldPpb + centerWorldZRef.current;
      // Recompute centre so that the same world point lands at the same
      // screen coord with the new scale.
      const newCx = worldX - (focalX - w / 2) / clamped;
      const newCz = worldZ - (focalY - h / 2) / clamped;
      setPixelsPerBlock(clamped);
      setCenterWorldX(newCx);
      setCenterWorldZ(newCz);
    },
    [containerSize.w, containerSize.h],
  );

  const zoomIn = useCallback(() => {
    zoomToward(
      containerSize.w / 2,
      containerSize.h / 2,
      pixelsPerBlockRef.current * BUTTON_ZOOM_FACTOR,
    );
  }, [zoomToward, containerSize.w, containerSize.h]);

  const zoomOut = useCallback(() => {
    zoomToward(
      containerSize.w / 2,
      containerSize.h / 2,
      pixelsPerBlockRef.current / BUTTON_ZOOM_FACTOR,
    );
  }, [zoomToward, containerSize.w, containerSize.h]);

  const resetView = useCallback(() => {
    animateCameraTo(0, 0, INITIAL_PIXELS_PER_BLOCK);
  }, [animateCameraTo]);

  const centerOnOrigin = useCallback(() => {
    const target =
      centerTarget && Number.isFinite(centerTarget.x) && Number.isFinite(centerTarget.z)
        ? centerTarget
        : { x: 0, z: 0 };
    animateCameraTo(target.x, target.z, pixelsPerBlockRef.current);
  }, [animateCameraTo, centerTarget]);

  // ── Wheel zoom (non-passive so we can preventDefault) ────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelFlyAnim();
      const rect = el.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      zoomToward(focalX, focalY, pixelsPerBlockRef.current * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomToward, cancelFlyAnim]);

  // ── Pointer interaction (mouse / touch / pen) ────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Mouse: only the primary (left) button drags. Touch/pen always pass.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (interactionsLockedRef.current) return;
      if (cursorModeRef.current === "pick") return;
      const container = containerRef.current;
      container?.setPointerCapture?.(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelFlyAnim();

      if (pointersRef.current.size >= 2) {
        // Second finger down — start a pinch and suspend panning.
        const pts = Array.from(pointersRef.current.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        pinchRef.current = {
          startDist: Math.hypot(dx, dy) || 1,
          startPpb: pixelsPerBlockRef.current,
        };
        setDragging(false);
        dragStartRef.current = null;
        // Treat the gesture as a drag so the trailing click (fired on the
        // last finger's release) doesn't pin a random TL / claim.
        dragMaxDistRef.current = 999;
        return;
      }

      setDragging(true);
      dragMaxDistRef.current = 0;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        cwX: centerWorldXRef.current,
        cwZ: centerWorldZRef.current,
      };
    },
    [cancelFlyAnim],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Keep the tracked pointer position fresh for pinch math.
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      // Two-finger pinch: scale relative to the gesture start, pinned to the
      // midpoint between the fingers. Skips all the hover hit-testing below.
      if (pinchRef.current && pointersRef.current.size >= 2) {
        const pts = Array.from(pointersRef.current.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy) || 1;
        const focalX = (pts[0].x + pts[1].x) / 2 - rect.left;
        const focalY = (pts[0].y + pts[1].y) / 2 - rect.top;
        zoomToward(focalX, focalY, pinchRef.current.startPpb * (dist / pinchRef.current.startDist));
        return;
      }

      if (dragging && dragStartRef.current) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist > dragMaxDistRef.current) dragMaxDistRef.current = dist;
        const ppb = pixelsPerBlockRef.current;
        setCenterWorldX(dragStartRef.current.cwX - dx / ppb);
        setCenterWorldZ(dragStartRef.current.cwZ - dy / ppb);
      }

      // Hover coord readout.
      const world = unprojectScreen(sx, sy);
      const hx = Math.floor(world.x);
      const hz = Math.floor(world.z);
      setHoverCoords({ x: hx, z: hz });
      cursorWorldRef.current = { x: world.x, z: world.z };
      onHoverCoords?.({ x: hx, z: hz });
      // When the radius cull is active, the visible TL set depends on the
      // cursor position — redraw every mousemove so the filter follows.
      if (radiusFilterRef.current) scheduleRedraw();

      // Hover-on-segment hit test in screen space.
      if (projectedSegments.length > 0) {
        const threshold = 8;
        const thresholdSq = threshold * threshold;
        // When the radius cull is active, segments outside the radius (and
        // not in alwaysShow) are not drawn — make hovering them a no-op
        // too, so the cursor doesn't snap to invisible lines.
        const filt = radiusFilterRef.current;
        const cur = cursorWorldRef.current;
        const ppb = pixelsPerBlockRef.current;
        const radSqScreen = filt ? (filt.radiusBlocks * ppb) ** 2 : 0;
        const curScreen = cur
          ? {
              x:
                (cur.x - centerWorldXRef.current) * ppb +
                (containerRef.current?.clientWidth ?? 0) / 2,
              y:
                (cur.z - centerWorldZRef.current) * ppb +
                (containerRef.current?.clientHeight ?? 0) / 2,
            }
          : null;
        let best = -1;
        let bestDistSq = Infinity;
        for (let i = 0; i < projectedSegments.length; i++) {
          const seg = projectedSegments[i];
          if (filt && curScreen) {
            if (!filt.alwaysShowTLIds.has(seg.tlId)) {
              const dx1 = seg.x1 - curScreen.x;
              const dy1 = seg.y1 - curScreen.y;
              const dx2 = seg.x2 - curScreen.x;
              const dy2 = seg.y2 - curScreen.y;
              if (dx1 * dx1 + dy1 * dy1 > radSqScreen && dx2 * dx2 + dy2 * dy2 > radSqScreen) {
                continue;
              }
            }
          } else if (filt && !filt.alwaysShowTLIds.has(seg.tlId)) {
            // Cursor is outside the canvas / no live cursor — only
            // alwaysShow TLs are drawn, so only those are hoverable.
            continue;
          }
          const abx = seg.x2 - seg.x1;
          const aby = seg.y2 - seg.y1;
          const apx = sx - seg.x1;
          const apy = sy - seg.y1;
          const abLenSq = abx * abx + aby * aby;
          const t = abLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq)) : 0;
          const cxp = seg.x1 + t * abx;
          const cyp = seg.y1 + t * aby;
          const ddx = sx - cxp;
          const ddy = sy - cyp;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq < thresholdSq && dsq < bestDistSq) {
            bestDistSq = dsq;
            best = i;
          }
        }
        setHoveredSegmentIndex(best === -1 ? null : best);
      } else if (hoveredSegmentIndex !== null) {
        setHoveredSegmentIndex(null);
      }

      // Per-marker tooltip hit-test (screen space): nearest point marker that
      // carries a `tooltip` payload within ~14px of the cursor.
      if (projectedPoints.length > 0) {
        const threshold = 14;
        const thresholdSq = threshold * threshold;
        let bestTip: { x: number; y: number; z: number } | null = null;
        let bestDistSq = Infinity;
        for (const p of projectedPoints) {
          if (!p.tooltip) continue;
          const ddx = sx - p.x;
          const ddy = sy - p.y;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq < thresholdSq && dsq < bestDistSq) {
            bestDistSq = dsq;
            bestTip = p.tooltip;
          }
        }
        setHoveredPointTooltip(
          bestTip ? { left: sx, top: sy, x: bestTip.x, y: bestTip.y, z: bestTip.z } : null,
        );
      } else if (hoveredPointTooltip) {
        setHoveredPointTooltip(null);
      }

      // Trader-claim dot hover (screen-space) — thickens the dot outline.
      if (claimMarkingEnabled) {
        const claimThreshSq = 12 * 12;
        let hot: string | null = null;
        let bestClaimSq = Infinity;
        for (const c of projectedClaimsRef.current) {
          const ddx = sx - c.sx;
          const ddy = sy - c.sy;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq < claimThreshSq && dsq < bestClaimSq) {
            bestClaimSq = dsq;
            hot = c.claimId;
          }
        }
        if (hot !== hoveredClaimIdRef.current) {
          hoveredClaimIdRef.current = hot;
          setHoveredClaimId(hot);
          scheduleRedraw();
        }
      }

      // Player-claim hover (all-mode): surface the owner label for the
      // nearest claim within ~14px.
      if (playerClaimMarkers && playerClaimMarkers.length > 0 && playerClaimLabelMode === "hover") {
        const threshSq = 14 * 14;
        let hot: { x: number; z: number; label: string } | null = null;
        let bestSq = Infinity;
        for (const c of projectedPlayerClaimsRef.current) {
          const ddx = sx - c.sx;
          const ddy = sy - c.sy;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq < threshSq && dsq < bestSq) {
            bestSq = dsq;
            hot = { x: c.x, z: c.z, label: c.label };
          }
        }
        const prev = hoveredPlayerClaimRef.current;
        const key = hot ? `${hot.x},${hot.z},${hot.label}` : null;
        const prevKey = prev ? `${prev.x},${prev.z},${prev.label}` : null;
        if (key !== prevKey) {
          hoveredPlayerClaimRef.current = hot;
          setHoveredPlayerClaim(hot);
          scheduleRedraw();
        }
      } else if (hoveredPlayerClaimRef.current !== null) {
        hoveredPlayerClaimRef.current = null;
        setHoveredPlayerClaim(null);
        scheduleRedraw();
      }
    },
    [
      dragging,
      projectedSegments,
      projectedPoints,
      hoveredPointTooltip,
      claimMarkingEnabled,
      playerClaimMarkers,
      playerClaimLabelMode,
      unprojectScreen,
      hoveredSegmentIndex,
      onHoverCoords,
      scheduleRedraw,
      zoomToward,
    ],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    containerRef.current?.releasePointerCapture?.(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      // One finger lifted mid-pinch — resume panning from the survivor so
      // the map doesn't jump.
      const [only] = Array.from(pointersRef.current.values());
      setDragging(true);
      dragMaxDistRef.current = 0;
      dragStartRef.current = {
        x: only.x,
        y: only.y,
        cwX: centerWorldXRef.current,
        cwZ: centerWorldZRef.current,
      };
    } else if (pointersRef.current.size === 0) {
      setDragging(false);
      dragStartRef.current = null;
    }
  }, []);
  const handlePointerLeave = useCallback(() => {
    setHoverCoords(null);
    cursorWorldRef.current = null;
    onHoverCoords?.(null);
    setHoveredSegmentIndex(null);
    setHoveredPointTooltip(null);
    if (hoveredClaimIdRef.current !== null) {
      hoveredClaimIdRef.current = null;
      setHoveredClaimId(null);
    }
    if (hoveredPlayerClaimRef.current !== null) {
      hoveredPlayerClaimRef.current = null;
      setHoveredPlayerClaim(null);
    }
    if (radiusFilterRef.current) scheduleRedraw();
  }, [onHoverCoords, scheduleRedraw]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Suppress "click" when the gesture was actually a pan. Spawn is so
      // TL-dense that almost every drag would otherwise pin a random TL.
      // 4 CSS px matches the browser's own click-vs-drag threshold.
      const wasDrag = dragMaxDistRef.current > 4;
      dragMaxDistRef.current = 0;
      if (wasDrag) return;
      if (cursorModeRef.current === "pick" && onWorldClick) {
        const world = unprojectScreen(sx, sy);
        onWorldClick(Math.floor(world.x), Math.floor(world.z));
        return;
      }
      // Trader-claim marking: a click on a claim dot opens the type picker;
      // a click elsewhere dismisses an open picker. Only users who can
      // contribute (or admins) may open the picker at all.
      if (claimMarkingEnabled && canMarkClaimsRef.current) {
        const claimThreshSq = 12 * 12;
        let hit: { claimId: string; center: { x: number; y: number; z: number } } | null = null;
        let bestSq = Infinity;
        for (const c of projectedClaimsRef.current) {
          const ddx = sx - c.sx;
          const ddy = sy - c.sy;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq < claimThreshSq && dsq < bestSq) {
            bestSq = dsq;
            hit = { claimId: c.claimId, center: c.center };
          }
        }
        if (hit) {
          setClaimPopover({ claimId: hit.claimId, center: hit.center, left: sx, top: sy });
          return;
        }
        setClaimPopover(null);
      }
      if (!onOverlaySegmentClick || !overlaySegments || overlaySegments.length === 0) return;
      if (hoveredSegmentIndex === null) {
        onOverlaySegmentClick(null);
        return;
      }
      onOverlaySegmentClick(overlaySegments[hoveredSegmentIndex] ?? null);
    },
    [
      hoveredSegmentIndex,
      onOverlaySegmentClick,
      onWorldClick,
      overlaySegments,
      unprojectScreen,
      claimMarkingEnabled,
    ],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onOverlaySegmentRightClick || !overlaySegments || overlaySegments.length === 0) return;
      if (hoveredSegmentIndex === null) return;
      const seg = overlaySegments[hoveredSegmentIndex];
      if (!seg) return;
      e.preventDefault();
      onOverlaySegmentRightClick(seg);
    },
    [hoveredSegmentIndex, onOverlaySegmentRightClick, overlaySegments],
  );

  // ── Canvas-class assembly ────────────────────────────────────────────────
  const canvasClass = [
    "relative overflow-hidden",
    starfield ? "starfield" : "bg-black/90",
    bordered ? "rounded-md border" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Overlay-render transform ─────────────────────────────────────────────
  // overlayRender returns image-space JSX (e.g. OceansOverlayLayer's SVG
  // sized to imgNatural.w × imgNatural.h). We project the world origin to
  // its screen coordinate and apply the per-block scale; the result lines
  // up pixel-for-pixel with the tile draw above.
  const overlayTransform = useMemo<CSSProperties>(() => {
    const origin = projectWorld(WC_STATS.start_x, WC_STATS.start_z);
    const scale = (pixelsPerBlock * WC_STATS.width_blocks) / imgNatural.w;
    return {
      position: "absolute",
      left: 0,
      top: 0,
      transformOrigin: "0 0",
      transform: `translate3d(${origin.x}px, ${origin.y}px, 0) scale(${scale})`,
      width: imgNatural.w,
      height: imgNatural.h,
      // Pointer events stay enabled so individual children inside the
      // overlay (e.g. SVG layers that attach their own click handlers) can
      // still receive input. The wrapping container's drag handlers receive
      // events that bubble up from the overlay just like a normal child.
      willChange: "transform",
    };
  }, [projectWorld, pixelsPerBlock, imgNatural.w, imgNatural.h]);

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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={centerOnOrigin}
          title={
            centerTarget
              ? t("topsMap.centerOnCoordinate", { x: centerTarget.x, z: centerTarget.z })
              : t("topsMap.centerOnOrigin")
          }
        >
          <Crosshair className="size-4" />
        </Button>
        <span className="hidden sm:inline text-xs text-muted-foreground ml-2">
          {t("topsMap.scrollToZoomDragToPan")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {showFullscreenControl && !isFullscreen && (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="hidden sm:inline-flex"
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
        draggable={false}
        style={{
          height,
          cursor:
            cursorMode === "pick"
              ? "crosshair"
              : dragging
                ? "grabbing"
                : hoveredSegmentIndex !== null
                  ? "pointer"
                  : "grab",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        // A native drag (of the overlay SVG/img children) would fire
        // pointercancel and abort the pan; suppress it so mouse drags pan
        // continuously.
        onDragStart={(e) => e.preventDefault()}
        aria-label={alt}
        role="img"
      >
        {showFullscreenControl && !isFullscreen && (
          // Mobile: a floating fullscreen button on the map itself, so it's
          // always reachable without hunting through the wrapped toolbar.
          // `stopPropagation` on pointerdown keeps the container's drag
          // handler from pointer-capturing the tap (which would swallow the
          // button's click on touch).
          <Button
            type="button"
            variant="default"
            size="icon"
            className="sm:hidden absolute top-2 right-2 z-20 shadow-lg"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setIsFullscreen(true)}
            aria-label={t("topsMap.enterFullscreenMapView")}
            title={t("topsMap.enterFullscreenMapView")}
          >
            <Maximize2 className="size-5" />
          </Button>
        )}
        {(overlay || overlayRender) && (
          // Rendered BEFORE the canvas in DOM order so it stacks below the
          // tile layer — but above the container's background. WC tiles are
          // sparse PNGs (404 in unexplored cells), so the oceans / other
          // image-space overlays show through wherever no tile imagery
          // exists, exactly like on the original WebCartographer UI.
          <div style={overlayTransform}>
            {overlay}
            {overlayRender?.({ zoom: pixelsPerBlock, imgNatural, stats: WC_STATS })}
          </div>
        )}
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
        {(overlayAbove || overlayRenderAbove) && (
          // Rendered between the tile canvas and the overlay canvas so it
          // covers the painted tiles but stays beneath dynamic overlays
          // (TLs, landmarks, traders, route). Same image-space transform
          // as the below-canvas overlay.
          <div style={overlayTransform}>
            {overlayAbove}
            {overlayRenderAbove?.({ zoom: pixelsPerBlock, imgNatural, stats: WC_STATS })}
          </div>
        )}
        <canvas ref={overlayCanvasRef} className="absolute inset-0 pointer-events-none" />
        {hoverCoords && (
          <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2.5 py-1 text-xs font-mono text-white pointer-events-none">
            X: {hoverCoords.x} &nbsp; Z: {hoverCoords.z}
          </div>
        )}
        {hoveredPointTooltip && (
          <div
            className="absolute z-20 rounded bg-black/85 px-2 py-1 text-xs font-mono text-white pointer-events-none whitespace-nowrap shadow-lg"
            style={{
              left: hoveredPointTooltip.left + 14,
              top: hoveredPointTooltip.top + 14,
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-red-300">
              Broken TL
            </div>
            <div>
              X: {Math.round(hoveredPointTooltip.x)} &nbsp; Y: {Math.round(hoveredPointTooltip.y)}
              &nbsp; Z: {Math.round(hoveredPointTooltip.z)}
            </div>
          </div>
        )}
        {claimPopover && (
          <div
            className="absolute z-30 w-56 rounded-md border border-white/15 bg-slate-900/95 p-2 text-xs text-white shadow-xl"
            style={{
              left: Math.max(4, Math.min(claimPopover.left + 12, containerSize.w - 232)),
              top: Math.max(4, Math.min(claimPopover.top + 12, containerSize.h - 220)),
            }}
            // Keep the container from pointer-capturing the press, which would
            // otherwise swallow the picker buttons' click (so the mutation
            // never fires). Same guard the mobile fullscreen button uses.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold">{t("topsMap.claimMarkTitle")}</span>
              <button
                type="button"
                aria-label={t("topsMap.claimMarkClose")}
                className="px-1 text-white/60 hover:text-white"
                onClick={() => setClaimPopover(null)}
              >
                ×
              </button>
            </div>
            {claimTypes?.[claimPopover.claimId] && (
              <div className="mb-1.5 text-[10px] text-white/60">
                {t("topsMap.claimCurrentType")}:{" "}
                <span className="text-white/90">
                  {TRADER_TYPE_LABELS[claimTypes[claimPopover.claimId].trader_type]}
                </span>
              </div>
            )}
            {canMarkClaims ? (
              <div className="grid grid-cols-1 gap-1">
                {TRADER_TYPES.map((tt) => (
                  <button
                    key={tt}
                    type="button"
                    disabled={claimMutation.isPending}
                    onClick={() =>
                      claimMutation.mutate({
                        claim_id: claimPopover.claimId,
                        trader_type: tt,
                        center: claimPopover.center,
                      })
                    }
                    className="flex items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10 disabled:opacity-50"
                  >
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-black/40"
                      style={{ backgroundColor: traderColors[tt] }}
                    />
                    <span>{TRADER_TYPE_LABELS[tt]}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-amber-300">{t("topsMap.claimSignInHint")}</div>
            )}
            {claimMutation.isError && (
              <div className="mt-1 text-[11px] text-red-400">{t("topsMap.claimMarkError")}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a `#rgb` / `#rrggbb` string into an `rgba(r, g, b, alpha)` literal.
 *  Falls back to white on malformed input rather than throwing — bad colors
 *  shouldn't blank the canvas. */
function rgbaFromHex(hex: string, alpha: number): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  let r = 255;
  let g = 255;
  let b = 255;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    r = g = b = 255;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface OverlayDrawArgs {
  segments: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** Canonical TL id (`${x1},${z1},${x2},${z2}`) used by the radius
     *  cull's `alwaysShowTLIds` lookup. */
    tlId: string;
    kind?: "default" | "user";
    /** Optional per-segment color override (hex like `#a855f7`). When set,
     *  the segment skips the default purple/blue pass and is drawn with this
     *  color (and a derived translucent glow) instead. */
    color?: string;
  }>;
  points: Array<{ x: number; y: number; label?: string; kind?: string; color?: string }>;
  route: {
    tlSegs: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    walkLegs: Array<{
      key?: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      elkState?: RouteOverlay["walkLegs"][number]["elkState"];
    }>;
    from: { x: number; y: number } | null;
    to: { x: number; y: number } | null;
    tlIdSet: Set<string>;
    focusedWalkLegKey?: string | null;
  } | null;
  hoveredSegmentIndex: number | null;
  highlightedSegmentIndices: Set<number>;
  routeTLBaseSkipIndices: Set<number>;
  tlStyle: string;
  traderStyle: string;
  terminusStyle: string;
  /**
   * Optional cursor-radius cull. When non-null, segments whose `tlId`
   * is not in `alwaysShowTLIds` AND whose endpoints are both farther
   * than `radiusScreen` (screen px) from `(cursorX, cursorY)` are
   * skipped entirely (no line, no glow, no portal dots, no hover/
   * highlight outline).
   */
  radiusCull?: {
    cursorX: number;
    cursorY: number;
    radiusScreen: number;
    alwaysShowTLIds: ReadonlySet<string>;
  } | null;
}

/**
 * Draws every overlay layer onto the provided context using already-projected
 * screen-space coordinates. Mirrors the visual style of the Cairn-backed
 * {@link MapViewer}; sizes are quoted directly in screen px (no zoom
 * compensation needed since the canvas is screen-space).
 *
 * The marker helpers (`drawTLEndpoint`, `drawTraderMarker`,
 * `drawTerminusMarker`) expect an image-space zoom argument that they divide
 * radii by — they were written for the image-space canvas in MapViewer.
 * We pass `1` so radii are interpreted in CSS px directly, which is exactly
 * what we want for a screen-space canvas.
 */
function drawOverlaysScreenSpace(ctx: CanvasRenderingContext2D, args: OverlayDrawArgs): void {
  const {
    segments,
    points,
    route,
    hoveredSegmentIndex,
    highlightedSegmentIndices,
    routeTLBaseSkipIndices,
    tlStyle,
    traderStyle,
    terminusStyle,
    radiusCull,
  } = args;

  if (segments.length === 0 && points.length === 0 && !route) return;

  // Pre-compute the cursor-radius cull set: segments whose `tlId` is not
  // in `alwaysShowTLIds` and whose endpoints are both outside the radius
  // get skipped in every pass below (line/glow/hover/highlight/dots).
  let cullSkipIndices: Set<number> | null = null;
  if (radiusCull && segments.length > 0) {
    cullSkipIndices = new Set<number>();
    const { cursorX, cursorY, radiusScreen, alwaysShowTLIds } = radiusCull;
    const radSq = radiusScreen * radiusScreen;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (alwaysShowTLIds.has(s.tlId)) continue;
      const dx1 = s.x1 - cursorX;
      const dy1 = s.y1 - cursorY;
      if (dx1 * dx1 + dy1 * dy1 <= radSq) continue;
      const dx2 = s.x2 - cursorX;
      const dy2 = s.y2 - cursorY;
      if (dx2 * dx2 + dy2 * dy2 <= radSq) continue;
      cullSkipIndices.add(i);
    }
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const baseLineColor = "rgba(139, 92, 246, 0.95)";
  const hoverLineColor = "rgba(243, 232, 255, 1)";
  const glowColor = "rgba(76, 29, 149, 0.55)";
  const portalOuter = "rgba(168, 85, 247, 0.95)";
  const userLineColor = "rgba(37, 99, 235, 0.95)";
  const userGlowColor = "rgba(30, 58, 138, 0.55)";
  const userPortalOuter = "rgba(59, 130, 246, 0.95)";

  const baseWidth = 2.3;
  const glowWidth = baseWidth * 2.4;

  // ── Translocator segments ────────────────────────────────────────────────
  if (segments.length > 0) {
    const defaultSegs: typeof segments = [];
    const userSegs: typeof segments = [];
    /** Per-color buckets for `color`-overridden segments. */
    const colorBuckets = new Map<string, typeof segments>();
    for (let i = 0; i < segments.length; i++) {
      if (routeTLBaseSkipIndices.has(i)) continue;
      if (cullSkipIndices?.has(i)) continue;
      const s = segments[i];
      if (s.color) {
        let bucket = colorBuckets.get(s.color);
        if (!bucket) {
          bucket = [];
          colorBuckets.set(s.color, bucket);
        }
        bucket.push(s);
      } else if (s.kind === "user") userSegs.push(s);
      else defaultSegs.push(s);
    }
    const drawPass = (segs: typeof segments, line: string, glow: string) => {
      if (segs.length === 0) return;
      ctx.strokeStyle = glow;
      ctx.lineWidth = glowWidth;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      ctx.strokeStyle = line;
      ctx.lineWidth = baseWidth;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
    };
    drawPass(defaultSegs, baseLineColor, glowColor);
    drawPass(userSegs, userLineColor, userGlowColor);
    for (const [hex, segs] of colorBuckets) {
      drawPass(segs, rgbaFromHex(hex, 0.95), rgbaFromHex(hex, 0.45));
    }

    if (
      hoveredSegmentIndex !== null &&
      segments[hoveredSegmentIndex] &&
      !cullSkipIndices?.has(hoveredSegmentIndex)
    ) {
      const s = segments[hoveredSegmentIndex];
      ctx.strokeStyle = hoverLineColor;
      ctx.lineWidth = baseWidth * 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
    if (highlightedSegmentIndices.size > 0) {
      ctx.strokeStyle = hoverLineColor;
      ctx.lineWidth = baseWidth * 1.6;
      ctx.beginPath();
      for (const idx of highlightedSegmentIndices) {
        if (idx === hoveredSegmentIndex) continue;
        if (cullSkipIndices?.has(idx)) continue;
        const s = segments[idx];
        if (!s) continue;
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
    }

    // Portal-dot endpoints. `drawTLEndpoint` was authored for the
    // image-space MapViewer canvas and divides its radius by the supplied
    // `zoom` to keep dots a constant on-screen size; we pass 1 so radii are
    // already in CSS pixels.
    for (const s of defaultSegs) {
      drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, portalOuter);
      drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, portalOuter);
    }
    for (const s of userSegs) {
      drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, userPortalOuter);
      drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, userPortalOuter);
    }
    for (const [hex, segs] of colorBuckets) {
      const dot = rgbaFromHex(hex, 0.95);
      for (const s of segs) {
        drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, dot);
        drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, dot);
      }
    }
  }

  // ── Point markers ────────────────────────────────────────────────────────
  if (points.length > 0) {
    const pointOuter = 3.6;
    const pointInner = pointOuter * 0.48;

    ctx.fillStyle = "rgba(34, 211, 238, 0.92)";
    for (const p of points) {
      if (
        p.kind === "Server" ||
        p.kind === "Trader" ||
        p.kind === "Home" ||
        p.kind === "Terminus" ||
        p.kind === "BrokenTL"
      )
        continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pointOuter, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
    for (const p of points) {
      if (
        p.kind === "Server" ||
        p.kind === "Trader" ||
        p.kind === "Home" ||
        p.kind === "Terminus" ||
        p.kind === "BrokenTL"
      )
        continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pointInner, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of points) {
      if (p.kind !== "Trader") continue;
      drawTraderMarker(
        ctx,
        p.x,
        p.y,
        1,
        traderStyle as never,
        p.color ?? "rgba(34, 211, 238, 0.92)",
      );
    }

    // Server (spawn) star
    const starOuter = 7.2;
    const starInner = starOuter * 0.45;
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
    ctx.lineWidth = 1.1;
    for (const p of points) {
      if (p.kind !== "Server") continue;
      drawStar(p.x, p.y);
      ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
      ctx.stroke();
    }

    // Home glyph
    const homeSize = 3.6;
    ctx.lineWidth = 0.55;
    for (const p of points) {
      if (p.kind !== "Home") continue;
      const half = homeSize;
      const bodyTopY = p.y - half * 0.15;
      const bodyBottomY = p.y + half;
      const leftX = p.x - half;
      const rightX = p.x + half;
      ctx.beginPath();
      ctx.moveTo(leftX, bodyBottomY);
      ctx.lineTo(leftX, bodyTopY);
      ctx.lineTo(p.x, p.y - half);
      ctx.lineTo(rightX, bodyTopY);
      ctx.lineTo(rightX, bodyBottomY);
      ctx.closePath();
      ctx.fillStyle = p.color ?? "rgba(245, 158, 11, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.stroke();
      const doorW = homeSize * 0.32;
      const doorH = homeSize * 0.55;
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.fillRect(p.x - doorW / 2, p.y + homeSize - doorH, doorW, doorH);
    }

    for (const p of points) {
      if (p.kind !== "Terminus") continue;
      drawTerminusMarker(ctx, p.x, p.y, 1, terminusStyle as never);
    }

    // Broken-translocator markers (recorded session exports) — bold filled
    // red disc with a dark outline and a white "broken" X, unmistakably
    // distinct from the cyan landmark dots.
    const tlOuter = 6.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const p of points) {
      if (p.kind !== "BrokenTL") continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, tlOuter, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220, 38, 38, 0.95)"; // red-600
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
      const d = tlOuter * 0.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.98)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(p.x - d, p.y - d);
      ctx.lineTo(p.x + d, p.y + d);
      ctx.moveTo(p.x + d, p.y - d);
      ctx.lineTo(p.x - d, p.y + d);
      ctx.stroke();
    }
  }

  // ── Route overlay ────────────────────────────────────────────────────────
  if (route) {
    if (route.walkLegs.length > 0) {
      const dashUnit = 8;
      const walkW = 2.0;
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.7)";
      ctx.lineWidth = walkW * 2.2;
      ctx.beginPath();
      for (const leg of route.walkLegs) {
        ctx.moveTo(leg.x1, leg.y1);
        ctx.lineTo(leg.x2, leg.y2);
      }
      ctx.stroke();
      ctx.setLineDash([dashUnit, dashUnit * 0.75]);
      ctx.strokeStyle = "rgba(226, 232, 240, 0.98)";
      ctx.lineWidth = walkW;
      ctx.beginPath();
      for (const leg of route.walkLegs) {
        ctx.moveTo(leg.x1, leg.y1);
        ctx.lineTo(leg.x2, leg.y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Pulsing focused-leg highlight — mirrors the highlight in
      // MapViewer.tsx so a user-selected edge stands out in both viewers.
      if (route.focusedWalkLegKey) {
        const focused = route.walkLegs.find((l) => l.key === route.focusedWalkLegKey);
        if (focused) {
          const phase = (Math.sin((performance.now() / 1000) * 1.2 * Math.PI * 2) + 1) / 2;
          ctx.save();
          ctx.lineCap = "round";
          ctx.strokeStyle = `rgba(250, 204, 21, ${(0.35 + phase * 0.45).toFixed(3)})`;
          ctx.lineWidth = walkW * (3.8 + phase * 2.6);
          ctx.beginPath();
          ctx.moveTo(focused.x1, focused.y1);
          ctx.lineTo(focused.x2, focused.y2);
          ctx.stroke();
          ctx.strokeStyle = "rgba(254, 240, 138, 0.95)";
          ctx.lineWidth = walkW * 1.4;
          ctx.beginPath();
          ctx.moveTo(focused.x1, focused.y1);
          ctx.lineTo(focused.x2, focused.y2);
          ctx.stroke();
          const ringR = 4.5 + phase * 3.5;
          ctx.strokeStyle = `rgba(250, 204, 21, ${(0.55 + phase * 0.4).toFixed(3)})`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(focused.x1, focused.y1, ringR, 0, Math.PI * 2);
          ctx.moveTo(focused.x2 + ringR, focused.y2);
          ctx.arc(focused.x2, focused.y2, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    if (route.tlSegs.length > 0) {
      const routeBase = 2.8;
      ctx.strokeStyle = "rgba(6, 78, 59, 0.6)";
      ctx.lineWidth = routeBase * 2.4;
      ctx.beginPath();
      for (const s of route.tlSegs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(16, 185, 129, 0.98)";
      ctx.lineWidth = routeBase;
      ctx.beginPath();
      for (const s of route.tlSegs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      const dotOuter = 3.4;
      const dotInner = dotOuter * 0.5;
      ctx.fillStyle = "rgba(16, 185, 129, 0.98)";
      for (const s of route.tlSegs) {
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, dotOuter, 0, Math.PI * 2);
        ctx.arc(s.x2, s.y2, dotOuter, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(236, 253, 245, 0.98)";
      for (const s of route.tlSegs) {
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, dotInner, 0, Math.PI * 2);
        ctx.arc(s.x2, s.y2, dotInner, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const pinRadius = 7.5;
    const drawPin = (cx: number, cy: number, fill: string, label: string) => {
      ctx.beginPath();
      ctx.arc(cx, cy - pinRadius, pinRadius, Math.PI * 0.2, Math.PI * 0.8, true);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(248, 250, 252, 0.98)";
      ctx.font = `bold ${pinRadius * 1.1}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy - pinRadius);
    };
    if (route.from) drawPin(route.from.x, route.from.y, "rgba(34, 197, 94, 0.98)", "A");
    if (route.to) drawPin(route.to.x, route.to.y, "rgba(239, 68, 68, 0.98)", "B");
  }
}

/**
 * Draws labels for `overlayPoints` directly above their dots. Mirrors the
 * styling of MapViewer's labels canvas — keeps font and badge in screen px
 * so labels stay readable at every zoom.
 */
function drawPointLabels(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number; label?: string; kind?: string }>,
  w: number,
  h: number,
): void {
  const FONT_SIZE = 11;
  const PAD_X = 4;
  const PAD_Y = 2;
  const DOT_RADIUS = 4;
  ctx.font = `600 ${FONT_SIZE}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  for (const p of points) {
    const raw = (p.label ?? "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    if (p.kind === "Home" || p.kind === "Terminus") continue;
    const sx = p.x;
    const sy = p.y;
    if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;
    const isServer = p.kind === "Server";
    const text = raw.length > 30 ? `${raw.slice(0, 29)}\u2026` : raw;
    const textW = ctx.measureText(text).width;
    const textH = FONT_SIZE;
    const dotRadius = isServer ? DOT_RADIUS + 4 : DOT_RADIUS;
    const tx = sx + dotRadius + 3;
    const ty = sy - dotRadius - PAD_Y - textH;
    ctx.fillStyle = isServer ? "rgba(120, 53, 15, 0.88)" : "rgba(15, 23, 42, 0.80)";
    ctx.fillRect(tx - PAD_X, ty - PAD_Y, textW + PAD_X * 2, textH + PAD_Y * 2);
    ctx.fillStyle = isServer ? "rgba(254, 240, 138, 1)" : "rgba(236, 254, 255, 0.98)";
    ctx.fillText(text, tx, ty);
  }
}
