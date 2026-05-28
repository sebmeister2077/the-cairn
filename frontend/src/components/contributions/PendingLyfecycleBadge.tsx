import type { PendingContribution } from "@/models/contributions";
import { HelpTip } from "@/components/ui/help-tip";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { Badge } from "../ui/badge";

// ---------------------------------------------------------------------------
// Phase 1 — Match-score badge (informational only, never blocks approval)
// ---------------------------------------------------------------------------

export function PendingLifecycleBadge({
  contribution,
  heavyComputeEnabled,
}: {
  contribution: PendingContribution;
  heavyComputeEnabled: boolean;
}) {
  const { t } = useTranslation();
  // Async upload validation. The row exists in the DB but the worker
  // hasn't opened the .db file yet — Approve will be greyed out upstream.
  // When the heavy-compute kill switch is OFF no worker will spawn, so
  // show a deferred state instead of a never-ending spinner.
  if (contribution.validation_status === "pending") {
    if (!heavyComputeEnabled) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t("contributePage.lifecycle.awaitingAdminCompute")}</span>
          <HelpTip text={t("contributePage.lifecycle.awaitingAdminComputeHelp")} />
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{t("contributePage.lifecycle.validatingUpload")}</span>
      </div>
    );
  }

  // Async approval lifecycle. ``queued`` = admin pressed Approve, the
  // worker hasn't picked it up. ``running`` = merge in progress. ``failed``
  // = worker hit a non-retryable error or burned all attempts; the row is
  // still pending and Approve becomes available again.
  const approval = contribution.approval_status;
  if (approval === "queued") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge
          variant="outline"
          className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30"
        >
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          {t("contributePage.lifecycle.queuedForMerge")}
        </Badge>
        <span className="text-muted-foreground">
          {t("contributePage.lifecycle.workerWillPickThisUp")}
        </span>
      </div>
    );
  }
  if (approval === "running") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge
          variant="outline"
          className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30"
        >
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          {t("contributePage.lifecycle.mergingIntoMap")}
        </Badge>
      </div>
    );
  }
  if (approval === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge
          variant="outline"
          className="bg-destructive/15 text-destructive border-destructive/30"
        >
          {t("contributePage.lifecycle.mergeFailed")}
        </Badge>
        {contribution.approval_error && (
          <span
            className="text-muted-foreground truncate max-w-md"
            title={contribution.approval_error}
          >
            {contribution.approval_error}
          </span>
        )}
      </div>
    );
  }

  return null;
}
