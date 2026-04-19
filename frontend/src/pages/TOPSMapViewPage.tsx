import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTopsMapStats, renderTopsMap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ZoomIn, ZoomOut, Maximize, Download, Crosshair, Loader2 } from "lucide-react";

interface MapStats {
  pieces: number;
  size_mb: number;
  width_chunks: number;
  height_chunks: number;
  width_blocks: number;
  height_blocks: number;
  start_x: number;
  start_z: number;
}

const STALE_TIME = 60 * 60 * 1000; // 1 hour

export function TOPSMapViewPage() {
  const queryClient = useQueryClient();

  const statsQuery = useQuery<MapStats>({
    queryKey: ["tops-map-stats"],
    queryFn: getTopsMapStats,
    staleTime: STALE_TIME,
  });

  const imageQuery = useQuery<Blob>({
    queryKey: ["tops-map-render"],
    queryFn: () => renderTopsMap(),
    staleTime: STALE_TIME,
    enabled: statsQuery.isSuccess,
  });

  const stats = statsQuery.data ?? null;
  const imageBlob = imageQuery.data ?? null;
  const baseImageUrl = useMemo(
    () => (imageBlob ? URL.createObjectURL(imageBlob) : null),
    [imageBlob],
  );

  // Enhanced image overrides the base when the user zooms in
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);
  const imageUrl = enhancedUrl ?? baseImageUrl;

  // Revoke base object URL when it changes
  useEffect(() => {
    return () => {
      if (baseImageUrl) URL.revokeObjectURL(baseImageUrl);
    };
  }, [baseImageUrl]);

  // Clear enhanced URL when base image changes (e.g. after reload)
  useEffect(() => {
    if (enhancedUrl) {
      URL.revokeObjectURL(enhancedUrl);
      setEnhancedUrl(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const [renderedMaxDim, setRenderedMaxDim] = useState(4096);
  const [enhancing, setEnhancing] = useState(false);
  const enhanceAbortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // Auto-enhance
  useEffect(() => {
    if (!imageUrl || !stats || imgNatural.w === 0) return;

    const el = containerRef.current;
    if (!el) return;
    const viewportW = el.clientWidth;
    const visibleImgPx = viewportW / zoom;
    const neededMaxDim = Math.ceil((imgNatural.w / visibleImgPx) * viewportW);
    const target = Math.min(16384, Math.max(4096, neededMaxDim));
    if (target <= renderedMaxDim * 1.8) return;

    const timer = setTimeout(async () => {
      enhanceAbortRef.current?.abort();
      const abort = new AbortController();
      enhanceAbortRef.current = abort;

      setEnhancing(true);
      try {
        const blob = await renderTopsMap(target);
        if (abort.signal.aborted) return;

        const newUrl = URL.createObjectURL(blob);
        const tmpImg = new window.Image();
        tmpImg.src = newUrl;
        await new Promise<void>((res, rej) => {
          tmpImg.onload = () => res();
          tmpImg.onerror = () => rej();
        });
        if (abort.signal.aborted) { URL.revokeObjectURL(newUrl); return; }

        const newW = tmpImg.naturalWidth;
        const newH = tmpImg.naturalHeight;
        const oldW = imgNatural.w;

        const scaleW = newW / oldW;
        setPan((p) => ({ x: p.x * scaleW, y: p.y * scaleW }));
        setZoom((z) => z / scaleW);
        setImgNatural({ w: newW, h: newH });
        setRenderedMaxDim(target);

        const oldEnhanced = enhancedUrl;
        setEnhancedUrl(newUrl);
        if (oldEnhanced) URL.revokeObjectURL(oldEnhanced);
      } catch {
        // silently ignore
      } finally {
        if (!abort.signal.aborted) setEnhancing(false);
      }
    }, 800);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, imgNatural.w, renderedMaxDim]);

  useEffect(() => {
    return () => { enhanceAbortRef.current?.abort(); };
  }, []);

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
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomToward(e.clientX - rect.left, e.clientY - rect.top, zoomRef.current * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [imageUrl, zoomToward]);

  function handleReload() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoverCoords(null);
    setRenderedMaxDim(4096);
    setEnhancing(false);
    enhanceAbortRef.current?.abort();
    if (enhancedUrl) {
      URL.revokeObjectURL(enhancedUrl);
      setEnhancedUrl(null);
    }
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-render"] });
  }

  function handleDownload() {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = "tops-server-map.png";
    a.click();
  }

  const centerOnOrigin = useCallback((currentZoom?: number) => {
    const el = containerRef.current;
    if (!el || !stats || imgNatural.w === 0) return;
    const z = currentZoom ?? zoom;
    const rect = el.getBoundingClientRect();
    const imgX = ((0 - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const imgY = ((0 - stats.start_z) / stats.height_blocks) * imgNatural.h;
    setPan({ x: rect.width / 2 - imgX * z, y: rect.height / 2 - imgY * z });
  }, [stats, imgNatural, zoom]);

  const zoomIn = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomToward(rect.width / 2, rect.height / 2, zoomRef.current * 1.5);
  }, [zoomToward]);
  const zoomOut = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomToward(rect.width / 2, rect.height / 2, zoomRef.current / 1.5);
  }, [zoomToward]);
  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
      }

      if (containerRef.current && stats && imgNatural.w > 0) {
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const imgX = (mx - pan.x) / zoom;
        const imgY = (my - pan.y) / zoom;
        if (imgX >= 0 && imgX < imgNatural.w && imgY >= 0 && imgY < imgNatural.h) {
          const blockX = Math.floor((imgX / imgNatural.w) * stats.width_blocks + stats.start_x);
          const blockZ = Math.floor((imgY / imgNatural.h) * stats.height_blocks + stats.start_z);
          setHoverCoords({ x: blockX, z: blockZ });
        } else {
          setHoverCoords(null);
        }
      }
    },
    [dragging, dragStart, pan, zoom, stats, imgNatural],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);
  const handleMouseLeave = useCallback(() => {
    setDragging(false);
    setHoverCoords(null);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>TOPS Map Viewer</CardTitle>
        <p className="text-sm text-muted-foreground">
          Explore the community-contributed global server map built from player contributions.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex gap-2">
          {loading && (
            <Button disabled>
              <Loader2 className="size-4 mr-1 animate-spin" />
              {loading}
            </Button>
          )}
          {!loading && imageUrl && (
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
          {!loading && !imageUrl && error && (
            <Button type="button" onClick={handleReload}>
              Retry
            </Button>
          )}
        </div>
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {stats && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span><span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span> map tiles</span>
            <span><span className="font-medium text-foreground">{stats.size_mb}</span> MB</span>
            <span><span className="font-medium text-foreground">{stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}</span> blocks</span>
          </div>
        )}

        {imageUrl && (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="sm" onClick={zoomOut} title="Zoom out">
                <ZoomOut className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground w-14 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <Button type="button" variant="outline" size="sm" onClick={zoomIn} title="Zoom in">
                <ZoomIn className="size-4" />
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={resetView} title="Reset view">
                <Maximize className="size-4" />
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => centerOnOrigin()} title="Center on 0, 0">
                <Crosshair className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground ml-2">
                Scroll to zoom · Drag to pan
              </span>
              {enhancing && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
                  <Loader2 className="size-3 animate-spin" />
                  Enhancing…
                </span>
              )}
            </div>
            <div
              ref={containerRef}
              className="relative overflow-hidden rounded-md border bg-black/90"
              style={{ height: "70vh", cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt="TOPS global server map"
                draggable={false}
                className="absolute select-none"
                onLoad={() => {
                  if (imgRef.current && containerRef.current && stats) {
                    const w = imgRef.current.naturalWidth;
                    const h = imgRef.current.naturalHeight;
                    setImgNatural({ w, h });
                    const rect = containerRef.current.getBoundingClientRect();
                    const imgX = ((0 - stats.start_x) / stats.width_blocks) * w;
                    const imgY = ((0 - stats.start_z) / stats.height_blocks) * h;
                    setPan({ x: rect.width / 2 - imgX, y: rect.height / 2 - imgY });
                  }
                }}
                style={{
                  transformOrigin: "0 0",
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  imageRendering: zoom > 2 ? "pixelated" : "auto",
                  maxWidth: "none",
                }}
              />
              {hoverCoords && (
                <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2.5 py-1 text-xs font-mono text-white pointer-events-none">
                  X: {hoverCoords.x} &nbsp; Z: {hoverCoords.z}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
