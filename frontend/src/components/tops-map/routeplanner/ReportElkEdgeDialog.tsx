/**
 * ReportElkEdgeDialog
 *
 * Lets a logged-in user flag a confirmed elk-walkable edge as wrong.
 * The submission lands in the admin reports queue and is moderated
 * from `AdminElkWalkablePage`. The backend already enforces a 5/h +
 * 100/day rate limit and a per-(reporter, edge) "one open report"
 * dedupe — we mostly just translate the error codes here.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { submitElkWalkableReport, type ElkWalkableReportReason } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface ReportElkEdgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Canonical `"tl_id:ep|tl_id:ep"` key from `walkLegEdgeRef(...).key`. */
  edgeKey: string | null;
  /** Optional friendly description of the edge, shown above the form. */
  edgeLabel?: string;
}

/** Outer wrapper: the inner form remounts each time the dialog opens so
 *  Reason/Details reset to defaults without a setState-in-effect. */
export function ReportElkEdgeDialog(props: ReportElkEdgeDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(v) => !v && props.onOpenChange(false)}>
      {props.open && (
        <ReportElkEdgeDialogContent
          edgeKey={props.edgeKey}
          edgeLabel={props.edgeLabel}
          onClose={() => props.onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

const REASONS: ElkWalkableReportReason[] = [
  "not_walkable",
  "dangerous_terrain",
  "incorrect_endpoints",
  "other",
];

const DETAILS_MAX = 500;

function ReportElkEdgeDialogContent({
  edgeKey,
  edgeLabel,
  onClose,
}: {
  edgeKey: string | null;
  edgeLabel?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ElkWalkableReportReason | "">("");
  const [details, setDetails] = useState("");

  const submitMut = useMutation({
    mutationFn: async () => {
      if (!edgeKey || !reason) throw new Error("invalid input");
      return submitElkWalkableReport(edgeKey, {
        reason,
        details: details.trim() || undefined,
      });
    },
    onSuccess: () => {
      onClose();
    },
  });

  const errMsg = errorMessage(submitMut.error, t);
  const canSubmit = !!edgeKey && !!reason && !submitMut.isPending;

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber-600" />
          {t("topsMap.reportElkEdge.title")}
        </DialogTitle>
        <DialogDescription>{t("topsMap.reportElkEdge.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        {edgeLabel && (
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">{t("topsMap.reportElkEdge.edgeLabel")}: </span>
            <span className="font-mono break-all">{edgeLabel}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="report-reason" className="text-xs font-medium">
            {t("topsMap.reportElkEdge.reasonLabel")}
          </Label>
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as ElkWalkableReportReason)}
            disabled={submitMut.isPending}
          >
            <SelectTrigger id="report-reason" className="h-9">
              <SelectValue placeholder={t("topsMap.reportElkEdge.reasonPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`topsMap.reportElkEdge.reasons.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-details" className="text-xs font-medium">
            {t("topsMap.reportElkEdge.detailsLabel")}
          </Label>
          <textarea
            id="report-details"
            value={details}
            onChange={(e) => setDetails(e.target.value.slice(0, DETAILS_MAX))}
            maxLength={DETAILS_MAX}
            rows={4}
            placeholder={t("topsMap.reportElkEdge.detailsPlaceholder")}
            disabled={submitMut.isPending}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="text-right text-[10px] text-muted-foreground">
            {t("topsMap.reportElkEdge.detailsCount", { count: details.length })}
          </div>
        </div>

        {errMsg && (
          <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {errMsg}
          </p>
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={submitMut.isPending}>
          {t("topsMap.reportElkEdge.cancel")}
        </Button>
        <Button type="button" onClick={() => submitMut.mutate()} disabled={!canSubmit}>
          {submitMut.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t("topsMap.reportElkEdge.submitting")}
            </>
          ) : (
            t("topsMap.reportElkEdge.submit")
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function errorMessage(err: unknown, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (!err) return null;
  const raw = err instanceof Error ? err.message : String(err);

  // The fetch wrapper bubbles up backend detail bodies. Try to pick
  // out our coded errors so we can show a translated message.
  if (raw.includes("duplicate_open_report")) {
    return t("topsMap.reportElkEdge.alreadyReported");
  }
  if (raw.includes("feature_disabled")) {
    return t("topsMap.reportElkEdge.featureDisabled");
  }
  return t("topsMap.reportElkEdge.error", { message: raw });
}
