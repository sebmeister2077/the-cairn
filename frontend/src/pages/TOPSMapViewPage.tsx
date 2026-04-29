import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTopsMapStats,
  getTopsMapLevel,
  getStoredIsAdmin,
  type TopsMapResolutionMeta,
  type TopsMapLevelChunks,
} from "@/lib/api";
import { stitchChunksToBlob } from "@/lib/stitch-chunks";
import {
  MapViewer,
  type LandmarkProperty,
  type MapStats,
  type MapTileSet,
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
import { Download, Layers, Loader2, Pin, PinOff, Settings } from "lucide-react";
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
import { tlIdFor, useTLGroupings } from "@/lib/tl-groupings";
import { useEffectWithAbort } from "@/hooks/useEffectWithAbort";

const STALE_TIME = 12 * 60 * 60 * 1000; // 12 hours
const SELECTED_LEVEL_STORAGE_KEY = "tops-map-selected-level";
const GROUPINGS_VIEW_MODE_STORAGE_KEY = "tops-map-tl-groupings-view-mode";
const GROUPINGS_ACTIVE_STORAGE_KEY = "tops-map-tl-groupings-active";

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
 * Boundary tiles use the remainder dimensions so they line up exactly with
 * the assembled image bounds.
 */
function levelToTileSet(info: TopsMapLevelChunks): MapTileSet {
  return {
    // Identity is just the level number. URL rotations keep the same id so
    // the viewer doesn't reset pan/zoom every time presigned URLs refresh.
    id: info.level,
    imageWidth: info.image_w,
    imageHeight: info.image_h,
    tiles: info.chunks.map((c) => {
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
  const isAdmin = getStoredIsAdmin();
  const [showTranslocators, setShowTranslocators] = useState(false);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const [translocatorSegments, setTranslocatorSegments] = useState<WorldLineSegment[]>([]);
  const [translocatorCount, setTranslocatorCount] = useState(0);
  const [selectedTranslocator, setSelectedTranslocator] = useState<WorldLineSegment | null>(null);
  // When pinned, the displayed TL info stays put even if the user left-clicks
  // empty space. Cleared by clicking the pin icon, or by clicking any other TL
  // (which then becomes the new selection — pinned only if right-clicked).
  const [translocatorPinned, setTranslocatorPinned] = useState(false);
  const [landmarkPoints, setLandmarkPoints] = useState<WorldPointMarker[]>([]);
  const [landmarkCount, setLandmarkCount] = useState(0);
  const [landmarkSearch, setLandmarkSearch] = useState("");
  const [landmarkFocusPoint, setLandmarkFocusPoint] = useState<
    { x: number; z: number } | undefined
  >(undefined);
  const translocatorCacheRef = useRef<WorldLineSegment[] | null>(null);
  const translocatorLoadPromiseRef = useRef<Promise<WorldLineSegment[]> | null>(null);
  const landmarkCacheRef = useRef<WorldPointMarker[] | null>(null);
  const landmarkLoadPromiseRef = useRef<Promise<WorldPointMarker[]> | null>(null);

  // Favorite TL groupings (local-only). The groupings themselves persist via
  // `useTLGroupings`; view-mode + active-selection are persisted separately so
  // a reload returns the user to the same overlay state.
  const groupingsStore = useTLGroupings();
  const [groupingsOpen, setGroupingsOpen] = useState(false);
  const [groupingsViewMode, setGroupingsViewMode] = useState<TLGroupingsViewMode>(() => {
    if (typeof window === "undefined") return "all";
    const stored = window.localStorage.getItem(GROUPINGS_VIEW_MODE_STORAGE_KEY);
    return stored === "filter" || stored === "highlight" || stored === "all" ? stored : "all";
  });
  const [activeGroupingIds, setActiveGroupingIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(GROUPINGS_ACTIVE_STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      // fall through
    }
    return new Set();
  });
  const [editingGroupingId, setEditingGroupingId] = useState<string | null>(null);

  // Persist view mode + active selection on change.
  useEffect(() => {
    window.localStorage.setItem(GROUPINGS_VIEW_MODE_STORAGE_KEY, groupingsViewMode);
  }, [groupingsViewMode]);
  useEffect(() => {
    window.localStorage.setItem(
      GROUPINGS_ACTIVE_STORAGE_KEY,
      JSON.stringify(Array.from(activeGroupingIds)),
    );
  }, [activeGroupingIds]);

  const toggleActiveGrouping = useCallback((id: string) => {
    setActiveGroupingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  // Shared landmark loader — populates the cache and count without forcing
  // the overlay on. Callers that need the rendered points (overlay toggle or
  // landmark search) should consume the resolved promise themselves.
  const ensureLandmarksLoaded = useCallback(() => {
    if (landmarkCacheRef.current) {
      return landmarkLoadPromiseRef.current ?? Promise.resolve(landmarkCacheRef.current);
    }

    if (!landmarkLoadPromiseRef.current) {
      const dataUrl = new URL("../assets/landmarks.geojson", import.meta.url).href;
      landmarkLoadPromiseRef.current = (async () => {
        const res = await fetch(dataUrl);
        if (!res.ok) throw new Error(`Failed to load landmark data (${res.status})`);
        const data = await res.json();

        const features = Array.isArray(data?.features) ? data.features : [];
        const points: WorldPointMarker[] = [];

        for (const feature of features) {
          const geometry = feature?.geometry;
          if (!geometry || geometry.type !== "Point") continue;
          const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
          const [x, z] = coords;
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

          const props = (feature?.properties ?? {}) as LandmarkProperty;

          if (props.type === "Misc") continue;

          points.push({
            x,
            z: -z,
            label: typeof props.label === "string" ? props.label : undefined,
            kind: typeof props.type === "string" ? props.type : undefined,
          });
        }

        landmarkCacheRef.current = points;
        setLandmarkCount(points.length);
        return points;
      })();
      landmarkLoadPromiseRef.current.catch(() => {
        // Allow retry on next call if the fetch failed.
        landmarkLoadPromiseRef.current = null;
      });
    }

    return landmarkLoadPromiseRef.current;
  }, []);

  // Same pattern for translocators — populate cache + count on demand without
  // touching the rendered segments state.
  const ensureTranslocatorsLoaded = useCallback(() => {
    if (translocatorCacheRef.current) {
      return translocatorLoadPromiseRef.current ?? Promise.resolve(translocatorCacheRef.current);
    }

    if (!translocatorLoadPromiseRef.current) {
      const dataUrl = new URL("../assets/translocators.geojson", import.meta.url).href;
      translocatorLoadPromiseRef.current = (async () => {
        const res = await fetch(dataUrl);
        if (!res.ok) throw new Error(`Failed to load translocator data (${res.status})`);
        const data = await res.json();

        const features = Array.isArray(data?.features) ? data.features : [];
        const segments: WorldLineSegment[] = [];

        for (const feature of features) {
          const geometry = feature?.geometry;
          if (!geometry || geometry.type !== "LineString") continue;
          const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
          for (let i = 1; i < coords.length; i++) {
            const [x1, z1raw] = coords[i - 1] ?? [];
            const [x2, z2raw] = coords[i] ?? [];
            const z1 = -z1raw;
            const z2 = -z2raw;
            if (
              Number.isFinite(x1) &&
              Number.isFinite(z1) &&
              Number.isFinite(x2) &&
              Number.isFinite(z2)
            ) {
              segments.push({ x1, z1, x2, z2 });
            }
          }
        }

        translocatorCacheRef.current = segments;
        setTranslocatorCount(segments.length);
        return segments;
      })();
      translocatorLoadPromiseRef.current.catch(() => {
        translocatorLoadPromiseRef.current = null;
      });
    }

    return translocatorLoadPromiseRef.current;
  }, []);

  // Load both overlay data files on mount so the "TLs found" / "Landmarks
  // found" counts populate without requiring the user to toggle the overlays.
  useEffect(() => {
    void ensureTranslocatorsLoaded();
    void ensureLandmarksLoaded();
  }, [ensureTranslocatorsLoaded, ensureLandmarksLoaded]);

  const statsQuery = useQuery<TopsMapStatsResponse>({
    queryKey: ["tops-map-stats"],
    queryFn: getTopsMapStats,
    staleTime: STALE_TIME,
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

  const [selectedLevel, setSelectedLevel] = useState<number | null>(() => {
    const stored = localStorage.getItem(SELECTED_LEVEL_STORAGE_KEY);
    return stored ? Number(stored) : null;
  });

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
  }, [completedLevels, statsQuery.data, selectedLevel]);

  // Persist user's chosen level.
  useEffect(() => {
    if (selectedLevel != null) {
      localStorage.setItem(SELECTED_LEVEL_STORAGE_KEY, String(selectedLevel));
    }
  }, [selectedLevel]);

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
    enabled: statsQuery.isSuccess && selectedLevel != null,
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
  const stats = useMemo<MapStats | null>(() => {
    if (statsQuery.data) return statsQuery.data;
    const info = levelInfoQuery.data;
    if (!info || isLevelInfoExpired(info)) return null;
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

  // Derive loading / error from query states
  const loading = statsQuery.isFetching
    ? "Reading global server map…"
    : levelInfoQuery.isFetching && !tileSet
      ? "Loading map tiles…"
      : "";
  const error =
    statsQuery.error instanceof Error
      ? statsQuery.error.message
      : levelInfoQuery.error instanceof Error
        ? levelInfoQuery.error.message
        : "";

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

  useEffect(() => {
    // Always populate the segments state once the cache is loaded \u2014 the
    // groupings drawer needs them for "missing" counts and edit-mode
    // rendering even before the user toggles the overlay on.
    useEffectWithAbort(
      ({ signal }) => {
        ensureTranslocatorsLoaded()
          .then((segments) => {
            if (signal.aborted) return;
            setTranslocatorSegments(segments);
          })
          .catch(() => {
            if (signal.aborted) return;
            setTranslocatorSegments([]);
          });
      },
      [ensureTranslocatorsLoaded],
    );
  }, [ensureTranslocatorsLoaded]);

  useEffectWithAbort(
    ({ signal }) => {
      ensureLandmarksLoaded()
        .then((points) => {
          if (signal.aborted) return;
          if (!showLandmarks) {
            setLandmarkPoints(points.filter((p) => p.kind === "Server"));
            return;
          }
          setLandmarkPoints(points);
        })
        .catch(() => {
          if (signal.aborted) return;
          setLandmarkPoints([]);
        });
    },
    [showLandmarks, ensureLandmarksLoaded],
  );

  function handleReload() {
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-level"] });
  }

  const landmarkSuggestions = useMemo(
    () =>
      (landmarkCacheRef.current ?? landmarkPoints)
        .map((pt) => pt.label?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [landmarkPoints],
  );

  function handleLandmarkSelect(name: string) {
    setLandmarkSearch(name);
    const normalised = name.replace(/\s+/g, " ").trim().toLowerCase();
    void ensureLandmarksLoaded().then((points) => {
      const match = points.find(
        (pt) => (pt.label?.replace(/\s+/g, " ").trim().toLowerCase() ?? "") === normalised,
      );
      if (match) {
        setLandmarkFocusPoint({ x: match.x, z: match.z });
        setShowLandmarks(true);
      }
    });
  }

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

  // Auto-enhance: when zoomed in past current resolution, fetch the next
  // higher completed level and hand its tile set to the viewer (no stitching).
  const enhanceToHigherLevel = useCallback(
    async (targetMaxDim: number): Promise<MapTileSet> => {
      const resolutions = statsQuery.data?.resolutions ?? [];
      const completed = resolutions.filter((r) => r.status === "complete");
      const candidate =
        completed.find((r) => r.max_dimension >= targetMaxDim && r.level > (selectedLevel ?? 0)) ??
        completed[completed.length - 1];
      if (!candidate) {
        throw new Error("No higher resolution available");
      }
      const info = await queryClient.fetchQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", candidate.level],
        queryFn: () => getTopsMapLevel(candidate.level),
        staleTime: ({ state }) =>
          levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
        gcTime: 7 * 24 * 60 * 60 * 1000,
        meta: { persist: true },
      });
      if (!info.chunks?.length) throw new Error("Higher-resolution chunks unavailable");
      // Note: we deliberately do NOT call setSelectedLevel here. The parent
      // updating its `tileSet` prop in the middle of MapViewer's async swap
      // causes both sides to apply scale compensation (the prop-change effect
      // *and* the post-await branch of auto-enhance), leaving pan/zoom
      // double-scaled and the viewport outside all tiles — the map appears
      // blank until "Center view" is pressed. Defer the level update to
      // `onTileSetEnhanced` (fires after the internal swap is done) so the
      // tileSet?.id effect takes the Case-1 fast path and just drops the
      // override without touching pan/zoom.
      return levelToTileSet(info);
    },
    [statsQuery.data?.resolutions, selectedLevel, queryClient],
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

  // Segments the viewer renders. In edit mode we always show every TL so the
  // user can click any of them; otherwise filter mode narrows the set.
  const visibleTranslocatorSegments = useMemo(() => {
    if (!showTranslocators) return undefined;
    if (editingGrouping) return translocatorSegments;
    if (groupingsViewMode === "filter" && activeTLIdSet.size > 0) {
      return translocatorSegments.filter((seg) => activeTLIdSet.has(tlIdFor(seg)));
    }
    return translocatorSegments;
  }, [showTranslocators, editingGrouping, groupingsViewMode, activeTLIdSet, translocatorSegments]);

  // Segments the viewer should highlight. In edit mode = current grouping's
  // members; in highlight mode = active grouping union; otherwise none.
  const highlightedTranslocatorSegments = useMemo(() => {
    if (!showTranslocators) return undefined;
    if (editingGrouping) {
      const memberSet = new Set(editingGrouping.tlIds);
      const out = translocatorSegments.filter((seg) => memberSet.has(tlIdFor(seg)));
      return out.length > 0 ? out : undefined;
    }
    if (groupingsViewMode === "highlight" && activeTLIdSet.size > 0) {
      const out = translocatorSegments.filter((seg) => activeTLIdSet.has(tlIdFor(seg)));
      return out.length > 0 ? out : undefined;
    }
    return undefined;
  }, [showTranslocators, editingGrouping, groupingsViewMode, activeTLIdSet, translocatorSegments]);

  const filteringActive =
    !editingGrouping &&
    groupingsViewMode === "filter" &&
    activeTLIdSet.size > 0 &&
    visibleTranslocatorSegments != null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>TOPS Map Viewer</span>
          <MaintenanceChip component="tops_map_viewer" />
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Explore the community-contributed global server map built from player contributions.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
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
              <Button type="button" variant="outline" onClick={handleReload}>
                Reload
              </Button>
            </>
          )}
          {!loading && !hasMap && error && (
            <Button type="button" onClick={handleReload}>
              Retry
            </Button>
          )}

          {/* Resolution selector — visible whenever multiple completed levels exist. */}
          {completedLevels.length > 1 && selectedLevel != null && (
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="tops-map-resolution" className="text-xs text-muted-foreground">
                Resolution
              </Label>
              <Select
                value={String(selectedLevel)}
                onValueChange={(v) => setSelectedLevel(Number(v))}
              >
                <SelectTrigger id="tops-map-resolution" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(statsQuery.data?.resolutions ?? []).map((r) => (
                    <SelectItem
                      key={r.level}
                      value={String(r.level)}
                      disabled={r.status !== "complete"}
                    >
                      L{r.level} ·{" "}
                      {r.level === 5
                        ? "Native 1:1 (10× L4)"
                        : `${r.max_dimension.toLocaleString()} px`}
                      {r.status !== "complete" ? ` · ${r.status}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              <DialogContent className="sm:max-w-3xl">
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
        </div>
        {editingGrouping && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-primary bg-primary/5 px-4 py-3 text-sm">
            <span>
              Editing: <span className="font-medium">{editingGrouping.name}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Click TLs on the map to add or remove. {editingGrouping.tlIds.length} selected.
            </span>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="ml-auto h-7"
              onClick={() => setEditingGroupingId(null)}
            >
              Done
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Switch
            checked={showLandmarks}
            onCheckedChange={setShowLandmarks}
            aria-label="Show landmarks overlay"
          />
          <Label>Show landmarks</Label>
          <span className="text-xs text-muted-foreground ml-2">
            Landmarks found:{" "}
            <span className="font-medium text-foreground">{landmarkCount.toLocaleString()}</span>
          </span>
        </div>
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
              onFocus={() => void ensureLandmarksLoaded()}
            />
          </div>
        )}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {showTranslocators && selectedTranslocator && (
          <div className="flex flex-wrap min-h-14 items-center gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span>
              Start:{" "}
              <span className="font-medium text-foreground">
                X {selectedTranslocator.x1.toLocaleString()}, Z{" "}
                {selectedTranslocator.z1.toLocaleString()}
              </span>
            </span>
            <span>
              End:{" "}
              <span className="font-medium text-foreground">
                X {selectedTranslocator.x2.toLocaleString()}, Z{" "}
                {selectedTranslocator.z2.toLocaleString()}
              </span>
            </span>
            {translocatorPinned && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleUnpinTranslocator}
                title="Unpin translocator (also unpins on clicking another TL)"
                className="ml-auto h-7 px-2 text-foreground"
              >
                <Pin className="size-4 mr-1 fill-current" />
                Pinned
                <PinOff className="size-4 ml-1" />
              </Button>
            )}
            {!translocatorPinned && (
              <span className="ml-auto text-xs text-muted-foreground">Right-click a TL to pin</span>
            )}
          </div>
        )}

        {stats && statsQuery.data && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span>
              <span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span>{" "}
              map tiles
            </span>
            <span>
              <span className="font-medium text-foreground">{stats.size_mb}</span> MB
            </span>
            <span>
              <span className="font-medium text-foreground">
                {stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}
              </span>{" "}
              blocks
            </span>
          </div>
        )}

        <MapViewer
          tileSet={tileSet}
          stats={stats}
          alt="TOPS global server map"
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
          enhanceTilesFn={hasMap && completedLevels.length > 1 ? enhanceToHigherLevel : undefined}
          onTileSetEnhanced={(next) => {
            // Persist the upgrade so future page loads start at the higher
            // level. Runs after MapViewer's internal swap, so the resulting
            // tileSet prop change is recognised as already-adopted (Case 1
            // in the tileSet?.id effect) and doesn't re-scale pan/zoom.
            const lvl = typeof next.id === "number" ? next.id : Number(next.id);
            if (Number.isFinite(lvl)) setSelectedLevel(lvl);
          }}
        />
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
      </CardContent>
    </Card>
  );
}
