import { useState, useEffect, useMemo, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getContributeInfo,
  contributeMap,
  getContributePreview,
  approveContribution,
  rejectContribution,
  withdrawContribution,
  revertContribution,
  recomputeMatchScore,
  getStoredIsAdmin,
  getStoredCanContribute,
  fetchImageFromSignedUrl,
  getMyAccount,
  getTopsMapStats,
  type ContributionRegion,
} from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Upload, Users, Map, Eye, Check, XIcon, HelpCircle, Undo2, RefreshCw, History, ImageOff } from "lucide-react";
import { MapViewer } from "@/components/MapViewer";
import { AdminFeatureFlagsPanel } from "@/components/AdminFeatureFlagsPanel";
import { AdminBackupsPanel } from "@/components/AdminBackupsPanel";
import { ContributionRegionPicker } from "@/components/ContributionRegionPicker";
import { ContributionBeforeAfter } from "@/components/ContributionBeforeAfter";

// Phase 1 — informational match-score result attached to each pending row.
interface MatchScore {
  status: "pending" | "ready" | "failed";
  tile_overlap_pct?: number;
  pixel_similar_pct?: number;
  overlap_count?: number;
  pending_total?: number;
  reason?: string;
}

interface PendingContribution {
  id: string;
  contributor: string;
  created_at: string;
  timestamp?: string;
  tile_count: number;
  status: string;
  is_mine: boolean;
  preview_image_url?: string;
  preview_signed_url?: string;
  match_score?: MatchScore | null;
  // Phase 2 — region-restricted update bounds (admin-or-owner only) and mode
  // ("overwrite" | "gap_fill"). The mode is always present; bounds are
  // redacted from non-admin/non-owner viewers.
  update_region?: {
    min_x: number;
    max_x: number;
    min_z: number;
    max_z: number;
  } | null;
  update_region_mode?: "overwrite" | "gap_fill";
}

interface WithdrawnEntry {
  id: string;
  withdrawn_at: string;
  is_mine: boolean;
}

interface ApprovedEntry {
  id: string;
  contributor: string;
  approved_at: string;
  tiles_new: number;
  tiles_existing: number;
  combined_total: number;
}

// Phase 3 — public history grid entry. Returned for approved (and
// withdrawn-with-preview) contributions whose retention deadline hasn't
// elapsed.
interface HistoryEntry {
  id: string;
  status: "approved" | "withdrawn" | "reverted" | "orphaned_by_restore";
  contributor: string;
  tile_count: number;
  tiles_new?: number | null;
  tiles_existing?: number | null;
  combined_total?: number | null;
  approved_at?: string | null;
  withdrawn_at?: string | null;
  preview_signed_url?: string | null;
  is_mine?: boolean;
  // Phase 4b — admin-only fields surfaced for revert UI.
  revert_supported?: boolean;
  revert_added_count?: number | null;
  revert_replaced_count?: number | null;
  reverted_at?: string | null;
  can_revert?: boolean;
}

interface ContributeInfo {
  map_id: string;
  total_tiles: number;
  pending: PendingContribution[];
  withdrawn: WithdrawnEntry[];
  approved: ApprovedEntry[];
  history?: HistoryEntry[];
  history_total?: number;
  history_window_days?: number;
  public_history_enabled?: boolean;
  is_admin?: boolean;
  match_score_enabled?: boolean;
  revert_enabled?: boolean;
  revert_window_days?: number;
  can_contribute?: boolean;
  cooldown_reason?: "pending" | "cooldown" | null;
  pending_contribution_id?: string | null;
  next_allowed_at?: string | null;
  cooldown_days?: number;
  withdraw_limit_per_week?: number;
  withdrawals_used_this_week?: number;
  withdraw_next_allowed_at?: string | null;
  // Phase 2 — region-restricted update gating
  region_overwrite_enabled?: boolean;
  can_use_region_overwrite?: boolean;
  region_tile_cap_non_admin?: number;
}

export function ContributePage() {
  const queryClient = useQueryClient();
  const isAdmin = getStoredIsAdmin();
  const canContribute = getStoredCanContribute();

  if (!canContribute) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Contribute Map Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            This page lets players upload their local Vintage Story map cache so admins can
            review and merge new tiles into the shared community map.
          </p>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="font-medium text-foreground">Access required</p>
            <p className="mt-1">
              Your current API key does not have contribute permission.
              Please request a <strong>Read &amp; Contribute</strong> key from an admin.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const [dbFile, setDbFile] = useState<File | null>(null);
  const [contributor, setContributor] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  // Phase 2 — region-restricted update state. `null` = legacy gap-fill mode.
  const [region, setRegion] = useState<ContributionRegion | null>(null);

  // Contribute info via React Query. Phase 1: when at least one pending row
  // has a not-yet-ready match score we poll every 5 s so the badge updates
  // automatically while the worker grinds through its queue.
  const infoQuery = useQuery<ContributeInfo>({
    queryKey: ["contribute-info"],
    queryFn: () => getContributeInfo(),
    refetchInterval: (query) => {
      const data = query.state.data as ContributeInfo | undefined;
      const hasPendingScore = !!data?.pending.some(
        (p) => p.match_score?.status === "pending",
      );
      return hasPendingScore ? 5000 : false;
    },
  });
  const info = infoQuery.data ?? null;
  const infoLoading = infoQuery.isLoading;

  // Phase 2 — fetch the multi-resolution TOPS map metadata so the region
  // picker can pick the cheapest complete level. We only enable this query
  // when the contributor is actually allowed to use region-overwrite, to
  // avoid hammering the endpoint for everyone.
  const regionPickerEnabled = info?.can_use_region_overwrite === true;
  const topsStatsQuery = useQuery<{
    resolutions?: Array<{
      level: number;
      max_dimension: number;
      status: "complete" | "generating" | "not_generated" | "failed";
      generated_at?: string | null;
      size_bytes?: number | null;
      progress?: number;
    }>;
  }>({
    queryKey: ["tops-map-stats"],
    queryFn: getTopsMapStats,
    enabled: regionPickerEnabled,
    retry: false,
  });
  const availableLevels = topsStatsQuery.data?.resolutions ?? [];

  // Current account — used to honour the user's "Show Contributions" preference.
  const accountQuery = useQuery({
    queryKey: ["account-me"],
    queryFn: getMyAccount,
    retry: false,
  });  const showContributions = accountQuery.data?.user?.show_contributions ?? false;
  const canSeeContributors = isAdmin || info?.is_admin || showContributions;
  const displayContributor = (name: string) =>
    canSeeContributors ? name : "Anonymous";

  // Preview state
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewQuery = useQuery<Blob>({
    queryKey: ["contribute-preview", previewId],
    queryFn: async () => {
      const row = info?.pending.find((p) => p.id === previewId);
      const signedUrl = row?.preview_signed_url;
      if (signedUrl) {
        const blob = await fetchImageFromSignedUrl(signedUrl);
        if (blob) return blob;
      }
      // Fallback: fetch via authenticated proxy
      return getContributePreview(previewId!);
    },
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
      const data = await contributeMap(
        dbFile,
        contributor,
        (pct) => setUploadProgress(pct),
        region,
      );
      setUploadResult(data.message as string);
      setDbFile(null);
      setFileInputKey((prev) => prev + 1);
      setRegion(null);
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

  async function handleWithdraw(id: string) {
    setActionLoading(id);
    setActionError("");
    try {
      await withdrawContribution(id);
      if (previewId === id) setPreviewId(null);
      queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRecomputeMatchScore(id: string) {
    setActionLoading(id);
    setActionError("");
    try {
      await recomputeMatchScore(id);
      queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Recompute failed");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Admin: feature flags + map lock (Phase 0) */}
      {isAdmin && <AdminFeatureFlagsPanel />}
      {/* Admin: weekly backups + restore (Phase 4a) */}
      {isAdmin && <AdminBackupsPanel />}

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

          {(() => {
            if (isAdmin || info?.is_admin) return null;
            const cooldownDays = info?.cooldown_days ?? 7;
            const canContribute = info?.can_contribute !== false;
            const reason = info?.cooldown_reason ?? null;
            const nextAllowed = info?.next_allowed_at
              ? new Date(info.next_allowed_at)
              : null;
            return (
              <div
                className={
                  "rounded-md border p-3 text-sm space-y-1 " +
                  (canContribute
                    ? "bg-muted/30 text-muted-foreground"
                    : "bg-destructive/10 border-destructive/30 text-destructive")
                }
              >
                <p className="font-medium text-foreground">
                  Contribution limits
                </p>
                <p>
                  To prevent abuse of server uploads, non-admin contributors may
                  have <strong>one pending upload at a time</strong>, and must
                  wait <strong>{cooldownDays} days</strong> after a contribution
                  is approved before submitting another.
                </p>
                {!canContribute && reason === "pending" && (
                  <p>
                    You already have a pending contribution awaiting review.
                    Withdraw it below before submitting a new one.
                  </p>
                )}
                {!canContribute && reason === "cooldown" && nextAllowed && (
                  <p>
                    Your last contribution was approved. You can contribute
                    again on{" "}
                    <strong>{nextAllowed.toLocaleString()}</strong>.
                  </p>
                )}
              </div>
            );
          })()}

          <form onSubmit={handleSubmit} className="space-y-4">
            <FileUpload
              key={fileInputKey}
              id="contribute-db"
              label="Map Database (.db)"
              accept=".db"
              required
              onChange={setDbFile}
              disabled={!isAdmin && info?.can_contribute === false}
            />

            <div className="space-y-2">
              <Label htmlFor="contributor-name">Your Name (optional)</Label>
              <Input
                id="contributor-name"
                placeholder="Anonymous"
                value={contributor}
                onChange={(e) => setContributor(e.target.value)}
                maxLength={50}
                disabled={!isAdmin && info?.can_contribute === false}
              />
            </div>

            {regionPickerEnabled && (
              <div className="space-y-2 rounded border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="m-0">
                    Region overwrite{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      (optional, replaces in-region tiles)
                    </span>
                  </Label>
                  {isAdmin && (
                    <Badge variant="outline">admin / region_overwrite</Badge>
                  )}
                </div>
                <ContributionRegionPicker
                  availableLevels={availableLevels}
                  value={region}
                  onChange={(r) => setRegion(r)}
                  tileAreaCap={
                    isAdmin
                      ? null
                      : info?.region_tile_cap_non_admin ?? null
                  }
                  disabled={uploading}
                />
              </div>
            )}

            <Button
              type="submit"
              disabled={
                !dbFile ||
                uploading ||
                (!isAdmin && info?.can_contribute === false)
              }
            >
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
                    <div className="text-sm font-medium">{p.is_mine ? p.contributor : displayContributor(p.contributor)}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.tile_count.toLocaleString()} tiles &middot;{" "}
                      {new Date(p.created_at ?? p.timestamp ?? "").toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">{p.id}</div>
                    {info.match_score_enabled && p.match_score && (
                      <MatchScoreBadge
                        score={p.match_score}
                        canRecompute={isAdmin && p.match_score.status !== "pending"}
                        onRecompute={() => handleRecomputeMatchScore(p.id)}
                        recomputing={actionLoading === p.id}
                      />
                    )}
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
                    {p.is_mine && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleWithdraw(p.id)}
                        disabled={
                          actionLoading === p.id ||
                          (!isAdmin && !!info?.withdraw_next_allowed_at)
                        }
                        title={
                          !isAdmin && info?.withdraw_next_allowed_at
                            ? `Weekly withdraw limit reached. Next allowed: ${new Date(
                                info.withdraw_next_allowed_at,
                              ).toLocaleString()}`
                            : undefined
                        }
                        className="text-destructive hover:text-destructive"
                      >
                        {actionLoading === p.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Undo2 className="mr-1 h-3.5 w-3.5" />
                        )}
                        Withdraw
                      </Button>
                    )}
                    {isAdmin && (
                      <>
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
                      </>
                    )}
                  </div>
                </div>

                {/* Preview image */}
                {previewId === p.id && (
                  <div className="rounded-md border overflow-hidden bg-black/5">
                    <MapViewer
                      imageUrl={previewId === p.id ? previewUrl : null}
                      alt="Merge preview"
                      height="60vh"
                      bordered={false}
                      legend={
                        <>
                          <span className="inline-block w-3 h-3 rounded-sm bg-green-500/70" />
                          <span>Green-highlighted areas are new tiles from this contribution</span>
                        </>
                      }
                    />
                  </div>
                )}

                {/* Phase 2 — region before/after preview (admin/owner only).
                    The endpoint is gated server-side by feature flag and
                    owner/admin checks, so we only need to gate the UI on
                    the presence of `update_region` (which the backend
                    redacts for non-admin/non-owner viewers anyway). */}
                {previewId === p.id &&
                  p.update_region_mode === "overwrite" &&
                  p.update_region && (
                    <ContributionBeforeAfter contributionId={p.id} />
                  )}

                {/* Region badge — visible whenever the upload was a
                    region-overwrite, even if bounds are redacted. */}
                {p.update_region_mode === "overwrite" && (
                  <div className="text-xs text-muted-foreground">
                    Region overwrite
                    {p.update_region && (
                      <>
                        {" "}— x [{p.update_region.min_x},{" "}
                        {p.update_region.max_x}], z [{p.update_region.min_z},{" "}
                        {p.update_region.max_z}]
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Withdrawn contributions — only shown to users with a withdrawn own entry */}
      {info && info.withdrawn && info.withdrawn.filter((w) => w.is_mine).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
              <Undo2 className="h-4 w-4" />
              Withdrawn Contributions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {info.withdrawn
                .filter((w) => w.is_mine)
                .map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0 opacity-60"
                  >
                    <div>
                      <span className="font-medium text-muted-foreground">[Withdrawn]</span>
                      <span className="text-xs text-muted-foreground ml-2 font-mono">{w.id}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(w.withdrawn_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
            </div>
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
                      <span className="font-medium">{displayContributor(a.contributor)}</span>
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

      {/* Phase 3 — Recent contributions grid (public 14-day history with previews) */}
      {info && info.public_history_enabled && info.history && info.history.length > 0 && (
        <RecentContributionsGrid
          history={info.history}
          windowDays={info.history_window_days ?? 14}
          isAdmin={!!isAdmin || !!info.is_admin}
          totalCount={info.history_total ?? info.history.length}
          displayContributor={displayContributor}
          revertWindowDays={info.revert_window_days ?? 14}
          onRevert={async (id) => {
            await revertContribution(id);
            queryClient.invalidateQueries({ queryKey: ["contribute-info"] });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 1 — Match-score badge (informational only, never blocks approval)
// ---------------------------------------------------------------------------

function MatchScoreBadge({
  score,
  canRecompute,
  onRecompute,
  recomputing,
}: {
  score: MatchScore;
  canRecompute: boolean;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  if (score.status === "pending") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Computing match score…</span>
      </div>
    );
  }

  if (score.status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-muted-foreground">
          Match score unknown
        </Badge>
        {canRecompute && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={onRecompute}
            disabled={recomputing}
            title={score.reason || "Retry match-score computation"}
          >
            {recomputing ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            Recompute
          </Button>
        )}
      </div>
    );
  }

  // status === "ready"
  const pixel = score.pixel_similar_pct ?? 0;
  const overlap = score.tile_overlap_pct ?? 0;
  const overlapCount = score.overlap_count ?? 0;
  const total = score.pending_total ?? 0;

  // Plan thresholds: ≥80% green ("looks like our map"), <20% orange
  // ("may be wrong file"), in between grey/neutral.
  let badgeClass: string;
  let label: string;
  if (pixel >= 80) {
    badgeClass = "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30";
    label = "Looks like our map";
  } else if (pixel < 20) {
    badgeClass = "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30";
    label = "May be wrong file";
  } else {
    badgeClass = "bg-muted text-muted-foreground border-border";
    label = "Partial match";
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Badge variant="outline" className={badgeClass}>
        {label}
      </Badge>
      <span className="text-muted-foreground">
        {overlap.toFixed(0)}% overlap ({overlapCount.toLocaleString()}/{total.toLocaleString()}) ·{" "}
        {pixel.toFixed(0)}% pixel-similar
      </span>
      {canRecompute && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={onRecompute}
          disabled={recomputing}
          title="Recompute match score"
        >
          {recomputing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3 — Recent contributions grid
//
// Renders a thumbnail grid of approved/withdrawn contributions whose preview
// is still retained. Clicking a tile expands it inline to a larger view.
// Anonymous-by-default — the contributor is shown only when the viewer has
// permission to see contributor names.
// ---------------------------------------------------------------------------

function RecentContributionsGrid({
  history,
  windowDays,
  isAdmin,
  totalCount,
  displayContributor,
  revertWindowDays,
  onRevert,
}: {
  history: HistoryEntry[];
  windowDays: number;
  isAdmin: boolean;
  totalCount: number;
  displayContributor: (name: string) => string;
  revertWindowDays: number;
  onRevert: (id: string) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const opened = openId ? history.find((h) => h.id === openId) ?? null : null;

  async function handleRevert(entry: HistoryEntry) {
    const tilesNew = entry.revert_added_count ?? entry.tiles_new ?? 0;
    const tilesReplaced = entry.revert_replaced_count ?? 0;
    const message =
      tilesReplaced > 0
        ? `Reverting will restore ${tilesReplaced.toLocaleString()} tiles to their pre-contribution state and remove ${tilesNew.toLocaleString()} tiles added in the region. Continue?`
        : `Reverting will delete ${tilesNew.toLocaleString()} tiles added by this contribution. The area returns to unmapped, not to a previous version. Continue?`;
    if (!window.confirm(message)) return;
    setRevertError(null);
    setRevertingId(entry.id);
    try {
      await onRevert(entry.id);
      setOpenId(null);
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : "Revert failed");
    } finally {
      setRevertingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          Recent Contributions
          <Badge variant="secondary" className="ml-1 font-normal">
            last {windowDays}d
          </Badge>
        </CardTitle>
        {isAdmin && totalCount > history.length && (
          <p className="text-xs text-muted-foreground">
            Showing {history.length} of {totalCount.toLocaleString()} retained.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {history.map((h) => {
            const isWithdrawn = h.status === "withdrawn";
            const isReverted = h.status === "reverted";
            const isOrphaned = h.status === "orphaned_by_restore";
            const dateStr = h.approved_at ?? h.withdrawn_at ?? "";
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => setOpenId(openId === h.id ? null : h.id)}
                className={
                  "group relative flex flex-col overflow-hidden rounded-md border bg-muted/20 text-left transition-colors hover:border-primary " +
                  (openId === h.id ? "ring-2 ring-primary" : "")
                }
              >
                <div className="aspect-video w-full bg-black/40 flex items-center justify-center overflow-hidden">
                  {h.preview_signed_url ? (
                    <img
                      src={h.preview_signed_url}
                      alt={`Preview of contribution ${h.id}`}
                      loading="lazy"
                      className={
                        "h-full w-full object-cover transition-opacity group-hover:opacity-90 " +
                        (isWithdrawn || isReverted || isOrphaned ? "opacity-60 grayscale" : "")
                      }
                    />
                  ) : (
                    <ImageOff className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-0.5 px-2 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="truncate font-medium">
                      {isWithdrawn
                        ? "[Withdrawn]"
                        : displayContributor(h.contributor)}
                    </span>
                    {isWithdrawn ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        withdrawn
                      </Badge>
                    ) : isReverted ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        reverted
                      </Badge>
                    ) : isOrphaned ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        orphaned
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground">
                    {!isWithdrawn && typeof h.tiles_new === "number"
                      ? `+${h.tiles_new.toLocaleString()} new tiles`
                      : `${h.tile_count.toLocaleString()} tiles`}
                  </div>
                  <div className="text-muted-foreground">
                    {dateStr ? new Date(dateStr).toLocaleDateString() : "—"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Click-to-enlarge inline view */}
        {opened && opened.preview_signed_url && (
          <div className="rounded-md border overflow-hidden bg-black/5">
            <MapViewer
              imageUrl={opened.preview_signed_url}
              alt={`Preview of contribution ${opened.id}`}
              height="60vh"
              bordered={false}
              legend={
                <span className="text-muted-foreground">
                  {opened.status === "withdrawn"
                    ? "[Withdrawn] · preview retained for transparency"
                    : opened.status === "reverted"
                    ? `Reverted · originally by ${displayContributor(opened.contributor)}`
                    : opened.status === "orphaned_by_restore"
                    ? `Orphaned by backup restore · ${displayContributor(opened.contributor)}`
                    : `${displayContributor(opened.contributor)} · approved ${
                        opened.approved_at
                          ? new Date(opened.approved_at).toLocaleString()
                          : ""
                      }`}
                </span>
              }
            />
            {isAdmin && (
              <div className="flex flex-col gap-2 border-t bg-muted/20 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                <div className="text-muted-foreground">
                  {opened.status === "approved" ? (
                    opened.can_revert ? (
                      <>
                        Revert window: {revertWindowDays}d ·{" "}
                        {(opened.revert_added_count ?? opened.tiles_new ?? 0).toLocaleString()} tile
                        {(opened.revert_added_count ?? opened.tiles_new ?? 0) === 1 ? "" : "s"} captured
                        {opened.revert_replaced_count
                          ? ` · ${opened.revert_replaced_count.toLocaleString()} overwrites`
                          : ""}
                      </>
                    ) : opened.revert_supported === false ? (
                      <>Revert unavailable — undo data was not captured (file too large or feature flag was off).</>
                    ) : (
                      <>Outside the {revertWindowDays}-day revert window — restore from a backup instead.</>
                    )
                  ) : (
                    <>Status: {opened.status}</>
                  )}
                </div>
                {opened.can_revert && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={revertingId === opened.id}
                    onClick={() => handleRevert(opened)}
                  >
                    {revertingId === opened.id ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Undo2 className="mr-1 h-3 w-3" />
                    )}
                    Revert this contribution
                  </Button>
                )}
              </div>
            )}
            {isAdmin && revertError && (
              <div className="border-t bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {revertError}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
