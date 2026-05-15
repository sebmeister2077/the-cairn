import type { ContributeInfo, PendingContribution } from "@/models/contributions";
import { PendingLifecycleBadge } from "./PendingLyfecycleBadge";
import { Button } from "../ui/button";
import { Check, Eye, Loader2, Undo2, XIcon } from "lucide-react";
import { MapViewer } from "../MapViewer";
import { ContributionBeforeAfter } from "../ContributionBeforeAfter";
import { MatchScoreBadge } from "./MatchScoreBadge";

export function PendingContributionsSection({
  contribution,
  contributeInfo,
  isAdmin,
  previewId,
  previewUrl,
  previewLoading,
  actionLoading,
  handlePreview,
  handleWithdraw,
  handleApprove,
  setRejectingId,
  handleRecomputeMatchScore,
}: {
  isAdmin: boolean;
  contribution: PendingContribution;
  contributeInfo: ContributeInfo;
  previewId: string | null;
  previewUrl: string | null;
  previewLoading: boolean;
  actionLoading: string | null;
  handlePreview: (contributionId: string) => void;
  handleWithdraw: (contributionId: string) => void;
  handleApprove: (contributionId: string) => void;
  setRejectingId: (contributionId: string | null) => void;
  handleRecomputeMatchScore: (contributionId: string) => void;
}) {
  const previewBlocked =
    contributeInfo?.heavy_compute_enabled === false && !contribution.preview_signed_url;
  const isPreviewLoading = previewLoading && previewId === contribution.id;
  const previewDisabled = isPreviewLoading || previewBlocked;
  const previewTitle = previewBlocked
    ? "Preview generation is paused while the server is at reduced capacity. An admin will render previews shortly."
    : undefined;

  const validating = contribution.validation_status === "pending";
  const merging =
    contribution.approval_status === "queued" || contribution.approval_status === "running";
  const approveDisabled = actionLoading === contribution.id || validating || merging;
  const approveTitle = validating
    ? "Waiting for upload validation to finish before approval is allowed."
    : merging
      ? "Already merging in the background."
      : undefined;
  const approveLabel = merging
    ? contribution.approval_status === "running"
      ? "Merging…"
      : "Queued…"
    : "Approve";

  return (
    <div key={contribution.id} className="space-y-2">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">{contribution.contributor}</div>
          <div className="text-xs text-muted-foreground">
            {contribution.tile_count.toLocaleString()} chunks &middot;{" "}
            {new Date(contribution.created_at ?? contribution.timestamp ?? "").toLocaleDateString()}
          </div>
          <div className="text-xs text-muted-foreground font-mono">{contribution.id}</div>
          {contributeInfo.match_score_enabled && contribution.match_score && (
            <MatchScoreBadge
              score={contribution.match_score}
              canRecompute={isAdmin && contribution.match_score.status !== "pending"}
              onRecompute={() => handleRecomputeMatchScore(contribution.id)}
              recomputing={actionLoading === contribution.id}
              heavyComputeEnabled={contributeInfo?.heavy_compute_enabled !== false}
            />
          )}
          <PendingLifecycleBadge
            contribution={contribution}
            heavyComputeEnabled={contributeInfo?.heavy_compute_enabled !== false}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePreview(contribution.id)}
            disabled={previewDisabled}
            title={previewTitle}
            aria-disabled={previewDisabled}
          >
            {isPreviewLoading ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="mr-1 h-3.5 w-3.5" />
            )}
            {previewBlocked ? "Preview paused" : "Preview"}
          </Button>
          {contribution.is_mine && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleWithdraw(contribution.id)}
              disabled={
                actionLoading === contribution.id ||
                (!isAdmin && !!contributeInfo?.withdraw_next_allowed_at)
              }
              title={
                !isAdmin && contributeInfo?.withdraw_next_allowed_at
                  ? `Weekly withdraw limit reached. Next allowed: ${new Date(
                      contributeInfo.withdraw_next_allowed_at,
                    ).toLocaleString()}`
                  : undefined
              }
              className="text-destructive hover:text-destructive"
            >
              {actionLoading === contribution.id ? (
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
                onClick={() => handleApprove(contribution.id)}
                disabled={approveDisabled}
                title={approveTitle}
              >
                {actionLoading === contribution.id || merging ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1 h-3.5 w-3.5" />
                )}
                {approveLabel}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setRejectingId(contribution.id)}
                disabled={actionLoading === contribution.id}
              >
                <XIcon className="mr-1 h-3.5 w-3.5" />
                Reject
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Preview image */}
      {previewId === contribution.id && previewUrl && (
        <div className="rounded-md border overflow-hidden bg-black/5">
          <MapViewer
            imageUrl={previewUrl}
            alt="Merge preview"
            height="60vh"
            bordered={false}
            legend={
              <>
                <span className="inline-block w-3 h-3 rounded-sm bg-green-500/70" />
                <span>Green-highlighted areas are new chunks from this contribution</span>
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
      {previewId === contribution.id &&
        contribution.update_region_mode === "overwrite" &&
        contribution.update_region && <ContributionBeforeAfter contributionId={contribution.id} />}

      {/* Region badge — visible whenever the upload was a
                    region-overwrite, even if bounds are redacted. */}
      {contribution.update_region_mode === "overwrite" && (
        <div className="text-xs text-muted-foreground">
          Region overwrite
          {contribution.update_region && (
            <>
              {" "}
              — x [{contribution.update_region.min_x}, {contribution.update_region.max_x}], z [
              {contribution.update_region.min_z}, {contribution.update_region.max_z}]
            </>
          )}
        </div>
      )}
    </div>
  );
}
