import { Loader2, RefreshCw } from "lucide-react";
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
  if (score.status === "pending") {
    if (!heavyComputeEnabled) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Match score awaiting admin compute</span>
          <HelpTip text="Heavy background work is paused on the server. The match score (how much of this upload overlaps the existing map) will be computed once an admin re-enables heavy compute or drains the queue manually." />
        </div>
      );
    }
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
