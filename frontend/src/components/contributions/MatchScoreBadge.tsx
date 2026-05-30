import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { HelpTip } from "../ui/help-tip";
import type { MatchScore } from "@/models/contributions";

export function MatchScoreBadge({
  score,
  canRecompute,
  onRecompute,
  recomputing,
  heavyComputeEnabled,
}: {
  score: MatchScore;
  canRecompute: boolean;
  onRecompute: () => void;
  recomputing: boolean;
  heavyComputeEnabled: boolean;
}) {
  const { t } = useTranslation();
  if (score.status === "pending") {
    if (!heavyComputeEnabled) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t("contributePage.matchScore.awaitingAdminCompute")}</span>
          <HelpTip text={t("contributePage.matchScore.awaitingAdminComputeHelp")} />
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{t("contributePage.matchScore.computing")}</span>
      </div>
    );
  }

  if (score.status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-muted-foreground">
          {t("contributePage.matchScore.unknown")}
        </Badge>
        {canRecompute && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={onRecompute}
            disabled={recomputing}
            title={score.reason || t("contributePage.matchScore.retryTitle")}
          >
            {recomputing ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            {t("contributePage.matchScore.recompute")}
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
  const sampled = score.sampled === true;
  const sampleSize = score.sample_size ?? 0;

  // Plan thresholds: ≥80% green ("looks like our map"), <20% orange
  // ("may be wrong file"), in between grey/neutral.
  let badgeClass: string;
  let label: string;
  if (pixel >= 80) {
    badgeClass = "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30";
    label = t("contributePage.matchScore.looksLikeOurMap");
  } else if (pixel < 20) {
    badgeClass = "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30";
    label = t("contributePage.matchScore.mayBeWrongFile");
  } else {
    badgeClass = "bg-muted text-muted-foreground border-border";
    label = t("contributePage.matchScore.partialMatch");
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Badge variant="outline" className={badgeClass}>
        {label}
      </Badge>
      <span
        className="text-muted-foreground"
        title={
          sampled
            ? `Pixel similarity estimated from a random sample of ${sampleSize.toLocaleString()} of ${overlapCount.toLocaleString()} overlapping tiles.`
            : undefined
        }
      >
        {t("contributePage.matchScore.overlapSummary", {
          overlap: overlap.toFixed(0),
          overlapCount: overlapCount.toLocaleString(),
          total: total.toLocaleString(),
          pixel: pixel.toFixed(0),
        })}
        {sampled ? " (sampled)" : null}
      </span>
      {canRecompute && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={onRecompute}
          disabled={recomputing}
          title={t("contributePage.matchScore.recomputeTitle")}
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
