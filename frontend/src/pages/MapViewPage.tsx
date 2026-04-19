import { useState, useRef, useCallback, useEffect, type FormEvent } from "react";
import { getMapStats, renderMap } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ZoomIn, ZoomOut, Maximize, Download, Crosshair } from "lucide-react";

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

export function MapViewPage() {
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [stats, setStats] = useState<MapStats | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);

  // Keep refs in sync with state so non-React listeners see current values
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // Cleanup object URL on unmount or when image changes
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  // Zoom toward a specific point (in container-local coordinates)
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

  // Non-passive wheel listener to prevent page scroll inside the map viewer
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dbFile) return;

    setError("");
    setStats(null);
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      setImageUrl(null);
    }

    // Step 1: Get stats
    setLoading("Reading map database…");
    try {
      const fd = new FormData();
      fd.append("db_file", dbFile);
      const s = await getMapStats(fd);
      setStats(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read map database");
      setLoading("");
      return;
    }

    // Step 2: Render image
    setLoading("Rendering map image… This may take a moment for large maps.");
    try {
      const fd = new FormData();
      fd.append("db_file", dbFile);
      const blob = await renderMap(fd);
      const url = URL.createObjectURL(blob);
      setImageUrl(url);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render map");
    } finally {
      setLoading("");
    }
  }

  function handleReset() {
    setStats(null);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setError("");
    setLoading("");
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoverCoords(null);
  }

  function handleDownload() {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = dbFile ? dbFile.name.replace(/\.db$/, "-map.png") : "map.png";
    a.click();
  }

  // Center the view on game coordinates X:0, Z:0
  const centerOnOrigin = useCallback((currentZoom?: number) => {
    const el = containerRef.current;
    if (!el || !stats || imgNatural.w === 0) return;
    const z = currentZoom ?? zoom;
    const rect = el.getBoundingClientRect();
    const imgX = ((0 - stats.start_x) / stats.width_blocks) * imgNatural.w;
    const imgY = ((0 - stats.start_z) / stats.height_blocks) * imgNatural.h;
    setPan({ x: rect.width / 2 - imgX * z, y: rect.height / 2 - imgY * z });
  }, [stats, imgNatural, zoom]);

  // Zoom controls – anchor on viewport center
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

  // Pan via mouse drag
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

      // Compute block coordinates under cursor
      if (containerRef.current && stats && imgNatural.w > 0) {
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // Convert screen coords → image pixel coords
        const imgX = (mx - pan.x) / zoom;
        const imgY = (my - pan.y) / zoom;
        if (imgX >= 0 && imgX < imgNatural.w && imgY >= 0 && imgY < imgNatural.h) {
          // Map image pixel → game block coordinate
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
        <CardTitle>Map Viewer</CardTitle>
        <p className="text-sm text-muted-foreground">
          Upload a multiplayer map <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> file
          to render and explore the world map your client has cached.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            id="dbfile"
            label="Map database (.db)"
            accept=".db"
            required
            onChange={setDbFile}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!dbFile || !!loading}>
              {loading || "Render Map"}
            </Button>
            {imageUrl && (
              <>
                <Button type="button" variant="outline" onClick={handleDownload}>
                  <Download className="size-4 mr-1" />
                  Download PNG
                </Button>
                <Button type="button" variant="outline" onClick={handleReset}>
                  Clear
                </Button>
              </>
            )}
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

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
                alt="Vintage Story world map"
                draggable={false}
                className="absolute select-none"
                onLoad={() => {
                  if (imgRef.current && containerRef.current && stats) {
                    const w = imgRef.current.naturalWidth;
                    const h = imgRef.current.naturalHeight;
                    setImgNatural({ w, h });
                    // Auto-center on origin (0, 0)
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
