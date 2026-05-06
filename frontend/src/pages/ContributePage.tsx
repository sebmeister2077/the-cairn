import { AdminBackupsPanel } from "@/components/AdminBackupsPanel";
import { ApprovedContributionsCard } from "@/components/contributions/ApprovedContributionsCard";
import { CantContributeCard } from "@/components/contributions/CantContributeCard";
import { ContributeUploadCard } from "@/components/contributions/ContributeUploadCard";
import { PendingContributionsSection } from "@/components/contributions/PendingContributionsSection";
import { RevertedContributionsSection } from "@/components/contributions/RevertedContributionsSection";
import { WithdrawnContributionsCard } from "@/components/contributions/WithdrawnContributionsCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  approveContribution,
  fetchImageFromSignedUrl,
  getContributeInfo,
  getContributePreview,
  recomputeMatchScore,
  rejectContribution,
  revertContribution,
  withdrawContribution,
} from "@/lib/api";
import { RecentContributionsGridMemo } from "@/lib/component-helpers/contribute/memoiseContributionsGrid";
import { contributeQueries } from "@/lib/constants/react-query";
import type { ContributeInfo } from "@/models/contributions";
import { userReduxState } from "@/store/hooks";
import { useQuery, useQueryClient, type DefaultError } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

export function ContributePage() {
  const queryClient = useQueryClient();
  const isAdmin = userReduxState("auth.isAdmin");
  const canContribute = userReduxState("auth.canContribute");

  if (!canContribute) {
    return <CantContributeCard />;
  }

  // Contribute info via React Query. Phase 1: when at least one pending row
  // has a not-yet-ready match score we poll every 5 s so the badge updates
  // automatically while the worker grinds through its queue.
  const contributeInfoQuery = useQuery<
    ContributeInfo,
    DefaultError,
    ContributeInfo,
    typeof contributeQueries.contributeInfo.queryKey
  >({
    ...contributeQueries.contributeInfo,
    refetchInterval: (query) => {
      const data = query.state.data as ContributeInfo | undefined;
      const hasPendingScore = !!data?.pending.some((p) => p.match_score?.status === "pending");
      // Phase: async validation + async approval workers. Poll every 5 s
      // while any pending row is still being validated by the upload worker
      // or being merged by the approval worker so the badge transitions
      // (queued → running → gone) without a manual refresh.
      const hasPendingValidation = !!data?.pending.some((p) => p.validation_status === "pending");
      const hasInflightApproval = !!data?.pending.some(
        (p) => p.approval_status === "queued" || p.approval_status === "running",
      );
      const shouldPoll = hasPendingScore || hasPendingValidation || hasInflightApproval;
      const pollingRate = isAdmin ? 5000 : 60_000;

      return shouldPoll ? pollingRate : false;
    },
    meta: { persist: true },
  });
  const contributionInfo = contributeInfoQuery.data ?? null;
  const contributeInfoLoading = contributeInfoQuery.isLoading;

  // Preview state
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewQuery = useQuery<Blob>({
    queryKey: ["contribute-preview", previewId],
    queryFn: async () => {
      const row = contributionInfo?.pending.find((p) => p.id === previewId);
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
  // Two-step reject — holds the id of the contribution awaiting confirmation
  // so an accidental click on the destructive button can't drop precious
  // contributor data without a deliberate second confirmation.
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const deleteTarget = rejectingId
    ? (contributionInfo?.pending.find((p) => p.id === rejectingId) ?? null)
    : null;

  const handleRevertHistory = useCallback(
    async (id: string) => {
      await revertContribution(id);
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
    },
    [queryClient],
  );

  const cooldownDays = contributionInfo?.cooldown_days ?? 7;
  const canContributeFromData = contributionInfo?.can_contribute !== false;
  const reason = contributionInfo?.cooldown_reason ?? null;
  const nextAllowed = contributionInfo?.next_allowed_at
    ? new Date(contributionInfo.next_allowed_at)
    : null;

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
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
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
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
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
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
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
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Recompute failed");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Admin: weekly backups + restore (Phase 4a). Feature flags + map lock
          live on the dedicated Manage → Feature Flags page. */}
      {isAdmin && <AdminBackupsPanel />}

      {/* Upload card */}
      <ContributeUploadCard
        contributionInfo={contributionInfo}
        infoLoading={contributeInfoLoading}
        canContributeFromData={canContributeFromData}
        isAdmin={!!isAdmin}
        cooldownDays={cooldownDays}
        nextAllowed={nextAllowed}
        reason={reason}
      />

      {/* Pending contributions */}
      {contributionInfo && contributionInfo.pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending Contributions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}

            {contributionInfo.pending.map((p) => (
              <PendingContributionsSection
                key={p.id}
                contribution={p}
                contributeInfo={contributionInfo}
                isAdmin={!!isAdmin}
                previewId={previewId}
                previewUrl={previewUrl}
                previewLoading={previewLoading}
                actionLoading={actionLoading}
                handlePreview={handlePreview}
                handleWithdraw={handleWithdraw}
                handleApprove={handleApprove}
                setRejectingId={setRejectingId}
                handleRecomputeMatchScore={handleRecomputeMatchScore}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Approved history. Reverted entries are excluded here (they appear
          in their own admin-only section below the Recent contributions
          grid). The backend currently leaves reverted rows in the approved
          list, so we cross-reference by id with `info.history`. */}
      {contributionInfo && <ApprovedContributionsCard info={contributionInfo} />}

      {/* Recent contributions grid (all-time history with previews). Visible
          to non-admins only when the public_history flag is on; admins
          always see it. */}
      {contributionInfo &&
        (contributionInfo.public_history_enabled || isAdmin || contributionInfo.is_admin) &&
        contributionInfo.history &&
        contributionInfo.history.length > 0 && (
          <RecentContributionsGridMemo
            history={contributionInfo.history}
            isAdmin={!!isAdmin || !!contributionInfo.is_admin}
            totalCount={contributionInfo.history_total ?? contributionInfo.history.length}
            revertWindowDays={contributionInfo.revert_window_days ?? 14}
            onRevert={handleRevertHistory}
          />
        )}

      {/* Withdrawn contributions — admin-only, shown below the Recent
          contributions grid. */}
      <WithdrawnContributionsCard info={contributionInfo} isAdmin={!!isAdmin} />

      {/* Reverted contributions — admin-only. Sourced from the history
          feed (status='reverted' or 'orphaned_by_restore'). */}
      <RevertedContributionsSection info={contributionInfo} isAdmin={!!isAdmin} />

      {/* Two-step confirmation for the destructive Reject action. */}
      <ConfirmDialog
        open={!!rejectingId}
        title="Reject this contribution?"
        description={
          deleteTarget ? (
            <>
              This will permanently reject the contribution from{" "}
              <span className="font-medium">{deleteTarget.contributor}</span> (
              {deleteTarget.tile_count.toLocaleString()} chunks). The uploaded data will be
              discarded and cannot be recovered.
            </>
          ) : (
            "The uploaded data will be discarded and cannot be recovered."
          )
        }
        confirmLabel="Reject contribution"
        cancelLabel="Keep pending"
        variant="destructive"
        loading={!!rejectingId && actionLoading === rejectingId}
        onCancel={() => setRejectingId(null)}
        onConfirm={async () => {
          if (!rejectingId) return;
          const id = rejectingId;
          await handleReject(id);
          setRejectingId(null);
        }}
      />
    </div>
  );
}
