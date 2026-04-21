import { useState, useCallback, type FormEvent } from "react";
import { getMapStats, renderMap } from "@/lib/api";
import { MapViewer, type MapStats } from "@/components/MapViewer";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Loader2 } from "lucide-react";

export function MapViewPage() {
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [stats, setStats] = useState<MapStats | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render map");
    } finally {
      setLoading("");
    }
  }

  function handleReset() {
    setDbFile(null);
    setFileInputKey((k) => k + 1);
    setStats(null);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setError("");
    setLoading("");
  }

  function handleDownload() {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = dbFile ? dbFile.name.replace(/\.db$/, "-map.png") : "map.png";
    a.click();
  }

  const enhanceFn = useCallback(async (maxDim: number) => {
    if (!dbFile) throw new Error("no file");
    const fd = new FormData();
    fd.append("db_file", dbFile);
    return renderMap(fd, maxDim);
  }, [dbFile]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local Map Viewer</CardTitle>
        <p className="text-sm text-muted-foreground">
          Upload a multiplayer map <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> file
          to render and explore the world map your client has cached.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            key={fileInputKey}
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

        <MapViewer
          imageUrl={imageUrl}
          stats={stats}
          alt="Vintage Story world map"
          // enhanceFn={dbFile ? enhanceFn : undefined}
        />
      </CardContent>
    </Card>
  );
}
