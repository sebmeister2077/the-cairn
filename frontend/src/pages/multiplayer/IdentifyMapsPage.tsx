import { FilePathHelp } from "@/components/FilePathHelp";
import { FileUpload } from "@/components/FileUpload";
import { IdentifyMapsResult } from "@/components/identify-maps/IdentifyMapsResult";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { extractDBFromLogs, type MapFileInfo, type ServerMapResult } from "@/lib/identify-maps";
import { useRef, useState, type FormEvent } from "react";

export function IdentifyMapsPage() {
  const { t } = useTranslation();
  const [logFiles, setLogFiles] = useState<File[]>([]);
  const [mapFiles, setMapFiles] = useState<File[]>([]);
  const [settingsFile, setSettingsFile] = useState<File | null>(null);
  const [results, setResults] = useState<ServerMapResult[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const mapInputRef = useRef<HTMLInputElement>(null);

  function handleLogFiles(file: File | null) {
    if (file) setLogFiles([file]);
  }

  function handleMapFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const dbFiles = Array.from(files).filter((f) => f.name.endsWith(".db"));
    setMapFiles(dbFiles);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (logFiles.length === 0) return;

    setError("");
    setLoading(true);
    setHasRun(false);

    try {
      const logContents = await Promise.all(logFiles.map((f) => f.text()));

      const mapFileInfos: MapFileInfo[] = mapFiles.map((f) => ({
        name: f.name,
        lastModified: f.lastModified,
        size: f.size,
      }));

      const clientSettings = settingsFile ? await settingsFile.text() : undefined;

      const data = extractDBFromLogs(logContents, mapFileInfos, clientSettings);
      setResults(data);
      setHasRun(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("identifyMapsPage.failedToProcessFiles"));
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setLogFiles([]);
    setMapFiles([]);
    setSettingsFile(null);
    setResults([]);
    setError("");
    setHasRun(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("identifyMapsPage.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("identifyMapsPage.description")}</p>
      </CardHeader>
      <CardContent className="grid gap-6">
        <FilePathHelp
          summary={t("identifyMapsPage.filePathSummary")}
          items={[
            {
              label: t("identifyMapsPage.paths.logsLabel"),
              path: String.raw`%AppData%\VintagestoryData\Logs`,
            },
            {
              label: t("identifyMapsPage.paths.mapsLabel"),
              path: String.raw`%AppData%\VintagestoryData\Maps`,
            },
            {
              label: t("identifyMapsPage.paths.settingsLabel"),
              path: String.raw`%AppData%\VintagestoryData\clientsettings.json`,
            },
          ]}
          footer={<p className="text-xs">{t("identifyMapsPage.paths.footer")}</p>}
        />

        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            id="logfile"
            label={t("identifyMapsPage.clientLogLabel")}
            accept=".log,.txt"
            required
            onChange={handleLogFiles}
          />

          <div className="grid gap-1.5">
            <Label htmlFor="mapfolder">
              <span className="inline-flex items-center">
                {t("identifyMapsPage.mapsFolderLabel")}
                <HelpTip text={t("identifyMapsPage.mapsFolderHelp")} />
              </span>
              <span className="text-muted-foreground ml-1 font-normal">
                ({t("identifyMapsPage.mapsFolderHint")})
              </span>
            </Label>
            <Input
              ref={mapInputRef}
              id="mapfolder"
              type="file"
              // @ts-expect-error webkitdirectory is non-standard but widely supported
              webkitdirectory=""
              directory=""
              onChange={handleMapFolder}
            />
            {mapFiles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("identifyMapsPage.mapFilesFound", { count: mapFiles.length })}
              </p>
            )}
          </div>

          <FileUpload
            id="settings"
            label={t("identifyMapsPage.clientSettingsLabel")}
            accept=".json"
            onChange={setSettingsFile}
          />

          <div className="flex gap-2">
            <Button type="submit" disabled={logFiles.length === 0 || loading}>
              {loading ? t("identifyMapsPage.analyzing") : t("identifyMapsPage.identify")}
            </Button>
            {hasRun && (
              <Button type="button" variant="outline" onClick={handleReset}>
                {t("identifyMapsPage.clear")}
              </Button>
            )}
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {hasRun && <IdentifyMapsResult results={results} />}
      </CardContent>
    </Card>
  );
}
