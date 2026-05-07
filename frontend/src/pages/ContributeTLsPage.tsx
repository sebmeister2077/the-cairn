/**
 * Contribute Translocators page.
 *
 * Three-step flow:
 *   1. upload  \u2014 user uploads a client-chat.log file.
 *   2. review  \u2014 split-pane: map preview + list of parsed TLs.
 *   3. submit  \u2014 send the contribution to the backend (currently a stub).
 */

import { useState, useMemo } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setContributor,
  setSubmittedCount,
  resetContributeTLs,
} from "@/store/slices/contributeTLs";
import { useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import { ChatLogUploadCard } from "@/components/contribute-tls/ChatLogUploadCard";
import { TLPreviewMap } from "@/components/contribute-tls/TLPreviewMap";
import { TLReviewList } from "@/components/contribute-tls/TLReviewList";
import { EditTLDialog } from "@/components/contribute-tls/EditTLDialog";
import { WhatToDoDialog } from "@/components/contribute-tls/WhatToDoDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { contributeTLs } from "@/lib/api";
import type { TLContributionPayload, TLContributionResult } from "@/models/contributeTLs";

type Step = "upload" | "review" | "done";

export function ContributeTLsPage() {
  const dispatch = useAppDispatch();
  const userTLs = useAppSelector((s) => s.contributeTLs.userTLs);
  const contributor = useAppSelector((s) => s.contributeTLs.contributor);
  const submittedCount = useAppSelector((s) => s.contributeTLs.submittedCount);

  const [step, setStep] = useState<Step>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const translocatorsQuery = useTranslocatorsOverlay();
  const serverSegments = useMemo(
    () => translocatorsQuery.data?.data ?? [],
    [translocatorsQuery.data],
  );

  // Auto-advance to "done" step once a submission completes.
  if (submittedCount != null && step !== "done") {
    // Defer to a microtask via setState during render is fine for state
    // already in the same component.
    setStep("done");
  }

  // Counts used by the pre-submit summary modal.
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
        contributor: contributor.trim() || undefined,
      };
      let result: TLContributionResult;
      try {
        result = await contributeTLs(payload);
      } catch (e: unknown) {
        // Backend not implemented yet \u2014 surface a friendly message but
        // still let the user "see" what would have been submitted.
        const msg = e instanceof Error ? e.message : "Unknown error";
        if (/404|not found|501|not implemented/i.test(msg)) {
          setSubmitError(
            "The backend endpoint isn't available yet (it's still being built). " +
              "Your work is preserved on this page \u2014 please try again later.",
          );
          return;
        }
        throw e;
      }
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
            {submittedCount === 1 ? "" : "s"} is now pending review.
          </p>
          <Button
            type="button"
            onClick={() => {
              dispatch(resetContributeTLs());
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
        <ChatLogUploadCard serverSegments={serverSegments} onParsed={() => setStep("review")} />
      </div>
    );
  }

  return (
    // Break out of the parent <main>'s max-w-3xl so the map has room to
    // breathe alongside the 360px review sidebar.
    <div className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen">
      <div className="mx-auto max-w-400 px-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("upload")}>
            <ArrowLeft className="size-4 mr-1" />
            Back to upload
          </Button>
          <WhatToDoDialog />
          <div className="ml-auto flex items-end gap-2">
            <div>
              <Label htmlFor="contributor-name" className="text-xs">
                Contributor name (optional)
              </Label>
              <Input
                id="contributor-name"
                value={contributor}
                onChange={(e) => dispatch(setContributor(e.target.value))}
                placeholder="e.g. your in-game name"
                className="w-64"
              />
            </div>
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
          {/* Sticky + bounded height so the inner CardContent (which already
           * has `flex-1 overflow-y-auto`) actually overflows instead of
           * stretching the page. Without a fixed height ancestor, the card
           * grows with its content and `scrollIntoView` ends up scrolling
           * the whole window. */}
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
