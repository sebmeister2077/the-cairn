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
  type MapStats,
  type MapTileSet,
  type WorldLineSegment,
  type WorldPointMarker,
} from "@/components/MapViewer";
import { AdminResolutionPanel } from "@/components/AdminResolutionPanel";
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
import { Download, Loader2, Pin, PinOff, Settings } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STALE_TIME = 12 * 60 * 60 * 1000; // 12 hours
const SELECTED_LEVEL_STORAGE_KEY = "tops-map-selected-level";

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

          const props = (feature?.properties ?? {}) as {
            label: string;
            type: "Base" | "Server" | "Misc" | string;
            z: number;
          };

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
      // While a TL is pinned, ignore all map clicks (empty space or other TLs)
      // — only the explicit unpin button can clear the selection.
      if (translocatorPinned) return;
      if (!seg) {
        setSelectedTranslocator(null);
        return;
      }
      setSelectedTranslocator(seg);
    },
    [translocatorPinned],
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
    if (!showTranslocators) {
      setTranslocatorSegments([]);
      return;
    }

    let cancelled = false;
    ensureTranslocatorsLoaded()
      .then((segments) => {
        if (!cancelled) setTranslocatorSegments(segments);
      })
      .catch(() => {
        if (!cancelled) setTranslocatorSegments([]);
      });

    return () => {
      cancelled = true;
    };
  }, [showTranslocators, ensureTranslocatorsLoaded]);

  useEffect(() => {
    if (!showLandmarks) {
      setLandmarkPoints([]);
      return;
    }

    let cancelled = false;
    ensureLandmarksLoaded()
      .then((points) => {
        if (!cancelled) setLandmarkPoints(points);
      })
      .catch(() => {
        if (!cancelled) setLandmarkPoints([]);
      });

    return () => {
      cancelled = true;
    };
  }, [showLandmarks, ensureLandmarksLoaded]);

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
      // Persist the upgrade so future page loads start at the higher level.
      setSelectedLevel(candidate.level);
      return levelToTileSet(info);
    },
    [statsQuery.data?.resolutions, selectedLevel, queryClient],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>TOPS Map Viewer</CardTitle>
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
                      {r.level === 5 ? "Full resolution" : `${r.max_dimension.toLocaleString()} px`}
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
              {translocatorCount.toLocaleString()}
            </span>
          </span>
        </div>
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
          overlaySegments={showTranslocators ? translocatorSegments : undefined}
          overlayPoints={showLandmarks ? landmarkPoints : undefined}
          onOverlaySegmentClick={showTranslocators ? handleTranslocatorClick : undefined}
          onOverlaySegmentRightClick={showTranslocators ? handleTranslocatorRightClick : undefined}
          highlightedSegment={
            showTranslocators && translocatorPinned ? selectedTranslocator : undefined
          }
          focusPoint={landmarkFocusPoint}
          enhanceTilesFn={hasMap && completedLevels.length > 1 ? enhanceToHigherLevel : undefined}
        />
      </CardContent>
    </Card>
  );
}
