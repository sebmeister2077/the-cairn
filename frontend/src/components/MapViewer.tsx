import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize, Crosshair, Loader2 } from "lucide-react";

const WHEEL_ZOOM_FACTOR = 1.3;
const BUTTON_ZOOM_FACTOR = 1.75;

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
  kind?: string;
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
  /** Optional world-space line segments rendered over the map image. */
  overlaySegments?: WorldLineSegment[];
  /** Optional world-space point markers rendered over the map image. */
  overlayPoints?: WorldPointMarker[];
  /** Optional callback fired when an overlay segment is clicked. */
  onOverlaySegmentClick?: (segment: WorldLineSegment | null) => void;
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
  stats = null,
  alt = "Map",
  height = "70vh",
  enhanceFn,
  toolbarStart,
  legend,
  bordered = true,
  onImageError,
  overlaySegments,
  overlayPoints,
  onOverlaySegmentClick,
  focusPoint,
  focusZoom = 4,
}: MapViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const [hoveredOverlayIndex, setHoveredOverlayIndex] = useState<number | null>(null);
  const [renderedMaxDim, setRenderedMaxDim] = useState(4096);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const labelsCanvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(zoom);
  const prevFocusPointRef = useRef<{ x: number; z: number } | undefined>(undefined);
  const panRef = useRef(pan);
  const enhanceAbortRef = useRef<AbortController | null>(null);

  const activeUrl = enhancedUrl ?? imageUrl;

  const projectedOverlaySegments = useMemo(() => {
    if (!stats || !overlaySegments || overlaySegments.length === 0 || imgNatural.w <= 0 || imgNatural.h <= 0) {
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

  const projectedOverlayPoints = useMemo(() => {
    if (!stats || !overlayPoints || overlayPoints.length === 0 || imgNatural.w <= 0 || imgNatural.h <= 0) {
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
    setHoveredOverlayIndex(null);
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
    if (!canvas) return;

    if (imgNatural.w <= 0 || imgNatural.h <= 0) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    canvas.width = imgNatural.w;
    canvas.height = imgNatural.h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (projectedOverlaySegments.length === 0 && projectedOverlayPoints.length === 0) return;

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
      ctx.fillStyle = "rgba(34, 211, 238, 0.92)";
      for (const pt of projectedOverlayPoints) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointOuter, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
      for (const pt of projectedOverlayPoints) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pointInner, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [
    hoveredOverlayIndex,
    imgNatural.h,
    imgNatural.w,
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

      const text = raw.length > 30 ? `${raw.slice(0, 29)}\u2026` : raw;
      const textW = ctx.measureText(text).width;
      const textH = FONT_SIZE;
      const tx = sx + DOT_RADIUS_SCREEN + 3;
      const ty = sy - DOT_RADIUS_SCREEN - PAD_Y - textH;

      ctx.fillStyle = "rgba(15, 23, 42, 0.80)";
      ctx.fillRect(tx - PAD_X, ty - PAD_Y, textW + PAD_X * 2, textH + PAD_Y * 2);

      ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
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
              const t = abLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq)) : 0;
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
        {stats && ((overlaySegments && overlaySegments.length > 0) || (overlayPoints && overlayPoints.length > 0)) && (
          <canvas
            ref={overlayCanvasRef}
            className="absolute pointer-events-none"
            style={{
              transformOrigin: "0 0",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        )}
        {overlayPoints && overlayPoints.length > 0 && (
          <canvas
            ref={labelsCanvasRef}
            className="absolute inset-0 pointer-events-none"
          />
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
