import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTopsMapStats,
  getTopsMapLevel,
  type TopsMapResolutionMeta,
  type TopsMapLevelChunks,
} from "@/lib/api";
import { useAppDispatch, useAppSelector, useReduxState } from "@/store/hooks";
import {
  setSelectedLevel as setSelectedLevelAction,
  setGroupingsViewMode as setGroupingsViewModeAction,
  setActiveGroupingIds as setActiveGroupingIdsAction,
  toggleActiveGrouping as toggleActiveGroupingAction,
  setShowLandmarks as setShowLandmarksAction,
  setShowTranslocators as setShowTranslocatorsAction,
  setShowTraders as setShowTradersAction,
  toggleTraderTypeFilter as toggleTraderTypeFilterAction,
  setShowFullscreen as setShowFullscreenAction,
  toggleShowRecentlyAdded as toggleShowRecentlyAddedAction,
  setFavoriteStartingPosition as setFavoriteStartingPositionAction,
  clearFavoriteStartingPosition as clearFavoriteStartingPositionAction,
} from "@/store/slices/mapView";
import { stitchChunksToBlob } from "@/lib/stitch-chunks";
import {
  MapViewer,
  type MapStats,
  type MapTileSet,
  type RouteOverlay,
  type WorldLineSegment,
  type WorldPointMarker,
} from "@/components/MapViewer";
import { AdminResolutionPanel } from "@/components/AdminResolutionPanel";
import { MaintenanceChip } from "@/components/MaintenanceChip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Download,
  Home,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  TLGroupingsDrawer,
  type TLGroupingsViewMode,
} from "@/components/tops-map/TLGroupingsDrawer";
import { RoutePlannerPanel } from "@/components/tops-map/RoutePlannerPanel";
import { useTLRoute } from "@/hooks/useTLRoute";
import {
  setRouteFrom,
  setRoutePickMode,
  setRoutePlannerOpen,
  setRouteTo,
} from "@/store/slices/routePlanner";
import { ResourcesDrawer } from "@/components/tops-map/ResourcesDrawer";
import { ResourcesOverlayLayer } from "@/components/tops-map/ResourcesOverlayLayer";
import { LandmarkManagementCard } from "@/components/tops-map/landmarks/LandmarkManagementCard";
import { useResourcesOverlay } from "@/hooks/useResourcesOverlay";
import {
  useLandmarksOverlay,
  useTranslocatorsOverlay,
  useTradersOverlay,
  LANDMARKS_QUERY_KEY,
} from "@/hooks/useOverlayData";
import {
  TRADER_TYPES,
  TRADER_TYPE_LABELS,
  TRADER_TYPE_COLORS,
  isTraderType,
  type TraderType,
} from "@/lib/trader-types";
import type { ResourceDeposit } from "@/lib/api";
import { tlIdFor, useTLGroupings } from "@/lib/tl-groupings";
import { MapStatsHeader } from "@/components/tops-map-viewer/MapStats";
import { SelectedTranslocatorHeader } from "@/components/tops-map-viewer/SelectedTranslocator";
import { GroupEditingInfo } from "@/components/tops-map-viewer/GroupEditingInfo";
import { ResolutionSelector } from "@/components/tops-map-viewer/ResolutionSelector";
import { FullscreenControlsOverlay } from "@/components/tops-map/FullScreenOverlay";
import { HomePositionControls } from "@/components/tops-map/HomePositionControls";
import { cn } from "@/lib/utils";

const STALE_TIME = 12 * 60 * 60 * 1000; // 12 hours
// "Recently added" window for the favourites+recent filter (request #6 from
// the fullscreen redesign): TLs whose `meta.addedAt` is within this many ms
// of "now" are considered fresh and union'd into the visible set when the
// user toggles "Emphasize recently added".
const RECENT_TL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// Storage key constants moved into [store/slices/mapView.ts]; the slice
// owns reads/writes so the page only talks to selectors + dispatch.

/**
 * Compute how long (ms) the cached level info should be considered fresh based
 * on its embedded `expires_at`. We refresh a couple of minutes early so the
 * frontend never tries to render with URLs that have just expired.
 */
function levelInfoStaleTimeMs(info: TopsMapLevelChunks | undefined): number {
  if (!info?.expires_at) return 0;
  const expiresAtMs = new Date(info.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) return 0;
  // Refresh 2 minutes before expiry.
  return Math.max(0, expiresAtMs - Date.now() - 2 * 60 * 1000);
}

/** Returns true if the cached level info's presigned URLs are already past expiry. */
function isLevelInfoExpired(info: TopsMapLevelChunks | undefined): boolean {
  if (!info?.expires_at) return false;
  const expiresAtMs = new Date(info.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= Date.now();
}

/**
 * Convert a level-info payload into the tile set the viewer renders.
 * Boundary chunks use the remainder dimensions so they line up exactly with
 * the assembled image bounds.
 */
function levelToTileSet(info: TopsMapLevelChunks): MapTileSet {
  return {
    // Identity is just the level number. URL rotations keep the same id so
    // the viewer doesn't reset pan/zoom every time presigned URLs refresh.
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

interface TopsMapStatsResponse extends MapStats {
  default_level?: number | null;
  resolutions?: TopsMapResolutionMeta[];
}

export function TOPSMapViewPage() {
  const queryClient = useQueryClient();
  const isAdmin = useReduxState("auth.isAdmin");
  const apiKey = useReduxState("auth.apiKey");
  const [searchParams, setSearchParams] = useSearchParams();

  // Snapshot the URL params present on first render. They are *not* the
  // source of truth (panning the map every frame against react-router would
  // be expensive); they only seed the initial level + viewport so a shared
  // link can be opened to the exact same view. Subsequent in-page state
  // changes flow back into the URL via `setSearchParams({ replace: true })`.
  const initialUrlParamsRef = useRef<{
    level: number | null;
    initialView: { centerWorldX: number; centerWorldZ: number; pixelsPerBlock: number } | undefined;
  } | null>(null);
  if (initialUrlParamsRef.current === null) {
    const lvlRaw = searchParams.get("level");
    const xRaw = searchParams.get("x");
    const zRaw = searchParams.get("z");
    const zoomRaw = searchParams.get("zoom");
    const lvl = lvlRaw != null ? Number(lvlRaw) : NaN;
    const x = xRaw != null ? Number(xRaw) : NaN;
    const z = zRaw != null ? Number(zRaw) : NaN;
    const zm = zoomRaw != null ? Number(zoomRaw) : NaN;
    initialUrlParamsRef.current = {
      level: Number.isFinite(lvl) && lvl > 0 ? Math.trunc(lvl) : null,
      initialView:
        Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(zm) && zm > 0
          ? { centerWorldX: x, centerWorldZ: z, pixelsPerBlock: zm }
          : undefined,
    };
  }
  const initialUrlParams = initialUrlParamsRef.current;

  // Single helper that merges param changes into the existing search string
  // and replaces the history entry (so panning doesn't fill back-button
  // history). Wrapped in useCallback so it's stable for downstream effects.
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v == null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const dispatch = useAppDispatch();
  // Overlay-visibility toggles are persisted in the mapView slice so the
  // user's preference survives reloads and cross-tab navigation.
  const showTranslocators = useAppSelector((s) => s.mapView.showTranslocators);
  const setShowTranslocators = useCallback(
    (next: boolean) => dispatch(setShowTranslocatorsAction(next)),
    [dispatch],
  );
  const showLandmarks = useAppSelector((s) => s.mapView.showLandmarks);
  const setShowLandmarks = useCallback(
    (next: boolean) => dispatch(setShowLandmarksAction(next)),
    [dispatch],
  );
  // Fullscreen mode (local, not persisted): hides the page chrome and renders
  // the map at viewport size with floating control panels.
  // const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreen = useReduxState("mapView.isFullscreen");
  // Animated cosmos background behind the map tiles. User-toggleable from
  // the AccountPage Appearance card; persisted in localStorage.
  const starfieldEnabled = useReduxState("mapView.starfieldEnabled");
  // "Emphasize recently added TLs" augments the favourites filter. When ON, the
  // visible TL set is the union of (active grouping members) and TLs whose
  // `meta.addedAt` falls inside RECENT_TL_WINDOW_MS — so a user can keep
  // their favourite groupings *and* still see freshly contributed segments
  // from the community.
  const showRecentlyAddedTLs = useAppSelector((s) => s.mapView.showRecentlyAdded);
  const toggleShowRecentlyAddedTLs = useCallback(
    () => dispatch(toggleShowRecentlyAddedAction()),
    [dispatch],
  );

  const [selectedTranslocator, setSelectedTranslocator] = useState<WorldLineSegment | null>(null);
  // When pinned, the displayed TL info stays put even if the user left-clicks
  // empty space. Cleared by clicking the pin icon, or by clicking any other TL
  // (which then becomes the new selection — pinned only if right-clicked).
  const [translocatorPinned, setTranslocatorPinned] = useState(false);
  const [landmarkSearch, setLandmarkSearch] = useState("");
  const [landmarkFocusPoint, setLandmarkFocusPoint] = useState<
    { x: number; z: number } | undefined
  >(undefined);

  // Persisted, etag-aware overlay loaders. React Query handles dedupe,
  // persistence (via the global persister), and re-fetch when the URL
  // endpoint reports either a new etag or an expired window.
  const landmarksQuery = useLandmarksOverlay();
  const translocatorsQuery = useTranslocatorsOverlay();
  const tradersQuery = useTradersOverlay();
  const allLandmarks = landmarksQuery.data?.data;
  const allTranslocators = translocatorsQuery.data?.data;
  const allTraders = tradersQuery.data?.data;
  const landmarkCount = allLandmarks?.length ?? 0;
  const translocatorCount = allTranslocators?.length ?? 0;
  const traderCount = allTraders?.length ?? 0;
  const showTraders = useAppSelector((s) => s.mapView.showTraders);
  const setShowTraders = useCallback(
    (next: boolean) => dispatch(setShowTradersAction(next)),
    [dispatch],
  );
  const traderTypeFilter = useAppSelector((s) => s.mapView.traderTypeFilter);
  const traderTypeFilterSet = useMemo(() => new Set<string>(traderTypeFilter), [traderTypeFilter]);
  const toggleTraderType = useCallback(
    (t: TraderType) => dispatch(toggleTraderTypeFilterAction(t)),
    [dispatch],
  );

  // Favorite TL groupings (local-only). The groupings themselves persist via
  // `useTLGroupings`; view-mode + active-selection live in the Redux
  // mapView slice (which preloaded them from localStorage on store
  // construction). Selectors keep this component re-rendering only when
  // those specific fields change.
  const groupingsStore = useTLGroupings();
  const [groupingsOpen, setGroupingsOpen] = useState(false);
  const groupingsViewMode = useAppSelector((s) => s.mapView.groupingsViewMode);
  const setGroupingsViewMode = useCallback(
    (mode: TLGroupingsViewMode) => dispatch(setGroupingsViewModeAction(mode)),
    [dispatch],
  );
  const activeGroupingIdsArray = useAppSelector((s) => s.mapView.activeGroupingIds);
  // Many call sites want O(1) `.has()` lookups; memoise a Set view derived
  // from the slice array. The Set identity changes only when the array
  // reference does (i.e. on dispatch), keeping downstream effects stable.
  const activeGroupingIds = useMemo(
    () => new Set<string>(activeGroupingIdsArray),
    [activeGroupingIdsArray],
  );
  const setActiveGroupingIds = useCallback(
    (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const resolved =
        typeof next === "function" ? next(new Set<string>(activeGroupingIdsArray)) : next;
      dispatch(setActiveGroupingIdsAction(Array.from(resolved)));
    },
    [dispatch, activeGroupingIdsArray],
  );
  const [editingGroupingId, setEditingGroupingId] = useState<string | null>(null);

  // Resources overlay (admin-only). The hook is inert when `enabled` is false.
  const resourcesOverlay = useResourcesOverlay({ enabled: false });
  const [resourcesDrawerOpen, setResourcesDrawerOpen] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState<ResourceDeposit | null>(null);

  // Favorite "home" position — persisted in the mapView slice so it survives
  // reload + cross-tab. Used as the initial viewport when the URL has no
  // explicit x/z, and reachable on demand via the Home button.
  const favoriteStartingPosition = useAppSelector((s) => s.mapView.favoriteStartingPosition);
  const setFavoriteStartingPosition = useCallback(
    (pos: { x: number; z: number; zoom?: number } | null) =>
      dispatch(setFavoriteStartingPositionAction(pos)),
    [dispatch],
  );
  const clearFavoriteStartingPosition = useCallback(
    () => dispatch(clearFavoriteStartingPositionAction()),
    [dispatch],
  );
  // Most recently reported viewport center (from MapViewer's onViewportChange).
  // Kept in a ref so handlers can capture "set current view as home" without
  // re-rendering on every pan.
  const lastViewportRef = useRef<{
    centerWorldX: number;
    centerWorldZ: number;
    pixelsPerBlock: number;
  } | null>(null);
  // Snapshot of the favorite position frozen at first render — used as the
  // one-shot `initialView` seed for MapViewer when the URL has no explicit
  // x/z. Subsequent changes to the favorite don't reseed the viewport.
  const favoriteInitialViewRef = useRef<
    { centerWorldX: number; centerWorldZ: number; pixelsPerBlock: number } | undefined
  >(
    favoriteStartingPosition
      ? {
          centerWorldX: favoriteStartingPosition.x,
          centerWorldZ: favoriteStartingPosition.z,
          pixelsPerBlock: favoriteStartingPosition.zoom ?? 1,
        }
      : undefined,
  );

  const toggleActiveGrouping = useCallback(
    (id: string) => {
      dispatch(toggleActiveGroupingAction(id));
    },
    [dispatch],
  );

  // Stop editing if the grouping disappears (e.g. deleted from the drawer).
  useEffect(() => {
    if (editingGroupingId == null) return;
    if (!groupingsStore.groupings.some((g) => g.id === editingGroupingId)) {
      setEditingGroupingId(null);
    }
  }, [editingGroupingId, groupingsStore.groupings]);

  // Drop any active ids that no longer correspond to a stored grouping.
  useEffect(() => {
    setActiveGroupingIds((prev) => {
      const valid = new Set(groupingsStore.groupings.map((g) => g.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [groupingsStore.groupings]);

  // Auto-enable the translocator overlay when the user enters edit mode —
  // otherwise there'd be nothing to click on.
  useEffect(() => {
    if (editingGroupingId != null && !showTranslocators) setShowTranslocators(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingGroupingId]);

  // Drop the cached landmarks payload so the next render re-fetches the
  // file. React Query handles dedupe + persistence; the new etag from the
  // URL endpoint will skip the actual GET if the file body is unchanged.
  const reloadLandmarks = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...LANDMARKS_QUERY_KEY] });
  }, [queryClient]);

  // Translocator segments to render. When the overlay is on we use the
  // full set; otherwise we expose an empty array so the groupings drawer
  // still has the data via `allTranslocators` directly.
  const translocatorSegments = allTranslocators ?? [];

  const statsQuery = useQuery<TopsMapStatsResponse>({
    queryKey: ["tops-map-stats"],
    queryFn: getTopsMapStats,
    staleTime: STALE_TIME,
    gcTime: 7 * 24 * 60 * 60 * 1000,
    // Always re-validate on page (re)load so the user sees fresh stats /
    // resolutions if anything changed server-side, while still rendering
    // the persisted cached payload immediately.
    refetchOnMount: "always",
    enabled: Boolean(apiKey),
    meta: { persist: true },
  });

  // Resolution selection. Defaults to whatever the user picked last, falling
  // back to the server-recommended default level.
  const completedLevels = useMemo(
    () =>
      (statsQuery.data?.resolutions ?? [])
        .filter((r) => r.status === "complete")
        .map((r) => r.level)
        .sort((a, b) => a - b),
    [statsQuery.data?.resolutions],
  );

  // Selected level lives in the mapView slice so cross-tab sync + central
  // persistence apply. URL parameter still wins on first paint and is
  // re-applied on each change below.
  const selectedLevel = useAppSelector((s) => s.mapView.selectedLevel);
  const setSelectedLevel = useCallback(
    (level: number | null) => dispatch(setSelectedLevelAction(level)),
    [dispatch],
  );
  // If a `?level=` query param was provided on the *initial* navigation,
  // override whatever the slice loaded from storage so deep links win.
  const initialLevelAppliedRef = useRef(false);
  useEffect(() => {
    if (initialLevelAppliedRef.current) return;
    initialLevelAppliedRef.current = true;
    if (initialUrlParams.level != null && initialUrlParams.level !== selectedLevel) {
      setSelectedLevel(initialUrlParams.level);
    }
    // Intentional one-shot: only applies the URL value at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick a sensible level once the resolution list is known.
  useEffect(() => {
    if (!statsQuery.data) return;
    if (completedLevels.length === 0) {
      setSelectedLevel(null);
      return;
    }
    const desired =
      selectedLevel ?? statsQuery.data.default_level ?? completedLevels[completedLevels.length - 1];
    if (desired && completedLevels.includes(desired)) {
      if (selectedLevel !== desired) setSelectedLevel(desired);
      return;
    }
    // Fall back to nearest lower available level, else lowest available.
    const lower = completedLevels.filter((l) => l <= (desired ?? 0));
    const next = lower.length > 0 ? Math.max(...lower) : completedLevels[0];
    setSelectedLevel(next);
  }, [completedLevels, statsQuery.data, selectedLevel, setSelectedLevel]);

  // Mirror selected level into the URL so the page is shareable. Persistence
  // itself is handled by the slice's reducer subscriber.
  useEffect(() => {
    if (selectedLevel != null) {
      updateUrlParams({ level: String(selectedLevel) });
    }
  }, [selectedLevel, updateUrlParams]);

  // Mirror viewport pan/zoom into the URL (debounced inside MapViewer). World
  // coords are rounded to whole blocks; the on-screen scale is kept to a few
  // decimals so the share is reproducible without bloating the URL.
  //
  // We pull `reportViewport` out of the resources hook into a stable ref so
  // the callback identity doesn't change every time the hook re-renders
  // (the hook returns a fresh object literal each render — depending on the
  // whole object would otherwise create an infinite report→fetch→setState→
  // re-render loop that hammers the deposits endpoint).
  const reportResourcesViewport = resourcesOverlay.reportViewport;
  const reportResourcesViewportRef = useRef(reportResourcesViewport);
  useEffect(() => {
    reportResourcesViewportRef.current = reportResourcesViewport;
  }, [reportResourcesViewport]);
  const handleViewportChange = useCallback(
    (info: {
      centerWorldX: number;
      centerWorldZ: number;
      pixelsPerBlock: number;
      worldMinX: number;
      worldMaxX: number;
      worldMinZ: number;
      worldMaxZ: number;
    }) => {
      lastViewportRef.current = {
        centerWorldX: info.centerWorldX,
        centerWorldZ: info.centerWorldZ,
        pixelsPerBlock: info.pixelsPerBlock,
      };
      updateUrlParams({
        x: String(Math.round(info.centerWorldX)),
        z: String(Math.round(info.centerWorldZ)),
        zoom: info.pixelsPerBlock.toFixed(4),
      });
      // Notify resources hook so it can debounce-fetch deposits for the
      // visible bounding box. No-op when not admin / no bundle active.
      reportResourcesViewportRef.current({
        worldMinX: info.worldMinX,
        worldMaxX: info.worldMaxX,
        worldMinZ: info.worldMinZ,
        worldMaxZ: info.worldMaxZ,
      });
    },
    [updateUrlParams],
  );

  const levelInfoQuery = useQuery<TopsMapLevelChunks>({
    queryKey: ["tops-map-level", selectedLevel],
    queryFn: () => {
      if (selectedLevel == null) {
        throw new Error("No resolution level available yet");
      }
      return getTopsMapLevel(selectedLevel);
    },
    // Reuse the persisted cached URLs while they're still valid; refresh a
    // couple of minutes before R2's signature expires. React Query auto-fetches
    // when an enabled query has stale data, so when staleTime returns 0 (URLs
    // already expired) we get exactly one refetch on mount; when it returns a
    // positive value we serve the persisted entry with no network call.
    staleTime: ({ state }) => levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
    gcTime: 7 * 24 * 60 * 60 * 1000,
    // Always re-validate on page (re)load. The cached payload still renders
    // immediately (so a server outage stays viewable for the lifetime of the
    // signed URLs); this just kicks off a background refresh so any newly
    // contributed tiles show up on reload.
    refetchOnMount: "always",
    meta: { persist: true },
  });

  const tileSet = useMemo(() => {
    const info = levelInfoQuery.data;
    if (!info) return null;
    // Cached data with already-expired URLs would render as a blank map
    // (every <img> 403s against R2). Treat it as missing so the user sees
    // the loading state until the background refetch arrives.
    if (isLevelInfoExpired(info)) return null;
    return levelToTileSet(info);
  }, [levelInfoQuery.data]);

  // Prefer the backend stats payload (richer: tile count, size). When that
  // request fails (server down, etc.) but we still have a cached level-info
  // payload, derive a minimal MapStats from it so overlay projection (which
  // needs start_x/start_z/width_blocks/height_blocks) keeps working.
  //
  // IMPORTANT: when both are present, the *bounds* (start_x/start_z + width/
  // height in blocks) must come from the per-level payload, not the global
  // stats. The global stats reflect the current map database; older
  // resolutions that haven't been regenerated since the last merge still
  // have their original (smaller / shifted) bounds baked into their tile
  // images. Using the global bounds for those levels misaligns every world-
  // space overlay (spawn marker, landmarks, translocators).
  const stats = useMemo<MapStats | null>(() => {
    const info = levelInfoQuery.data;
    const infoUsable = info && !isLevelInfoExpired(info);
    if (statsQuery.data) {
      if (!infoUsable) return statsQuery.data;
      return {
        ...statsQuery.data,
        width_blocks: info.width_blocks,
        height_blocks: info.height_blocks,
        start_x: info.start_x,
        start_z: info.start_z,
      };
    }
    if (!infoUsable) return null;
    return {
      pieces: 0,
      size_mb: 0,
      width_chunks: 0,
      height_chunks: 0,
      width_blocks: info.width_blocks,
      height_blocks: info.height_blocks,
      start_x: info.start_x,
      start_z: info.start_z,
    };
  }, [statsQuery.data, levelInfoQuery.data]);
  const hasMap = tileSet != null;
  const [downloading, setDownloading] = useState(false);

  // Derive loading / error from query states. Only surface the loading chip
  // when we have nothing to render yet — background revalidations (triggered
  // on every reload by `refetchOnMount: "always"`) shouldn't replace the
  // cached map with a spinner.
  const loading =
    statsQuery.isFetching && !statsQuery.data
      ? "Reading global server map…"
      : levelInfoQuery.isFetching && !tileSet
        ? "Loading map chunks…"
        : "";
  const error =
    statsQuery.error instanceof Error
      ? statsQuery.error.message
      : levelInfoQuery.error instanceof Error
        ? levelInfoQuery.error.message
        : "";

  // Background-refresh indicator for the Reload button. Distinct from
  // `loading` (which is only set when we have nothing to render yet); this
  // is true while a refetch is in flight *and* the map is already visible,
  // so the user sees a subtle spinner instead of the whole map blanking out.
  const isReloading = (statsQuery.isFetching || levelInfoQuery.isFetching) && hasMap;

  useEffect(() => {
    if (!showTranslocators) {
      setSelectedTranslocator(null);
      setTranslocatorPinned(false);
    }
  }, [showTranslocators]);

  const handleTranslocatorClick = useCallback(
    (seg: WorldLineSegment | null) => {
      // Edit mode: clicks toggle membership of the editing grouping rather
      // than selecting / pinning.
      if (editingGroupingId && seg) {
        groupingsStore.toggleTL(editingGroupingId, tlIdFor(seg));
        return;
      }
      // While a TL is pinned, ignore all map clicks (empty space or other TLs)
      // — only the explicit unpin button can clear the selection.
      if (translocatorPinned) return;
      if (!seg) {
        setSelectedTranslocator(null);
        return;
      }
      setSelectedTranslocator(seg);
    },
    [editingGroupingId, groupingsStore, translocatorPinned],
  );

  const handleTranslocatorRightClick = useCallback((seg: WorldLineSegment) => {
    // Right-click always pins the clicked TL — including when another TL is
    // already pinned (the new selection replaces the previous pin).
    setSelectedTranslocator(seg);
    setTranslocatorPinned(true);
  }, []);

  const handleUnpinTranslocator = useCallback(() => {
    setTranslocatorPinned(false);
  }, []);

  // Landmark points fed to the viewer. When the overlay is off we still
  // surface "Server"-kind landmarks (always-on POIs) but hide everything
  // else; toggling on swaps in the full set.
  const landmarkPoints = useMemo<WorldPointMarker[]>(() => {
    const base: WorldPointMarker[] = [];
    if (allLandmarks) {
      const ls = showLandmarks ? allLandmarks : allLandmarks.filter((p) => p.kind === "Server");
      base.push(...ls);
    }
    if (showTraders && allTraders) {
      for (const t of allTraders) {
        if (
          traderTypeFilterSet.size > 0 &&
          isTraderType(t.trader_type) &&
          !traderTypeFilterSet.has(t.trader_type)
        ) {
          continue;
        }
        base.push(t);
      }
    }
    // Always-on house glyph for the user's saved favorite position. Drawn
    // last so the marker sits on top of any colocated landmark/trader dot.
    if (favoriteStartingPosition) {
      base.push({
        x: favoriteStartingPosition.x,
        z: favoriteStartingPosition.z,
        kind: "Home",
        label: "Home",
      });
    }
    return base;
  }, [
    allLandmarks,
    showLandmarks,
    showTraders,
    allTraders,
    traderTypeFilterSet,
    favoriteStartingPosition,
  ]);

  function handleReload() {
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-level"] });
  }

  const landmarkSuggestions = useMemo(
    () =>
      (allLandmarks ?? []).map((pt) => pt.label?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean),
    [allLandmarks],
  );

  function handleLandmarkSelect(name: string) {
    setLandmarkSearch(name);
    const normalised = name.replace(/\s+/g, " ").trim().toLowerCase();
    const points = allLandmarks ?? [];
    const match = points.find(
      (pt) => (pt.label?.replace(/\s+/g, " ").trim().toLowerCase() ?? "") === normalised,
    );
    if (match) {
      setLandmarkFocusPoint({ x: match.x, z: match.z });
      setShowLandmarks(true);
    }
  }

  /**
   * Fly to the user's saved starting position (or spawn 0,0 as a fallback).
   * A fresh object reference is required — MapViewer flies only when the
   * `focusPoint` identity changes.
   */
  const handleJumpHome = useCallback(() => {
    const pos = favoriteStartingPosition ?? { x: 0, z: 0 };
    setLandmarkFocusPoint({ x: pos.x, z: pos.z });
  }, [favoriteStartingPosition]);

  /** Save the current viewport center (and zoom) as the favorite start. */
  const handleSetCurrentAsHome = useCallback(() => {
    const v = lastViewportRef.current;
    if (!v) return;
    setFavoriteStartingPosition({
      x: Math.round(v.centerWorldX),
      z: Math.round(v.centerWorldZ),
      zoom: v.pixelsPerBlock,
    });
  }, [setFavoriteStartingPosition]);

  async function handleDownload() {
    if (!levelInfoQuery.data || downloading) return;
    setDownloading(true);
    try {
      // Lazy-stitch only on explicit user request — avoids the giant canvas
      // round-trip during normal viewing.
      const blob = await stitchChunksToBlob(levelInfoQuery.data);
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = "tops-server-map.png";
        a.click();
      } finally {
        // Give the browser a tick to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      console.error("Failed to assemble PNG for download", err);
    } finally {
      setDownloading(false);
    }
  }

  // Auto-enhance: when zoomed in past current resolution, fetch a higher
  // completed level; when zoomed out past current resolution, fetch a lower
  // one. Either direction hands its tile set to the viewer (no stitching).
  const selectLevelForZoom = useCallback(
    async (targetMaxDim: number): Promise<MapTileSet> => {
      const resolutions = statsQuery.data?.resolutions ?? [];
      const completed = resolutions
        .filter((r) => r.status === "complete")
        .slice()
        .sort((a, b) => a.max_dimension - b.max_dimension);
      // Pick the smallest completed level whose max_dimension covers the
      // requested target; fall back to the highest completed level.
      const candidate =
        completed.find((r) => r.max_dimension >= targetMaxDim) ?? completed[completed.length - 1];
      if (!candidate) {
        throw new Error("No completed resolution available");
      }
      const info = await queryClient.fetchQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", candidate.level],
        queryFn: () => getTopsMapLevel(candidate.level),
        staleTime: ({ state }) =>
          levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
        gcTime: 7 * 24 * 60 * 60 * 1000,
        meta: { persist: true },
      });
      if (!info.chunks?.length) throw new Error("Resolution chunks unavailable");
      // Note: we deliberately do NOT call setSelectedLevel here. The parent
      // updating its `tileSet` prop in the middle of MapViewer's async swap
      // causes both sides to apply scale compensation (the prop-change effect
      // *and* the post-await branch of auto-enhance), leaving pan/zoom
      // double-scaled and the viewport outside all chunks — the map appears
      // blank until "Center view" is pressed. Defer the level update to
      // `onTileSetEnhanced` (fires after the internal swap is done) so the
      // tileSet?.id effect takes the Case-1 fast path and just drops the
      // override without touching pan/zoom.
      return levelToTileSet(info);
    },
    [statsQuery.data?.resolutions, queryClient],
  );

  // Derived: the editing grouping object, the union of TLIds across all
  // currently-active groupings, and the segments / highlight set the viewer
  // should actually render given the current view mode + edit state.
  const editingGrouping = useMemo(
    () =>
      editingGroupingId == null
        ? null
        : (groupingsStore.groupings.find((g) => g.id === editingGroupingId) ?? null),
    [editingGroupingId, groupingsStore.groupings],
  );

  const activeTLIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const g of groupingsStore.groupings) {
      if (!activeGroupingIds.has(g.id)) continue;
      for (const id of g.tlIds) set.add(id);
    }
    return set;
  }, [activeGroupingIds, groupingsStore.groupings]);

  // Set of TLIds whose `meta.addedAt` is within the recent-window. Only user-
  // contributed segments carry `meta`, so seeded TLs naturally never appear
  // here. Memoised on the segment list so it only recomputes when the
  // overlay payload actually changes.
  const recentTLIdSet = useMemo(() => {
    const cutoff = Date.now() - RECENT_TL_WINDOW_MS;
    const set = new Set<string>();
    for (const seg of translocatorSegments) {
      const addedAt = seg.meta?.addedAt;
      if (!addedAt) continue;
      const t = Date.parse(addedAt);
      if (Number.isFinite(t) && t >= cutoff) set.add(tlIdFor(seg));
    }
    return set;
  }, [translocatorSegments]);

  // Segments the viewer renders. In edit mode we always show every TL so the
  // user can click any of them; otherwise filter mode narrows the set,
  // optionally augmented with recently-added TLs.
  const visibleTranslocatorSegments = useMemo(() => {
    if (!showTranslocators) return undefined;
    if (editingGrouping) return translocatorSegments;
    const filterByGroupings = groupingsViewMode === "filter" && activeTLIdSet.size > 0;
    if (!filterByGroupings && !showRecentlyAddedTLs) return translocatorSegments;
    return translocatorSegments.filter((seg) => {
      const id = tlIdFor(seg);
      if (filterByGroupings && activeTLIdSet.has(id)) return true;
      if (showRecentlyAddedTLs && recentTLIdSet.has(id)) return true;
      return false;
    });
  }, [
    showTranslocators,
    editingGrouping,
    groupingsViewMode,
    activeTLIdSet,
    translocatorSegments,
    showRecentlyAddedTLs,
    recentTLIdSet,
  ]);

  // Segments the viewer should highlight. In edit mode = current grouping's
  // members; in highlight mode = active grouping union; recently-added TLs
  // are highlighted additively whenever the toggle is on (regardless of mode)
  // so freshly contributed segments visually stand out.
  const highlightedTranslocatorSegments = useMemo(() => {
    if (!showTranslocators) return undefined;
    if (editingGrouping) {
      const memberSet = new Set(editingGrouping.tlIds);
      const out = translocatorSegments.filter((seg) => memberSet.has(tlIdFor(seg)));
      return out.length > 0 ? out : undefined;
    }
    const highlightByGroupings = groupingsViewMode === "highlight" && activeTLIdSet.size > 0;
    if (!highlightByGroupings && !showRecentlyAddedTLs) return undefined;
    const seen = new Set<string>();
    const out: WorldLineSegment[] = [];
    for (const seg of translocatorSegments) {
      const id = tlIdFor(seg);
      if (seen.has(id)) continue;
      const matchGroup = highlightByGroupings && activeTLIdSet.has(id);
      const matchRecent = showRecentlyAddedTLs && recentTLIdSet.has(id);
      if (matchGroup || matchRecent) {
        out.push(seg);
        seen.add(id);
      }
    }
    return out.length > 0 ? out : undefined;
  }, [
    showTranslocators,
    editingGrouping,
    groupingsViewMode,
    activeTLIdSet,
    translocatorSegments,
    showRecentlyAddedTLs,
    recentTLIdSet,
  ]);

  // Filtering is active when the visible TL list has actually been narrowed
  // — either by the favourites filter or the include-recently-added filter.
  const filteringActive =
    !editingGrouping &&
    ((groupingsViewMode === "filter" && activeTLIdSet.size > 0) || showRecentlyAddedTLs) &&
    visibleTranslocatorSegments != null &&
    visibleTranslocatorSegments.length !== translocatorSegments.length;

  // ---------------------------------------------------------------------
  // Route planner integration
  // ---------------------------------------------------------------------
  // Drive route compute from the slice + segment list. The hook handles
  // debouncing, idle-callback scheduling, and graph caching internally;
  // it sources translocators directly from the overlay query so no arg
  // is needed here — mounting the hook is what activates it.
  useTLRoute();

  const routePickMode = useAppSelector((s) => s.routePlanner.pickMode);
  const routePlannerOpen = useAppSelector((s) => s.routePlanner.isOpen);
  const routeFrom = useAppSelector((s) => s.routePlanner.from);
  const routeTo = useAppSelector((s) => s.routePlanner.to);
  const routes = useAppSelector((s) => s.routePlanner.routes);
  const routeSelectedIndex = useAppSelector((s) => s.routePlanner.selectedIndex);

  // Build the visual overlay handed to MapViewer from the currently
  // selected route. Recomputes only when the underlying route or picks
  // change so the canvas effect doesn't churn on unrelated state.
  const routeOverlay: RouteOverlay | null = useMemo(() => {
    const selected = routes[routeSelectedIndex] ?? routes[0] ?? null;
    if (!selected && !routeFrom && !routeTo) return null;
    const tlSegments: WorldLineSegment[] = [];
    const walkLegs: RouteOverlay["walkLegs"] = [];
    if (selected) {
      for (const leg of selected.legs) {
        if (leg.kind === "tl") tlSegments.push(leg.segment);
        else walkLegs.push({ from: leg.from, to: leg.to });
      }
    }
    return {
      tlSegments,
      walkLegs,
      from: routeFrom?.point ?? null,
      to: routeTo?.point ?? null,
    };
  }, [routes, routeSelectedIndex, routeFrom, routeTo]);

  // Click-on-map endpoint capture. Writes to the slot indicated by
  // `pickMode`, then clears pick mode so a single click ends the gesture.
  const handleRouteWorldClick = useCallback(
    (x: number, z: number) => {
      if (routePickMode === "from") {
        dispatch(setRouteFrom({ point: { x, z }, label: `${x}, ${z}`, source: "map-click" }));
      } else if (routePickMode === "to") {
        dispatch(setRouteTo({ point: { x, z }, label: `${x}, ${z}`, source: "map-click" }));
      }
      dispatch(setRoutePickMode(null));
    },
    [dispatch, routePickMode],
  );

  // ESC cancels pick mode without closing the panel — matches typical
  // map-editor expectations.
  useEffect(() => {
    if (!routePickMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch(setRoutePickMode(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [routePickMode, dispatch]);

  // URL state for shareable routes — `?rfrom=x,z&rto=x,z`. We use the
  // `r`-prefix to avoid colliding with any future `?from=` page params.
  // Hydration runs once on mount; the writeback effect mirrors the slice.
  const routeUrlHydratedRef = useRef(false);
  useEffect(() => {
    if (routeUrlHydratedRef.current) return;
    routeUrlHydratedRef.current = true;
    const parseParam = (raw: string | null): { x: number; z: number } | null => {
      if (!raw) return null;
      const m = raw.match(/^(-?\d+)\s*,\s*(-?\d+)$/);
      if (!m) return null;
      return { x: parseInt(m[1], 10), z: parseInt(m[2], 10) };
    };
    const f = parseParam(searchParams.get("rfrom"));
    const t = parseParam(searchParams.get("rto"));
    if (f) {
      dispatch(setRouteFrom({ point: f, label: `${f.x}, ${f.z}`, source: "url" }));
    }
    if (t) {
      dispatch(setRouteTo({ point: t, label: `${t.x}, ${t.z}`, source: "url" }));
    }
    if (f || t) dispatch(setRoutePlannerOpen(true));
    // searchParams intentionally omitted — we want a true once-on-mount hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!routeUrlHydratedRef.current) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (routeFrom) next.set("rfrom", `${routeFrom.point.x},${routeFrom.point.z}`);
        else next.delete("rfrom");
        if (routeTo) next.set("rto", `${routeTo.point.x},${routeTo.point.z}`);
        else next.delete("rto");
        return next;
      },
      { replace: true },
    );
  }, [routeFrom, routeTo, setSearchParams]);

  return (
    <Card
      className={
        isFullscreen
          ? "fixed inset-0 z-50 m-0 rounded-none border-0 bg-background overflow-hidden"
          : undefined
      }
    >
      {!isFullscreen && (
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span>TOPS Map Viewer</span>
            <MaintenanceChip component="tops_map_viewer" />
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Explore the community-contributed global server map built from player contributions.
          </p>
        </CardHeader>
      )}
      <CardContent className={isFullscreen ? "absolute inset-0 p-0" : "grid gap-4"}>
        {!isFullscreen && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {loading && (
                <Button disabled>
                  <Loader2 className="size-4 mr-1 animate-spin" />
                  {loading}
                </Button>
              )}
              {!loading && hasMap && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleDownload}
                    disabled={downloading}
                  >
                    {downloading ? (
                      <Loader2 className="size-4 mr-1 animate-spin" />
                    ) : (
                      <Download className="size-4 mr-1" />
                    )}
                    {downloading ? "Building PNG…" : "Download PNG"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleReload}
                    disabled={isReloading}
                    title={isReloading ? "Refreshing map data…" : "Refresh map data"}
                    aria-busy={isReloading}
                  >
                    <RefreshCw
                      className={`size-4 mr-1 transition-transform animate-spin ${
                        isReloading ? "running" : "paused"
                      }`}
                    />
                    Reload
                  </Button>
                  <HomePositionControls
                    favorite={favoriteStartingPosition}
                    canSaveCurrent={lastViewportRef.current != null}
                    onJumpHome={handleJumpHome}
                    onSaveCurrent={handleSetCurrentAsHome}
                    onClear={clearFavoriteStartingPosition}
                  />
                </>
              )}
              {!loading && !hasMap && error && (
                <Button type="button" onClick={handleReload}>
                  Retry
                </Button>
              )}

              {/* Resolution selector — visible whenever multiple completed levels exist. */}
              {completedLevels.length > 1 && (
                <ResolutionSelector
                  selectedLevel={selectedLevel}
                  setSelectedLevel={setSelectedLevel}
                  resolutionLevels={statsQuery.data?.resolutions}
                />
              )}

              {isAdmin && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setResourcesDrawerOpen(true)}
                  title="Worldgen resources overlay"
                >
                  <Sparkles className="size-4 mr-1" />
                  Resources
                  {resourcesOverlay.depositsLoading && (
                    <Loader2 className="size-3 ml-1 animate-spin" />
                  )}
                </Button>
              )}

              {isAdmin && (
                <Dialog>
                  <DialogTrigger
                    render={
                      <Button type="button" variant="outline" size="sm">
                        <Settings className="size-4 mr-1" />
                        Map cache
                      </Button>
                    }
                  />
                  <DialogContent className="sm:max-w-5xl lg:max-w-6xl">
                    <DialogHeader>
                      <DialogTitle>TOPS map resolution cache</DialogTitle>
                    </DialogHeader>
                    <AdminResolutionPanel
                      onLevelComplete={() => {
                        queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
                        queryClient.invalidateQueries({ queryKey: ["tops-map-level"] });
                      }}
                    />
                  </DialogContent>
                </Dialog>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Switch
                checked={showTranslocators}
                onCheckedChange={setShowTranslocators}
                aria-label="Show translocator overlay"
              />
              <Label>Show translocators</Label>
              <span className="text-xs text-muted-foreground ml-2">
                TLs found:{" "}
                <span className="font-medium text-foreground">
                  {filteringActive
                    ? `${(visibleTranslocatorSegments?.length ?? 0).toLocaleString()} / ${translocatorCount.toLocaleString()} shown`
                    : translocatorCount.toLocaleString()}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => setGroupingsOpen(true)}
              >
                <Layers className="size-4 mr-1" />
                Groupings
                {activeGroupingIds.size > 0 && (
                  <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                    {activeGroupingIds.size}
                  </span>
                )}
              </Button>
              <Button
                type="button"
                variant={routePlannerOpen ? "default" : "outline"}
                size="sm"
                onClick={() => dispatch(setRoutePlannerOpen(!routePlannerOpen))}
              >
                <Waypoints className="size-4 mr-1" />
                Route
              </Button>
            </div>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Switch
                checked={showRecentlyAddedTLs}
                onCheckedChange={toggleShowRecentlyAddedTLs}
                aria-label="Emphasize recently added translocators"
              />
              <Label>Emphasize recently added TLs (last 14 days)</Label>
              <span className="text-xs text-muted-foreground ml-2">
                {recentTLIdSet.size.toLocaleString()} recent
              </span>
            </div>
            <GroupEditingInfo
              editingGrouping={editingGrouping}
              setEditingGroupingId={setEditingGroupingId}
            />
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Switch
                checked={showLandmarks}
                onCheckedChange={setShowLandmarks}
                aria-label="Show landmarks overlay"
              />
              <Label>Show landmarks</Label>
              <span className="text-xs text-muted-foreground ml-2">
                Landmarks found:{" "}
                <span className="font-medium text-foreground">
                  {landmarkCount.toLocaleString()}
                </span>
              </span>
            </div>
            {tradersQuery.data && (
              <div className={cn("flex flex-col rounded-md border px-3 py-2 text-sm")}>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={showTraders}
                    onCheckedChange={setShowTraders}
                    aria-label="Show traders overlay"
                  />
                  <Label>Show traders</Label>
                  <span className="text-xs text-muted-foreground ml-2">
                    Traders mapped:{" "}
                    <span className="font-medium text-foreground">
                      {traderCount.toLocaleString()}
                    </span>
                  </span>
                </div>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
                  style={{
                    gridTemplateRows: showTraders && traderCount > 0 ? "1fr" : "0fr",
                  }}
                  aria-hidden={!(showTraders && traderCount > 0)}
                >
                  <div className="overflow-hidden min-h-0">
                    <div className="flex flex-wrap gap-1 pt-3">
                      {TRADER_TYPES.map((t, i) => {
                        const active = traderTypeFilterSet.has(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => toggleTraderType(t)}
                            tabIndex={showTraders && traderCount > 0 ? 0 : -1}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs cursor-pointer",
                              showTraders &&
                                traderCount > 0 &&
                                "animate-in fade-in-0 slide-in-from-top-1 fill-mode-both",
                              "transition-colors duration-150",
                              active ? "bg-foreground text-background" : "bg-background",
                            )}
                            style={{
                              borderColor: TRADER_TYPE_COLORS[t],
                              animationDelay: `${i * 35}ms`,
                              animationDuration: "260ms",
                            }}
                            aria-pressed={active}
                          >
                            <span
                              aria-hidden
                              className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                              style={{ backgroundColor: TRADER_TYPE_COLORS[t] }}
                            />
                            {TRADER_TYPE_LABELS[t]}
                          </button>
                        );
                      })}
                      {traderTypeFilterSet.size > 0 && (
                        <span
                          className={cn(
                            "text-xs text-muted-foreground ml-1 self-center",
                            showTraders && traderCount > 0 && "animate-in fade-in-0 fill-mode-both",
                          )}
                          style={{
                            animationDelay: `${TRADER_TYPES.length * 35}ms`,
                            animationDuration: "260ms",
                          }}
                        >
                          Showing {traderTypeFilterSet.size} of {TRADER_TYPES.length} types
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <LandmarkManagementCard onLandmarksChanged={reloadLandmarks} />
            {hasMap && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="landmark-search" className="text-sm">
                  Search landmark
                </Label>
                <Combobox
                  id="landmark-search"
                  placeholder="Type to search…"
                  value={landmarkSearch}
                  suggestions={landmarkSuggestions}
                  onChange={setLandmarkSearch}
                  onSelect={handleLandmarkSelect}
                />
              </div>
            )}
            {error && <p className="text-red-500 text-sm">{error}</p>}
            {stats && statsQuery.data && <MapStatsHeader stats={statsQuery.data} />}
            {isAdmin && selectedDeposit && (
              <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-3 py-2 text-sm">
                <Sparkles className="size-4 text-primary" />
                <span className="font-medium capitalize">{selectedDeposit.type}</span>
                <span className="text-muted-foreground font-mono text-xs">
                  ({selectedDeposit.x}, {selectedDeposit.y}, {selectedDeposit.z})
                </span>
                {selectedDeposit.qty != null && (
                  <span className="text-xs text-muted-foreground">
                    qty {selectedDeposit.qty.toFixed(2)}
                  </span>
                )}
                {selectedDeposit.richness != null && (
                  <span className="text-xs text-muted-foreground">
                    richness {selectedDeposit.richness.toFixed(2)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  onClick={() => setSelectedDeposit(null)}
                  aria-label="Dismiss deposit info"
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </>
        )}
        <div className={isFullscreen ? "absolute inset-0" : "relative"}>
          <MapViewer
            tileSet={tileSet}
            stats={stats}
            alt="TOPS global server map"
            height={isFullscreen ? "calc(100vh - 3rem)" : undefined}
            showTLLegend={showTranslocators}
            showFullscreenControl
            starfield={starfieldEnabled}
            overlaySegments={visibleTranslocatorSegments}
            overlayPoints={landmarkPoints}
            onOverlaySegmentClick={showTranslocators ? handleTranslocatorClick : undefined}
            onOverlaySegmentRightClick={
              showTranslocators && !editingGrouping ? handleTranslocatorRightClick : undefined
            }
            highlightedSegment={
              showTranslocators && !editingGrouping && translocatorPinned
                ? selectedTranslocator
                : undefined
            }
            highlightedSegments={highlightedTranslocatorSegments}
            focusPoint={landmarkFocusPoint}
            enhanceTilesFn={hasMap && completedLevels.length > 1 ? selectLevelForZoom : undefined}
            initialView={initialUrlParams.initialView ?? favoriteInitialViewRef.current}
            onViewportChange={handleViewportChange}
            onTileSetEnhanced={(next) => {
              // Persist the upgrade so future page loads start at the higher
              // level. Runs after MapViewer's internal swap, so the resulting
              // tileSet prop change is recognised as already-adopted (Case 1
              // in the tileSet?.id effect) and doesn't re-scale pan/zoom.
              const lvl = typeof next.id === "number" ? next.id : Number(next.id);
              if (Number.isFinite(lvl)) setSelectedLevel(lvl);
            }}
            overlay={
              isAdmin && tileSet ? (
                <ResourcesOverlayLayer
                  state={resourcesOverlay}
                  stats={stats}
                  imageWidth={tileSet.imageWidth}
                  imageHeight={tileSet.imageHeight}
                  onDepositClick={setSelectedDeposit}
                  selectedDeposit={selectedDeposit}
                />
              ) : null
            }
            cursorMode={routePickMode ? "pick" : "default"}
            onWorldClick={handleRouteWorldClick}
            routeOverlay={routeOverlay}
          />
          {showTranslocators && selectedTranslocator && (
            <SelectedTranslocatorHeader
              selectedTranslocator={selectedTranslocator}
              translocatorPinned={translocatorPinned}
              handleUnpinTranslocator={handleUnpinTranslocator}
              onClose={() => {
                handleUnpinTranslocator();
                setSelectedTranslocator(null);
              }}
            />
          )}
          {isFullscreen && (
            <FullscreenControlsOverlay
              translocatorCount={translocatorCount}
              visibleTranslocatorCount={visibleTranslocatorSegments?.length ?? translocatorCount}
              filteringActive={filteringActive}
              landmarkCount={landmarkCount}
              traderCount={traderCount}
              recentTLCount={recentTLIdSet.size}
              activeGroupingCount={activeGroupingIds.size}
              onOpenGroupings={() => setGroupingsOpen(true)}
              landmarkSearch={landmarkSearch}
              landmarkSuggestions={landmarkSuggestions}
              onLandmarkSearchChange={setLandmarkSearch}
              onLandmarkSelect={handleLandmarkSelect}
              favoriteStartingPosition={favoriteStartingPosition}
              canSaveCurrentAsHome={lastViewportRef.current != null}
              onJumpHome={handleJumpHome}
              onSaveCurrentAsHome={handleSetCurrentAsHome}
              onClearHome={clearFavoriteStartingPosition}
            />
          )}
        </div>
        <TLGroupingsDrawer
          open={groupingsOpen}
          onOpenChange={setGroupingsOpen}
          store={groupingsStore}
          allSegments={translocatorSegments}
          viewMode={groupingsViewMode}
          onViewModeChange={setGroupingsViewMode}
          activeGroupingIds={activeGroupingIds}
          onToggleActive={toggleActiveGrouping}
          editingGroupingId={editingGroupingId}
          onStartEditing={(id) => {
            setEditingGroupingId(id);
            setGroupingsOpen(false);
          }}
          onStopEditing={() => setEditingGroupingId(null)}
        />
        <RoutePlannerPanel />
        {/* {isAdmin && (
          <ResourcesDrawer
            open={resourcesDrawerOpen}
            onOpenChange={setResourcesDrawerOpen}
            state={resourcesOverlay}
          />
        )} */}
      </CardContent>
    </Card>
  );
}
