import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getResourcesStatus, uploadResourcesBundle, type ResourcesStatus } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIdx]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminResourcesPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState<number>(0);

  const status = useQuery<ResourcesStatus>({
    queryKey: ["admin-resources-status"],
    queryFn: getResourcesStatus,
  });

  const uploadMut = useMutation({
    mutationFn: (selected: File) => uploadResourcesBundle(selected, (p) => setPercent(p)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-resources-status"] });
      setFile(null);
    },
  });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPercent(0);
    uploadMut.reset();
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setFile(f);
    setPercent(0);
    uploadMut.reset();
  }

  function handleUpload() {
    if (!file) return;
    setPercent(0);
    uploadMut.mutate(file);
  }

  const data = status.data;
  const canonical = data?.canonical;
  const active = data?.active_bundle;
  const seedConfigured = !!canonical?.seed && !!canonical?.vs_version;
  const mismatch =
    active &&
    canonical &&
    (active.seed !== canonical.seed || active.vs_version !== canonical.vs_version);

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Resources Overlay</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload an offline-generated worldgen bundle (ore deposits + climate / rock tint heatmaps)
          so the TOPS map viewer can render an admin-only resources overlay. The bundle must be
          produced against the same seed and Vintage Story version configured on this server.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Server configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {status.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading status…
            </div>
          ) : status.isError ? (
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {(status.error as Error).message}
            </div>
          ) : (
            <>
              <div>
                <span className="text-muted-foreground">Canonical seed:</span>{" "}
                <code className="font-mono">{canonical?.seed || "(not set)"}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Canonical VS version:</span>{" "}
                <code className="font-mono">{canonical?.vs_version || "(not set)"}</code>
              </div>
              {!seedConfigured && (
                <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Set <code>CANONICAL_WORLD_SEED</code> and{" "}
                    <code>CANONICAL_WORLD_VS_VERSION</code> in the server env, then restart, before
                    uploading a bundle.
                  </span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Active bundle
            {active && !mismatch && (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> live
              </Badge>
            )}
            {mismatch && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" /> mismatch
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!active ? (
            <p className="text-muted-foreground">No bundle uploaded yet.</p>
          ) : (
            <>
              <div>
                <span className="text-muted-foreground">Seed / version:</span>{" "}
                <code className="font-mono">{active.seed}</code>{" "}
                <code className="font-mono">{active.vs_version}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Generated at:</span>{" "}
                {formatDate(active.generated_at)}
              </div>
              <div>
                <span className="text-muted-foreground">Total size:</span>{" "}
                {formatBytes(active.size_bytes)}
              </div>
              <div>
                <span className="text-muted-foreground">Layers / deposit types:</span>{" "}
                {active.layer_count} / {active.deposit_type_count}
              </div>
              {active.world_bounds && (
                <div className="text-muted-foreground text-xs">
                  Bounds: x [{active.world_bounds.min_x}, {active.world_bounds.max_x}], z [
                  {active.world_bounds.min_z}, {active.world_bounds.max_z}]
                </div>
              )}
              {mismatch && (
                <div className="flex items-start gap-2 text-destructive text-xs mt-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Active bundle does not match the canonical seed/version configured on the
                    server. Re-upload a fresh bundle.
                  </span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload bundle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label
            htmlFor="resources-bundle-file"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="border-2 border-dashed border-muted-foreground/30 rounded-md p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-muted/30 transition-colors"
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm">
              {file ? file.name : "Drop a .zip here, or click to choose a file"}
            </span>
            {file && (
              <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            )}
            <input
              id="resources-bundle-file"
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={handleFileSelect}
            />
          </label>

          {uploadMut.isPending && (
            <div className="space-y-1">
              <div className="h-2 bg-muted rounded overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Uploading… {percent}%{percent >= 95 && " (validating + unpacking)"}
              </p>
            </div>
          )}

          {uploadMut.isError && (
            <div className="flex items-start gap-2 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{(uploadMut.error as Error).message}</span>
            </div>
          )}

          {uploadMut.isSuccess && (
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Bundle uploaded and activated.
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={!file || !seedConfigured || uploadMut.isPending}
            >
              {uploadMut.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
            {file && !uploadMut.isPending && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFile(null);
                  setPercent(0);
                  uploadMut.reset();
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
