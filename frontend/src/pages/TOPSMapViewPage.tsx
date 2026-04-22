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
import { Download, Loader2, Settings } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STALE_TIME = 60 * 60 * 1000; // 1 hour
const TL_FILTER_CENTER = { x: 2250, z: 12500 };
const TL_FILTER_RADIUS = 500;
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

interface TopsMapStatsResponse extends MapStats {
  default_level?: number | null;
  resolutions?: TopsMapResolutionMeta[];
}

export function TOPSMapViewPage() {
  const queryClient = useQueryClient();
  const isAdmin = getStoredIsAdmin();
  const [showTranslocators, setShowTranslocators] = useState(false);
  const [showLocalRadiusOnly, setShowLocalRadiusOnly] = useState(false);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const [translocatorSegments, setTranslocatorSegments] = useState<WorldLineSegment[]>([]);
  const [translocatorCount, setTranslocatorCount] = useState(0);
  const [selectedTranslocator, setSelectedTranslocator] = useState<WorldLineSegment | null>(null);
  const [landmarkPoints, setLandmarkPoints] = useState<WorldPointMarker[]>([]);
  const [landmarkCount, setLandmarkCount] = useState(0);
  const [landmarkSearch, setLandmarkSearch] = useState("");
  const [landmarkFocusPoint, setLandmarkFocusPoint] = useState<{ x: number; z: number } | undefined>(undefined);
  const translocatorCacheRef = useRef<WorldLineSegment[] | null>(null);
  const translocatorLoadPromiseRef = useRef<Promise<WorldLineSegment[]> | null>(null);
  const landmarkCacheRef = useRef<WorldPointMarker[] | null>(null);
  const landmarkLoadPromiseRef = useRef<Promise<WorldPointMarker[]> | null>(null);

  // Shared landmark loader — can be called from overlay toggle or search box.
  const ensureLandmarksLoaded = useCallback(() => {
    if (landmarkCacheRef.current) {
      setLandmarkPoints(landmarkCacheRef.current);
      setLandmarkCount(landmarkCacheRef.current.length);
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

          const props = (feature?.properties ?? {}) as Record<string, unknown>;
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
    }

    landmarkLoadPromiseRef.current
      .then((points) => {
        setLandmarkPoints(points);
        setLandmarkCount(points.length);
      })
      .catch(() => {
        landmarkLoadPromiseRef.current = null;
      });

    return landmarkLoadPromiseRef.current;
  }, []);

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
    const desired = selectedLevel ?? statsQuery.data.default_level ?? completedLevels[completedLevels.length - 1];
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

  const imageQuery = useQuery<Blob>({
    queryKey: ["tops-map-render", selectedLevel],
    queryFn: async () => {
      if (selectedLevel == null) {
        throw new Error("No resolution level available yet");
      }
      const levelInfo = await queryClient.fetchQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", selectedLevel],
        queryFn: () => getTopsMapLevel(selectedLevel),
        // Reuse the persisted cached URLs while they're still valid.
        staleTime: ({ state }) => levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
        gcTime: 7 * 24 * 60 * 60 * 1000,
        meta: { persist: true },
      });
      if (!levelInfo.chunks?.length) {
        throw new Error("This resolution has no chunks yet");
      }
      // Stitch chunks client-side. The browser HTTP cache reuses each chunk
      // image as long as the presigned URL stays the same (which it does until
      // the backend rotates it on expiry).
      return stitchChunksToBlob(levelInfo);
    },
    staleTime: STALE_TIME,
    enabled: statsQuery.isSuccess && selectedLevel != null,
  });

  const stats = statsQuery.data ?? null;
  const imageBlob = imageQuery.data ?? null;
  const baseImageUrl = useMemo(
    () => (imageBlob ? URL.createObjectURL(imageBlob) : null),
    [imageBlob],
  );

  // Revoke base object URL when it changes (enhanced URLs are managed by MapViewer)
  useEffect(() => {
    return () => {
      if (baseImageUrl) URL.revokeObjectURL(baseImageUrl);
    };
  }, [baseImageUrl]);

  // Derive loading / error from query states
  const loading = statsQuery.isFetching
    ? "Reading global server map…"
    : imageQuery.isFetching
      ? "Rendering map image… This may take a moment for large maps."
      : "";
  const error =
    statsQuery.error instanceof Error
      ? statsQuery.error.message
      : imageQuery.error instanceof Error
        ? imageQuery.error.message
        : "";

  const visibleTranslocatorSegments = useMemo(() => {
    if (!showLocalRadiusOnly) return translocatorSegments;

    const cx = TL_FILTER_CENTER.x;
    const cz = TL_FILTER_CENTER.z;
    const r2 = TL_FILTER_RADIUS * TL_FILTER_RADIUS;

    const pointDistSq = (x: number, z: number) => {
      const dx = x - cx;
      const dz = z - cz;
      return dx * dx + dz * dz;
    };

    // Include a TL when either endpoint is inside the target radius.
    return translocatorSegments.filter(
      (seg) => pointDistSq(seg.x1, seg.z1) <= r2 || pointDistSq(seg.x2, seg.z2) <= r2,
    );
  }, [showLocalRadiusOnly, translocatorSegments]);

  useEffect(() => {
    if (!showTranslocators) {
      setSelectedTranslocator(null);
      return;
    }
    if (!selectedTranslocator) return;
    const stillVisible = visibleTranslocatorSegments.some(
      (seg) =>
        seg.x1 === selectedTranslocator.x1 &&
        seg.z1 === selectedTranslocator.z1 &&
        seg.x2 === selectedTranslocator.x2 &&
        seg.z2 === selectedTranslocator.z2,
    );
    if (!stillVisible) setSelectedTranslocator(null);
  }, [selectedTranslocator, showTranslocators, visibleTranslocatorSegments]);

  useEffect(() => {
    if (!isAdmin || !showTranslocators) {
      setTranslocatorSegments([]);
      return;
    }

    if (translocatorCacheRef.current) {
      setTranslocatorSegments(translocatorCacheRef.current);
      setTranslocatorCount(translocatorCacheRef.current.length);
      return;
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
    }

    let cancelled = false;
    translocatorLoadPromiseRef.current
      .then((segments) => {
        if (!cancelled) {
          setTranslocatorSegments(segments);
          setTranslocatorCount(segments.length);
        }
      })
      .catch(() => {
        if (!cancelled) setTranslocatorSegments([]);
        // Allow retry if the initial load fails.
        translocatorLoadPromiseRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, showTranslocators]);

  useEffect(() => {
    if (!isAdmin || !showLandmarks) {
      setLandmarkPoints([]);
      return;
    }
    void ensureLandmarksLoaded();
  }, [isAdmin, showLandmarks, ensureLandmarksLoaded]);

  function handleReload() {
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-level"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-render"] });
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
    const match = (landmarkCacheRef.current ?? landmarkPoints).find(
      (pt) => (pt.label?.replace(/\s+/g, " ").trim().toLowerCase() ?? "") === normalised,
    );
    if (match) {
      setLandmarkFocusPoint({ x: match.x, z: match.z });
      if (!showLandmarks) setShowLandmarks(true);
    }
  }

  function handleDownload() {
    if (!baseImageUrl) return;
    const a = document.createElement("a");
    a.href = baseImageUrl;
    a.download = "tops-server-map.png";
    a.click();
  }

  // Auto-enhance: when zoomed in past current resolution, fetch the next
  // higher completed level and stitch it (no-op if already at the top).
  const enhanceToHigherLevel = useCallback(
    async (targetMaxDim: number): Promise<Blob> => {
      const resolutions = statsQuery.data?.resolutions ?? [];
      const completed = resolutions.filter((r) => r.status === "complete");
      const candidate =
        completed.find((r) => r.max_dimension >= targetMaxDim && r.level > (selectedLevel ?? 0))
        ?? completed[completed.length - 1];
      if (!candidate) {
        throw new Error("No higher resolution available");
      }
      const info = await queryClient.fetchQuery<TopsMapLevelChunks>({
        queryKey: ["tops-map-level", candidate.level],
        queryFn: () => getTopsMapLevel(candidate.level),
        staleTime: ({ state }) => levelInfoStaleTimeMs(state.data as TopsMapLevelChunks | undefined),
        gcTime: 7 * 24 * 60 * 60 * 1000,
        meta: { persist: true },
      });
      if (!info.chunks?.length) throw new Error("Higher-resolution chunks unavailable");
      const blob = await stitchChunksToBlob(info);
      // Update selected level so future picks reflect the upgrade.
      setSelectedLevel(candidate.level);
      return blob;
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
          {!loading && baseImageUrl && (
            <>
              <Button type="button" variant="outline" onClick={handleDownload}>
                <Download className="size-4 mr-1" />
                Download PNG
              </Button>
              <Button type="button" variant="outline" onClick={handleReload}>
                Reload
              </Button>
            </>
          )}
          {!loading && !baseImageUrl && error && (
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
                      L{r.level} · {r.max_dimension.toLocaleString()} px
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
                    queryClient.invalidateQueries({ queryKey: ["tops-map-render"] });
                  }}
                />
              </DialogContent>
            </Dialog>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Switch
              checked={showTranslocators}
              onCheckedChange={setShowTranslocators}
              aria-label="Show translocator overlay"
            />
            <Label>Show translocators (admin only)</Label>
            <span className="text-xs text-muted-foreground ml-2">
              TLs found: <span className="font-medium text-foreground">{translocatorCount.toLocaleString()}</span>
            </span>
          </div>
        )}
        {isAdmin && showTranslocators && (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Switch
              checked={showLocalRadiusOnly}
              onCheckedChange={setShowLocalRadiusOnly}
              aria-label="Show only TLs near 2250, 12500"
            />
            <Label>
              Show only TLs near X {TL_FILTER_CENTER.x.toLocaleString()}, Z {TL_FILTER_CENTER.z.toLocaleString()} ({TL_FILTER_RADIUS.toLocaleString()} radius)
            </Label>
            <span className="text-xs text-muted-foreground ml-2">
              Showing: <span className="font-medium text-foreground">{visibleTranslocatorSegments.length.toLocaleString()}</span>
            </span>
          </div>
        )}
        {isAdmin && (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Switch
              checked={showLandmarks}
              onCheckedChange={setShowLandmarks}
              aria-label="Show landmarks overlay"
            />
            <Label>Show landmarks (admin only)</Label>
            <span className="text-xs text-muted-foreground ml-2">
              Landmarks found: <span className="font-medium text-foreground">{landmarkCount.toLocaleString()}</span>
            </span>
          </div>
        )}
        {isAdmin && baseImageUrl && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="landmark-search" className="text-sm">Search landmark</Label>
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

        {isAdmin && showTranslocators && selectedTranslocator && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span>
              Start: <span className="font-medium text-foreground">X {selectedTranslocator.x1.toLocaleString()}, Z {selectedTranslocator.z1.toLocaleString()}</span>
            </span>
            <span>
              End: <span className="font-medium text-foreground">X {selectedTranslocator.x2.toLocaleString()}, Z {selectedTranslocator.z2.toLocaleString()}</span>
            </span>
          </div>
        )}

        {stats && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span><span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span> map tiles</span>
            <span><span className="font-medium text-foreground">{stats.size_mb}</span> MB</span>
            <span><span className="font-medium text-foreground">{stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}</span> blocks</span>
          </div>
        )}

        <MapViewer
          imageUrl={baseImageUrl}
          stats={stats}
          alt="TOPS global server map"
          overlaySegments={showTranslocators ? visibleTranslocatorSegments : undefined}
          overlayPoints={showLandmarks ? landmarkPoints : undefined}
          onOverlaySegmentClick={showTranslocators ? setSelectedTranslocator : undefined}
          focusPoint={landmarkFocusPoint}
          enhanceFn={baseImageUrl && completedLevels.length > 1 ? enhanceToHigherLevel : undefined}
        />
      </CardContent>
    </Card>
  );
}
