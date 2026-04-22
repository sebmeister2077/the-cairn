import { useState, useRef, useCallback, type FormEvent } from "react";
import { extractDBFromLogs, type MapFileInfo, type ServerMapResult } from "@/lib/identify-maps";
import { ClipboardCopy, Check, HelpCircle } from "lucide-react";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/help-tip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function IdentifyMapsPage() {
  const [logFiles, setLogFiles] = useState<File[]>([]);
  const [mapFiles, setMapFiles] = useState<File[]>([]);
  const [settingsFile, setSettingsFile] = useState<File | null>(null);
  const [results, setResults] = useState<ServerMapResult[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const mapInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(path);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

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

      const clientSettings = settingsFile
        ? await settingsFile.text()
        : undefined;

      const data = extractDBFromLogs(logContents, mapFileInfos, clientSettings);
      setResults(data);
      setHasRun(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process files");
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
        <CardTitle>Identify Map Databases</CardTitle>
        <p className="text-sm text-muted-foreground">
          Match your multiplayer map files to the servers they belong to by
          analyzing your game logs.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        <details className="group rounded-md border text-sm">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden list-none">
            <HelpCircle className="h-4 w-4 shrink-0" />
            <span>Where can I find these files?</span>
            <svg className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div className="border-t px-3 py-3 space-y-3 text-muted-foreground">
            <div className="grid gap-1.5">
              {[
                { label: "Logs", path: String.raw`%AppData%\VintagestoryData\Logs` },
                { label: "Maps", path: String.raw`%AppData%\VintagestoryData\Maps` },
                { label: "Settings", path: String.raw`%AppData%\VintagestoryData\clientsettings.json` },
              ].map(({ label, path }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="font-medium text-foreground w-16 shrink-0">{label}:</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono select-all">
                    {path}
                  </code>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors shrink-0"
                    onClick={() => copyPath(path)}
                    title="Copy path"
                  >
                    {copied === path ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
                  </button>
                </div>
              ))}
            </div>
            <p className="text-xs">
              Paste these paths directly into File Explorer's address bar.
            </p>
          </div>
        </details>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            id="logfile"
            label="Client log (client-main.log)"
            accept=".log,.txt"
            required
            onChange={handleLogFiles}
          />

          <div className="grid gap-1.5">
            <Label htmlFor="mapfolder">
              <span className="inline-flex items-center">
                Maps folder
                <HelpTip text="Used only to match each .db file to a server connection by comparing the file's last updated time with when your log shows that server connection. The page uses file metadata (name, size, last-modified), not map tile contents, for this correlation." />
              </span>
              <span className="text-muted-foreground ml-1 font-normal">
                (select your VintagestoryData/Maps directory)
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
                {mapFiles.length} .db file{mapFiles.length !== 1 && "s"} found
              </p>
            )}
          </div>

          <FileUpload
            id="settings"
            label="Client settings (optional — for friendly server names)"
            accept=".json"
            onChange={setSettingsFile}
          />

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={logFiles.length === 0 || loading}
            >
              {loading ? "Analyzing…" : "Identify"}
            </Button>
            {hasRun && (
              <Button type="button" variant="outline" onClick={handleReset}>
                Clear
              </Button>
            )}
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {hasRun && (
          <div className="mt-6 space-y-3">
            {results.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center">
                <p className="text-muted-foreground">
                  No multiplayer connections found in the provided log file.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {results.length} server connection{results.length !== 1 && "s"} found
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Server</TableHead>
                      <TableHead>Database File</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Last Connected</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((r) => (
                      <TableRow key={r.serverAddress}>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            {r.friendlyName && (
                              <span className="font-medium">{r.friendlyName}</span>
                            )}
                            <span className={r.friendlyName ? "text-xs text-muted-foreground" : "font-medium"}>
                              {r.serverAddress}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {r.dbFile ? (
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                              {r.dbFile}
                            </code>
                          ) : (
                            <Badge variant="outline">No match</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.dbSizeMB != null ? `${r.dbSizeMB} MB` : "—"}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {r.lastConnected.toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}{" "}
                          <span className="text-muted-foreground">
                            {r.lastConnected.toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
