/**
 * Chat-log based TL contribution flow.
 *
 * Extracted from `ContributeTLsPage.tsx` so the page can host this
 * alongside the screenshot-based flow as sibling tabs without changing
 * the existing logic.
 */

import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setSubmittedCount, resetContributeTLs } from "@/store/slices/contributeTLs";
import { useTranslocatorsOverlay, TRANSLOCATORS_QUERY_KEY } from "@/hooks/useOverlayData";
import { ChatLogUploadCard } from "@/components/contribute-tls/ChatLogUploadCard";
import { TLPreviewMap } from "@/components/contribute-tls/TLPreviewMap";
import { TLReviewList } from "@/components/contribute-tls/TLReviewList";
import { EditTLDialog } from "@/components/contribute-tls/EditTLDialog";
import { WhatToDoDialog } from "@/components/contribute-tls/WhatToDoDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { contributeTLs, ApiError } from "@/lib/api";
import type { TLContributionPayload, TLContributionResult } from "@/models/contributeTLs";

type Step = "upload" | "review" | "done";

export function ChatLogContributeFlow() {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const userTLs = useAppSelector((s) => s.contributeTLs.userTLs);
  const submittedCount = useAppSelector((s) => s.contributeTLs.submittedCount);

  const [step, setStep] = useState<Step>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skippedExisting, setSkippedExisting] = useState<number>(0);

  const translocatorsQuery = useTranslocatorsOverlay();
  const serverSegments = useMemo(
    () => translocatorsQuery.data?.data ?? [],
    [translocatorsQuery.data],
  );

  if (submittedCount != null && step !== "done") {
    setStep("done");
  }

  const counts = useMemo(() => {
    const c = {
      confirmed: 0,
      unconfirmed: 0,
      unpaired: 0,
      invalid: 0,
      existing: 0,
    };
    for (const tl of userTLs) {
      if (tl.status === "new-confirmed") c.confirmed++;
      else if (tl.status === "new-unconfirmed") c.unconfirmed++;
      else if (tl.status === "unpaired") c.unpaired++;
      else if (tl.status === "invalid") c.invalid++;
      else if (tl.status === "existing") c.existing++;
    }
    return c;
  }, [userTLs]);
  const submittableCount = counts.confirmed + counts.unconfirmed;

  function openSubmitConfirm() {
    if (submittableCount === 0) {
      setSubmitError(
        "There are no submittable translocators. Pair or fix the highlighted entries first.",
      );
      return;
    }
    setSubmitError(null);
    setConfirmOpen(true);
  }

  async function handleSubmit() {
    const submittable = userTLs.filter(
      (t) => t.status === "new-confirmed" || t.status === "new-unconfirmed",
    );
    if (submittable.length === 0) {
      setSubmitError(
        "There are no submittable translocators. Pair or fix the highlighted entries first.",
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const submittableTotal = submittable.length;
      const denom = counts.existing + submittableTotal;
      const existingMatchPct = denom === 0 ? 0 : Math.round((counts.existing / denom) * 1000) / 10;
      const payload: TLContributionPayload = {
        translocators: submittable
          .filter((tl) => tl.endpointB != null)
          .map((tl) => ({
            x1: tl.endpointA.x,
            z1: tl.endpointA.z,
            x2: tl.endpointB!.x,
            z2: tl.endpointB!.z,
            label: tl.endpointA.label,
          })),
        stats: {
          existing_match_pct: existingMatchPct,
          existing_pair_count: counts.existing,
        },
      };
      let result: TLContributionResult;
      try {
        result = await contributeTLs(payload);
      } catch (e: unknown) {
        if (e instanceof ApiError) {
          if (e.status === 503) {
            setSubmitError(
              "Translocator contributions are currently disabled. Please try again later.",
            );
            return;
          }
          if (e.status === 403) {
            setSubmitError(
              "You need an account to contribute translocators. Create one and try again.",
            );
            return;
          }
          if (e.status === 404 || e.status === 501) {
            setSubmitError(
              "The backend endpoint isn\u2019t available yet. " +
                "Your work is preserved on this page \u2014 please try again later.",
            );
            return;
          }
        }
        throw e;
      }
      setSkippedExisting(result.skipped_existing ?? 0);
      queryClient.invalidateQueries({ queryKey: TRANSLOCATORS_QUERY_KEY });
      dispatch(setSubmittedCount(result.accepted ?? submittable.length));
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  if (step === "done") {
    return (
      <Card className="max-w-xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-500" />
            Submitted
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>
            Thanks! Your contribution of <strong>{submittedCount ?? 0}</strong> translocator
            {submittedCount === 1 ? "" : "s"} is now live on the map.
          </p>
          {skippedExisting > 0 && (
            <p className="text-sm text-muted-foreground">
              <strong>{skippedExisting}</strong> submitted pair
              {skippedExisting === 1 ? " was" : "s were"} already on the server and skipped.
            </p>
          )}
          <Button
            type="button"
            onClick={() => {
              dispatch(resetContributeTLs());
              setSkippedExisting(0);
              setStep("upload");
            }}
          >
            Contribute another batch
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (step === "upload" || userTLs.length === 0) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <ChatLogUploadCard onParsed={() => setStep("review")} />
      </div>
    );
  }

  return (
    <div className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen">
      <div className="mx-auto max-w-400 px-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("upload")}>
            <ArrowLeft className="size-4 mr-1" />
            Back to upload
          </Button>
          <WhatToDoDialog />
          <div className="ml-auto flex items-end gap-2">
            <Button
              type="button"
              onClick={openSubmitConfirm}
              disabled={submitting || submittableCount === 0}
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Submit contribution{submittableCount > 0 ? ` (${submittableCount})` : ""}
            </Button>
          </div>
        </div>
        {submitError && (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900"
            role="alert"
          >
            {submitError}
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start">
          <TLPreviewMap serverSegments={serverSegments} />
          <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
            <TLReviewList />
          </div>
        </div>
        <EditTLDialog serverSegments={serverSegments} />
        <ConfirmDialog
          open={confirmOpen}
          title="Submit contribution?"
          description={
            <span className="block space-y-1">
              <span className="block">
                You&rsquo;re about to submit <strong>{submittableCount}</strong> translocator
                {submittableCount === 1 ? "" : "s"}:
              </span>
              <span className="block pl-3 text-xs">
                • {counts.confirmed} confirmed
                <br />• {counts.unconfirmed} needing review (still submitted)
              </span>
              {(counts.unpaired > 0 || counts.invalid > 0 || counts.existing > 0) && (
                <span className="block pt-1">
                  Skipped (not submitted):
                  <span className="block pl-3 text-xs">
                    {counts.unpaired > 0 && (
                      <>
                        • {counts.unpaired} unpaired
                        <br />
                      </>
                    )}
                    {counts.invalid > 0 && (
                      <>
                        • {counts.invalid} invalid
                        <br />
                      </>
                    )}
                    {counts.existing > 0 && <>• {counts.existing} already on map</>}
                  </span>
                </span>
              )}
              {counts.unconfirmed > 0 && (
                <span className="block pt-2 text-xs text-amber-700">
                  Note: {counts.unconfirmed} pairing{counts.unconfirmed === 1 ? " is" : "s are"}{" "}
                  flagged as needing review. Consider verifying them before submitting.
                </span>
              )}
            </span>
          }
          confirmLabel="Submit"
          loading={submitting}
          onConfirm={handleSubmit}
          onCancel={() => setConfirmOpen(false)}
        />
      </div>
    </div>
  );
}
