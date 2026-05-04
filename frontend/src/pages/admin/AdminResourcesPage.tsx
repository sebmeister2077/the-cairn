import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getActiveResourcesUploadJob,
  getResourcesStatus,
  getResourcesUploadJob,
  uploadResourcesBundle,
  type ResourcesStatus,
  type ResourcesUploadJob,
} from "@/lib/api";

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

function isJobActive(job: ResourcesUploadJob | null | undefined): boolean {
  return !!job && (job.status === "unpacking" || job.status === "swapping");
}

export function AdminResourcesPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const dismissedJobRef = useRef<string | null>(null);

  const status = useQuery<ResourcesStatus>({
    queryKey: ["admin-resources-status"],
    queryFn: getResourcesStatus,
  });

  // Adopt any in-flight job we find on first mount so a refresh during
  // an upload doesn't hide the progress bar.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const job = await getActiveResourcesUploadJob();
        if (!cancelled && job && isJobActive(job)) {
          setTrackedJobId(job.id);
        }
      } catch {
        // ignore — if the API is unreachable the rest of the page will
        // surface the error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const job = useQuery<ResourcesUploadJob>({
    queryKey: ["admin-resources-job", trackedJobId],
    queryFn: () => getResourcesUploadJob(trackedJobId as string),
    enabled: !!trackedJobId,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 1500;
      return isJobActive(data) ? 1500 : false;
    },
  });

  // When the tracked job finishes, refresh the status card so the new
  // active bundle shows up.
  useEffect(() => {
    const data = job.data;
    if (!data) return;
    if (!isJobActive(data)) {
      queryClient.invalidateQueries({ queryKey: ["admin-resources-status"] });
    }
  }, [job.data, queryClient]);

  const uploadMut = useMutation({
    mutationFn: (selected: File) => uploadResourcesBundle(selected, (p) => setUploadPercent(p)),
    onSuccess: (result) => {
      setTrackedJobId(result.job_id);
      dismissedJobRef.current = null;
      setFile(null);
    },
  });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setUploadPercent(0);
    uploadMut.reset();
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setFile(f);
    setUploadPercent(0);
    uploadMut.reset();
  }

  function handleUpload() {
    if (!file) return;
    setUploadPercent(0);
    uploadMut.mutate(file);
  }

  function handleDismissJob() {
    if (trackedJobId) {
      dismissedJobRef.current = trackedJobId;
    }
    setTrackedJobId(null);
    uploadMut.reset();
    setUploadPercent(0);
  }

  const data = status.data;
  const canonical = data?.canonical;
  const active = data?.active_bundle;
  const seedConfigured = !!canonical?.seed && !!canonical?.vs_version;
  const mismatch =
    active &&
    canonical &&
    (active.seed !== canonical.seed || active.vs_version !== canonical.vs_version);

  const showJob = job.data && job.data.id !== dismissedJobRef.current;
  const jobActive = isJobActive(job.data);
  const uploadInFlight = uploadMut.isPending || jobActive;

  // Server-side phase percent (file count). Falls back to byte ratio
  // until ``total_files`` is known.
  const serverPercent = (() => {
    const j = job.data;
    if (!j) return 0;
    if (j.status === "complete") return 100;
    if (j.total_files > 0) {
      return Math.min(100, Math.round((j.processed_files / j.total_files) * 100));
    }
    if (j.total_bytes > 0) {
      return Math.min(100, Math.round((j.uploaded_bytes / j.total_bytes) * 100));
    }
    return 0;
  })();

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
              disabled={uploadInFlight}
            />
          </label>

          {/* Phase 1: bytes uploaded to backend (XHR onprogress). */}
          {uploadMut.isPending && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Step 1 of 2 — uploading to server</span>
                <span>{uploadPercent}%</span>
              </div>
              <div className="h-2 bg-muted rounded overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Phase 2: backend unpacking into R2 (DB-backed polling). */}
          {showJob && job.data && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {job.data.status === "complete"
                    ? "Bundle activated"
                    : job.data.status === "failed"
                      ? "Upload failed"
                      : "Step 2 of 2 — unpacking on server"}
                </div>
                {!jobActive && (
                  <Button size="sm" variant="ghost" onClick={handleDismissJob}>
                    Dismiss
                  </Button>
                )}
              </div>

              {jobActive && (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{job.data.phase || job.data.status}</span>
                    <span>{serverPercent}%</span>
                  </div>
                  <div className="h-2 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${serverPercent}%` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {job.data.total_files > 0 ? (
                      <>
                        {job.data.processed_files.toLocaleString()} /{" "}
                        {job.data.total_files.toLocaleString()} files
                        {" · "}
                        {formatBytes(job.data.uploaded_bytes)} / {formatBytes(job.data.total_bytes)}
                      </>
                    ) : (
                      <>Counting bundle contents…</>
                    )}
                  </div>
                </>
              )}

              {job.data.status === "complete" && (
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  Uploaded {job.data.processed_files.toLocaleString()} files (
                  {formatBytes(job.data.uploaded_bytes)}).
                </div>
              )}

              {job.data.status === "failed" && (
                <div className="flex items-start gap-2 text-destructive text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{job.data.error || "Unknown error"}</span>
                </div>
              )}
            </div>
          )}

          {uploadMut.isError && (
            <div className="flex items-start gap-2 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{(uploadMut.error as Error).message}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleUpload} disabled={!file || !seedConfigured || uploadInFlight}>
              {uploadInFlight ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {uploadMut.isPending ? "Uploading" : "Unpacking"}
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
            {file && !uploadInFlight && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFile(null);
                  setUploadPercent(0);
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
