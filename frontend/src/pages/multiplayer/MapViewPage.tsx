import { useState, useCallback, type FormEvent } from "react";
import { getMapStats, renderMap } from "@/lib/api";
import { MapViewer, type MapStats } from "@/components/MapViewer";
import { FileUpload } from "@/components/FileUpload";
import { MapDbFileHelp } from "@/components/MapDbFileHelp";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Download, Loader2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useReduxState } from "@/store/hooks";

const NON_ADMIN_MAX_MB = 200;
const NON_ADMIN_MAX_BYTES = NON_ADMIN_MAX_MB * 1024 * 1024;

export function MapViewPage() {
  const { t } = useTranslation();
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [stats, setStats] = useState<MapStats | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");
  const isAdmin = useReduxState("auth.isAdmin");
  const [fastPreview, setFastPreview] = useState(true);
  // Non-admins are locked into fast preview mode (full-detail rendering is too
  // expensive to expose publicly).
  const effectiveFastPreview = isAdmin ? fastPreview : true;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dbFile) return;

    setError("");

    // Non-admins are limited to 200MB map files (rendering large maps is
    // expensive). Admins have no client-side limit.
    if (!isAdmin && dbFile.size > NON_ADMIN_MAX_BYTES) {
      const sizeMb = (dbFile.size / (1024 * 1024)).toFixed(1);
      setError(
        t("mapViewPage.fileTooLarge", {
          sizeMb,
          limitMb: NON_ADMIN_MAX_MB,
        }),
      );
      return;
    }

    setStats(null);
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      setImageUrl(null);
    }

    // Step 1: Get stats
    setLoading(t("mapViewPage.readingMapDatabase"));
    try {
      const fd = new FormData();
      fd.append("db_file", dbFile);
      const s = await getMapStats(fd);
      setStats(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mapViewPage.failedToReadMapDatabase"));
      setLoading("");
      return;
    }

    // Step 2: Render image
    setLoading(
      effectiveFastPreview
        ? t("mapViewPage.renderingFastPreview")
        : t("mapViewPage.renderingMapImage"),
    );
    try {
      const fd = new FormData();
      fd.append("db_file", dbFile);
      const blob = await renderMap(fd, undefined, effectiveFastPreview);
      const url = URL.createObjectURL(blob);
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mapViewPage.failedToRenderMap"));
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

  const enhanceFn = useCallback(
    async (maxDim: number) => {
      if (!dbFile) throw new Error("no file");
      const fd = new FormData();
      fd.append("db_file", dbFile);
      return renderMap(fd, maxDim, effectiveFastPreview);
    },
    [dbFile, effectiveFastPreview],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("mapViewPage.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("mapViewPage.descriptionPrefix")}{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> file to render{" "}
          {t("mapViewPage.descriptionSuffix")}
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <MapDbFileHelp />
        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            key={fileInputKey}
            id="dbfile"
            label={t("mapViewPage.mapDatabaseLabel")}
            accept=".db"
            required
            onChange={setDbFile}
          />
          {isAdmin && (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Switch
                checked={fastPreview}
                onCheckedChange={setFastPreview}
                aria-label={t("mapViewPage.fastPreviewMode")}
              />
              <Label>{t("mapViewPage.fastPreviewModeDescription")}</Label>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!dbFile || !!loading}>
              {loading || t("mapViewPage.renderMap")}
            </Button>
            {imageUrl && (
              <>
                <Button type="button" variant="outline" onClick={handleDownload}>
                  <Download className="size-4 mr-1" />
                  {t("mapViewPage.downloadPng")}
                </Button>
                <Button type="button" variant="outline" onClick={handleReset}>
                  {t("mapViewPage.clear")}
                </Button>
              </>
            )}
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {stats && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
            <span>
              <span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span>{" "}
              {t("mapViewPage.mapChunks")}
            </span>
            <span>
              <span className="font-medium text-foreground">{stats.size_mb}</span> MB
            </span>
            <span>
              <span className="font-medium text-foreground">
                {stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}
              </span>{" "}
              {t("mapViewPage.blocks")}
            </span>
          </div>
        )}

        <MapViewer
          imageUrl={imageUrl}
          stats={stats}
          alt={t("mapViewPage.mapAlt")}
          // enhanceFn={dbFile ? enhanceFn : undefined}
        />
      </CardContent>
    </Card>
  );
}
