import { useState, useEffect, useMemo, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getContributeInfo,
  contributeMap,
  getContributePreview,
  approveContribution,
  rejectContribution,
} from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Upload, Users, Map, Eye, Check, XIcon, HelpCircle } from "lucide-react";

interface PendingContribution {
  id: string;
  contributor: string;
  created_at: string;
  timestamp?: string;
  tile_count: number;
  status: string;
}

interface ApprovedEntry {
  id: string;
  contributor: string;
  approved_at: string;
  tiles_new: number;
  tiles_existing: number;
  combined_total: number;
}

interface ContributeInfo {
  map_id: string;
  total_tiles: number;
  pending: PendingContribution[];
  approved: ApprovedEntry[];
}

export function ContributePage() {
  const queryClient = useQueryClient();

  const [dbFile, setDbFile] = useState<File | null>(null);
  const [contributor, setContributor] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  // Contribute info via React Query
  const infoQuery = useQuery<ContributeInfo>({
    queryKey: ["contribute-info"],
    queryFn: () => getContributeInfo(),
  });
  const info = infoQuery.data ?? null;
  const infoLoading = infoQuery.isLoading;

  // Preview state
  const [previewId, setPreviewId] = useState<string | null>(null);

  const previewQuery = useQuery<Blob>({
    queryKey: ["contribute-preview", previewId],
    queryFn: () => getContributePreview(previewId!),
    enabled: !!previewId,
  });
  const previewBlob = previewQuery.data ?? null;
  const previewUrl = useMemo(
    () => (previewBlob ? URL.createObjectURL(previewBlob) : null),
    [previewBlob],
  );
  const previewLoading = previewQuery.isFetching;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Admin action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dbFile) return;

    setUploading(true);
    setUploadProgress(0);
    setError("");
    setUploadResult(null);

    try {
      const data = await contributeMap(dbFile, contributor, (pct) =>
        setUploadProgress(pct),
      );
      setUploadResult(data.message as string);
      setDbFile(null);
      setFileInputKey((prev) => prev + 1);
      queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handlePreview(id: string) {
    if (previewId === id) {
      setPreviewId(null);
      return;
    }
    setPreviewId(id);
  }

  async function handleApprove(id: string) {
    setActionLoading(id);
    setActionError("");
    try {
      await approveContribution(id);
      if (previewId === id) setPreviewId(null);
      queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(id: string) {
    setActionLoading(id);
    setActionError("");
    try {
      await rejectContribution(id);
      if (previewId === id) setPreviewId(null);
      queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Upload card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Contribute Map Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload your local map cache to contribute to the shared community map.
            Submissions are reviewed by an admin before being merged.
          </p>

          <div className="flex items-center gap-3 rounded-md border p-3 bg-muted/50">
            <Map className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="text-sm">
              <span className="text-muted-foreground">Server Map ID:</span>{" "}
              {infoLoading ? (
                <span className="text-muted-foreground">loading…</span>
              ) : (
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  {info?.map_id ?? "—"}
                </code>
              )}
            </div>
          </div>

          <details className="group rounded-md border text-sm">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden list-none">
              <HelpCircle className="h-4 w-4 shrink-0" />
              <span>Where can I find this file?</span>
              <svg className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </summary>
            <div className="border-t px-3 py-3 space-y-3 text-muted-foreground">
              <p>
                Vintage Story stores a <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> map
                cache file for each server you've visited. Look for the file whose name matches the <strong>Server Map ID</strong> shown above.
              </p>
              <div className="space-y-2">
                <div>
                  <p className="font-medium text-foreground">Windows</p>
                  <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
                    %appdata%\VintagestoryData\Maps\
                  </code>
                </div>
                <div>
                  <p className="font-medium text-foreground">Linux</p>
                  <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
                    ~/.config/VintagestoryData/Maps/
                  </code>
                </div>
                <div>
                  <p className="font-medium text-foreground">macOS</p>
                  <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
                    ~/Library/Application Support/VintagestoryData/Maps/
                  </code>
                </div>
              </div>
              <p className="text-xs">
                Each <code className="rounded bg-muted px-1 py-0.5 font-mono">.db</code> file is named after the server's
                map ID. Copy the file matching the ID above and upload it below.
              </p>
            </div>
          </details>

          {!infoLoading && info && (
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary">{info.total_tiles.toLocaleString()}</Badge>
                <span className="text-muted-foreground">tiles in combined map</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary">{info.pending.length}</Badge>
                <span className="text-muted-foreground">pending review</span>
              </div>
            </div>
          )}

          <Separator />

          <form onSubmit={handleSubmit} className="space-y-4">
            <FileUpload
              key={fileInputKey}
              id="contribute-db"
              label="Map Database (.db)"
              accept=".db"
              required
              onChange={setDbFile}
            />

            <div className="space-y-2">
              <Label htmlFor="contributor-name">Your Name (optional)</Label>
              <Input
                id="contributor-name"
                placeholder="Anonymous"
                value={contributor}
                onChange={(e) => setContributor(e.target.value)}
                maxLength={50}
              />
            </div>

            <Button type="submit" disabled={!dbFile || uploading}>
              {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Upload for Review
            </Button>

            {uploading && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Uploading…</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </form>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {uploadResult && (
            <div className="rounded-md border p-3 bg-muted/30">
              <p className="text-sm font-medium text-green-600 dark:text-green-400">
                {uploadResult}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending contributions */}
      {info && info.pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending Contributions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}

            {info.pending.map((p) => (
              <div key={p.id} className="space-y-2">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">{p.contributor}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.tile_count.toLocaleString()} tiles &middot;{" "}
                      {new Date(p.created_at ?? p.timestamp ?? "").toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">{p.id}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePreview(p.id)}
                      disabled={previewLoading && previewId === p.id}
                    >
                      {previewLoading && previewId === p.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Eye className="mr-1 h-3.5 w-3.5" />
                      )}
                      Preview
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleApprove(p.id)}
                      disabled={actionLoading === p.id}
                    >
                      {actionLoading === p.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="mr-1 h-3.5 w-3.5" />
                      )}
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleReject(p.id)}
                      disabled={actionLoading === p.id}
                    >
                      <XIcon className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                </div>

                {/* Preview image */}
                {previewId === p.id && previewUrl && (
                  <div className="rounded-md border overflow-hidden bg-black/5">
                    <div className="p-2 border-b bg-muted/30 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-block w-3 h-3 rounded-sm bg-green-500/70" />
                      <span>Green-highlighted areas are new tiles from this contribution</span>
                    </div>
                    <img
                      src={previewUrl}
                      alt="Merge preview"
                      className="w-full h-auto"
                    />
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Approved history */}
      {info && info.approved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Approved Contributions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {info.approved
                .slice()
                .reverse()
                .map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0"
                  >
                    <div>
                      <span className="font-medium">{a.contributor}</span>
                      <span className="text-muted-foreground ml-2">
                        +{a.tiles_new.toLocaleString()} new tiles
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(a.approved_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
