import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTopsMapStats, renderTopsMap } from "@/lib/api";
import { MapViewer, type MapStats } from "@/components/MapViewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Loader2 } from "lucide-react";

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

  function handleReload() {
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-render"] });
  }

  function handleDownload() {
    if (!baseImageUrl) return;
    const a = document.createElement("a");
    a.href = baseImageUrl;
    a.download = "tops-server-map.png";
    a.click();
  }

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
        </div>
        {error && <p className="text-red-500 text-sm">{error}</p>}

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
          // enhanceFn={baseImageUrl ? renderTopsMap : undefined}
        />
      </CardContent>
    </Card>
  );
}
