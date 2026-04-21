import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize, Crosshair, Loader2 } from "lucide-react";

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

interface MapViewerProps {
  /** Base image URL. When this changes the viewer resets (zoom/pan/enhance). */
  imageUrl: string | null;
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
  /** Extra buttons rendered before the zoom controls in the toolbar. */
  toolbarStart?: React.ReactNode;
  /** Row rendered above the toolbar (e.g. a legend). */
  legend?: React.ReactNode;
  /** Whether the canvas gets `rounded-md border`. Default true. */
  bordered?: boolean;
  /** Optional callback fired when the base image fails to load. */
  onImageError?: () => void;
}

export function MapViewer({
  imageUrl,
  stats = null,
  alt = "Map",
  height = "70vh",
  enhanceFn,
  toolbarStart,
  legend,
  bordered = true,
  onImageError,
}: MapViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const [renderedMaxDim, setRenderedMaxDim] = useState(4096);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const enhanceAbortRef = useRef<AbortController | null>(null);

  const activeUrl = enhancedUrl ?? imageUrl;

  // Keep refs in sync with state so non-React callbacks always read current values
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // Reset viewer state when the base image URL changes (new file / new query)
  useEffect(() => {
    setEnhancedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setImgNatural({ w: 0, h: 0 });
    setRenderedMaxDim(4096);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoverCoords(null);
    enhanceAbortRef.current?.abort();
    setEnhancing(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Auto-enhance: when zoomed in far enough, request a higher-resolution render
  useEffect(() => {
    if (!activeUrl || !enhanceFn || imgNatural.w === 0) return;

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
        if (abort.signal.aborted) { URL.revokeObjectURL(newUrl); return; }

        const scaleW = tmpImg.naturalWidth / imgNatural.w;
        const scaleH = tmpImg.naturalHeight / imgNatural.h;
        setPan((p) => ({ x: p.x * scaleW, y: p.y * scaleH }));
        setZoom((z) => z / scaleW);
        setImgNatural({ w: tmpImg.naturalWidth, h: tmpImg.naturalHeight });
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
  }, [zoom, imgNatural.w, renderedMaxDim, enhanceFn]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { enhanceAbortRef.current?.abort(); };
  }, []);

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
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomToward(e.clientX - rect.left, e.clientY - rect.top, zoomRef.current * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeUrl, zoomToward]);

  const centerView = useCallback((width: number, height: number, currentZoom?: number) => {
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
  }, [stats]);

  const centerOnOrigin = useCallback((currentZoom?: number) => {
    if (!stats || imgNatural.w === 0) return;
    centerView(imgNatural.w, imgNatural.h, currentZoom);
  }, [centerView, stats, imgNatural]);

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
        } else {
          setHoverCoords(null);
        }
      }
    },
    [dragging, dragStart, stats, imgNatural],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);
  const handleMouseLeave = useCallback(() => {
    setDragging(false);
    setHoverCoords(null);
  }, []);

  if (!activeUrl) return null;

  const canvasClass = [
    "relative overflow-hidden bg-black/90",
    bordered ? "rounded-md border" : "",
  ]
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
        <span className="text-xs text-muted-foreground w-14 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <Button type="button" variant="outline" size="sm" onClick={zoomIn} title="Zoom in">
          <ZoomIn className="size-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetView} title="Reset view">
          <Maximize className="size-4" />
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
        className={canvasClass}
        style={{ height, cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        <img
          ref={imgRef}
          src={activeUrl}
          alt={alt}
          draggable={false}
          className="absolute select-none"
          onError={onImageError}
          onLoad={() => {
            if (!imgRef.current || !containerRef.current) return;
            const w = imgRef.current.naturalWidth;
            const h = imgRef.current.naturalHeight;
            setImgNatural({ w, h });
            centerView(w, h, zoomRef.current);
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
  );
}
