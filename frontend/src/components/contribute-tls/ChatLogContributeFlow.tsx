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
import { useReduxState } from "@/store/hooks";
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
import { Loader2, ArrowLeft, CheckCircle2, Clipboard, ClipboardCheck } from "lucide-react";
import { contributeTLs, ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { matchedServerSegmentKeys, segmentKey } from "@/lib/tl-matching";
import type { TLContributionPayload, TLContributionResult } from "@/models/contributeTLs";

/**
 * Default Y value used when generating `/waypoint addati spiral` commands
 * for server TLs the admin doesn't have yet. Server segments are stored as
 * 2D (x/z), so we emit a sentinel altitude — the admin can correct it
 * in-game by walking to the spiral marker.
 */
const ADMIN_WAYPOINT_DEFAULT_Y = 1;

type Step = "upload" | "review" | "done";

export function ChatLogContributeFlow() {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const userTLs = useAppSelector((s) => s.contributeTLs.userTLs);
  const submittedCount = useAppSelector((s) => s.contributeTLs.submittedCount);
  const isAdmin = useReduxState("auth.isAdmin");

  const [step, setStep] = useState<Step>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skippedExisting, setSkippedExisting] = useState<number>(0);
  const [copiedAdminCommands, setCopiedAdminCommands] = useState(false);

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

  /**
   * Admin-only: `/waypoint addati spiral` commands for every server TL
   * the admin doesn't have yet (i.e. server segments not matched by any
   * of the user TLs parsed from this chat log). Two commands per TL,
   * one per endpoint, labelled with the opposite endpoint's coords.
   */
  const adminMissingWaypointCommands = useMemo(() => {
    if (!isAdmin) return [];
    const covered = matchedServerSegmentKeys(userTLs);
    const out: string[] = [];
    for (const seg of serverSegments) {
      if (covered.has(segmentKey(seg))) continue;
      const x1 = Math.round(seg.x1);
      const z1 = Math.round(seg.z1);
      const x2 = Math.round(seg.x2);
      const z2 = Math.round(seg.z2);
      const y = ADMIN_WAYPOINT_DEFAULT_Y;
      out.push(`/waypoint addati spiral ${x1} ${y} ${z1} false purple TL to ${x2} ${z2}`);
      out.push(`/waypoint addati spiral ${x2} ${y} ${z2} false purple TL to ${x1} ${z1}`);
    }
    return out;
  }, [isAdmin, serverSegments, userTLs]);

  async function handleCopyAdminMissingCommands() {
    if (adminMissingWaypointCommands.length === 0) return;
    try {
      await navigator.clipboard.writeText(adminMissingWaypointCommands.join("\n"));
      setCopiedAdminCommands(true);
      window.setTimeout(() => setCopiedAdminCommands(false), 2000);
    } catch {
      // Clipboard write can fail in insecure contexts; ignore — the
      // button will simply not flip to "Copied!" so the admin notices.
    }
  }

  function openSubmitConfirm() {
    if (submittableCount === 0) {
      setSubmitError(t("contributeTLsPage.chatLogFlow.noSubmittable"));
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
      setSubmitError(t("contributeTLsPage.chatLogFlow.noSubmittable"));
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
            setSubmitError(t("contributeTLsPage.chatLogFlow.disabled"));
            return;
          }
          if (e.status === 403) {
            setSubmitError(t("contributeTLsPage.chatLogFlow.needsAccount"));
            return;
          }
          if (e.status === 404 || e.status === 501) {
            setSubmitError(t("contributeTLsPage.chatLogFlow.backendUnavailable"));
            return;
          }
        }
        throw e;
      }
      setSkippedExisting(result.skipped_existing ?? 0);
      queryClient.invalidateQueries({ queryKey: TRANSLOCATORS_QUERY_KEY });
      dispatch(setSubmittedCount(result.accepted ?? submittable.length));
    } catch (e: unknown) {
      setSubmitError(
        e instanceof Error ? e.message : t("contributeTLsPage.chatLogFlow.submitFailed"),
      );
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
            {t("contributeTLsPage.chatLogFlow.submittedTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>
            {t("contributeTLsPage.chatLogFlow.submittedBody", {
              count: submittedCount ?? 0,
              suffix: submittedCount === 1 ? "" : "s",
            })}
          </p>
          {skippedExisting > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("contributeTLsPage.chatLogFlow.skippedExisting", {
                count: skippedExisting,
              })}
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
            {t("contributeTLsPage.chatLogFlow.contributeAnotherBatch")}
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
            {t("contributeTLsPage.chatLogFlow.backToUpload")}
          </Button>
          <WhatToDoDialog />
          <div className="ml-auto flex items-end gap-2">
            {isAdmin && (
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyAdminMissingCommands}
                disabled={adminMissingWaypointCommands.length === 0}
                title={
                  adminMissingWaypointCommands.length === 0
                    ? t("contributeTLsPage.chatLogFlow.adminCopyNoneTitle")
                    : t("contributeTLsPage.chatLogFlow.adminCopySomeTitle")
                }
              >
                {copiedAdminCommands ? (
                  <ClipboardCheck className="mr-2 size-4" />
                ) : (
                  <Clipboard className="mr-2 size-4" />
                )}
                {copiedAdminCommands
                  ? t("contributeTLsPage.chatLogFlow.adminCopied")
                  : t("contributeTLsPage.chatLogFlow.adminCopyMissing", {
                      count:
                        adminMissingWaypointCommands.length > 0
                          ? t("contributeTLsPage.chatLogFlow.adminCopyCount", {
                              count: adminMissingWaypointCommands.length,
                            })
                          : "",
                    })}
              </Button>
            )}
            <Button
              type="button"
              onClick={openSubmitConfirm}
              disabled={submitting || submittableCount === 0}
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t("contributeTLsPage.chatLogFlow.submitContribution", {
                count:
                  submittableCount > 0
                    ? t("contributeTLsPage.chatLogFlow.submitCount", {
                        count: submittableCount,
                      })
                    : "",
              })}
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
          title={t("contributeTLsPage.chatLogFlow.confirmTitle")}
          description={
            <span className="block space-y-1">
              <span className="block">
                {t("contributeTLsPage.chatLogFlow.confirmIntro", {
                  count: submittableCount,
                  suffix: submittableCount === 1 ? "" : "s",
                })}
              </span>
              <span className="block pl-3 text-xs">
                • {t("contributeTLsPage.chatLogFlow.confirmed", { count: counts.confirmed })}
                <br />•{" "}
                {t("contributeTLsPage.chatLogFlow.needsReview", {
                  count: counts.unconfirmed,
                })}
              </span>
              {(counts.unpaired > 0 || counts.invalid > 0 || counts.existing > 0) && (
                <span className="block pt-1">
                  {t("contributeTLsPage.chatLogFlow.skippedTitle")}
                  <span className="block pl-3 text-xs">
                    {counts.unpaired > 0 && (
                      <>
                        •{" "}
                        {t("contributeTLsPage.chatLogFlow.unpaired", {
                          count: counts.unpaired,
                        })}
                        <br />
                      </>
                    )}
                    {counts.invalid > 0 && (
                      <>
                        • {t("contributeTLsPage.chatLogFlow.invalid", { count: counts.invalid })}
                        <br />
                      </>
                    )}
                    {counts.existing > 0 && (
                      <>
                        • {t("contributeTLsPage.chatLogFlow.existing", { count: counts.existing })}
                      </>
                    )}
                  </span>
                </span>
              )}
              {counts.unconfirmed > 0 && (
                <span className="block pt-2 text-xs text-amber-700">
                  {counts.unconfirmed === 1
                    ? t("contributeTLsPage.chatLogFlow.noteOne", {
                        count: counts.unconfirmed,
                      })
                    : t("contributeTLsPage.chatLogFlow.noteMany", {
                        count: counts.unconfirmed,
                      })}
                </span>
              )}
            </span>
          }
          confirmLabel={t("contributeTLsPage.chatLogFlow.confirm")}
          loading={submitting}
          onConfirm={handleSubmit}
          onCancel={() => setConfirmOpen(false)}
        />
      </div>
    </div>
  );
}
