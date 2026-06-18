import { Award } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/lib/i18n";

interface ReputationBadgeProps {
  score: number;
  /** Extra stats for the hover title; optional so browse cards can show just the score. */
  published?: number;
  upvotes?: number;
  installs?: number;
  className?: string;
}

/**
 * Small reputation chip shown next to an author's name. Reputation reflects an
 * author's published groupings, the upvotes and installs they've earned, and
 * any official badges — see the backend `recompute_reputation`.
 */
export function ReputationBadge({
  score,
  published,
  upvotes,
  installs,
  className,
}: ReputationBadgeProps) {
  const { t } = useTranslation();
  const hasStats = published != null || upvotes != null || installs != null;
  const title = hasStats
    ? t("topsMap.groupingsDrawer.library.reputationTooltip", {
        score,
        published: published ?? 0,
        upvotes: upvotes ?? 0,
        installs: installs ?? 0,
      })
    : t("topsMap.groupingsDrawer.library.reputation");
  return (
    <Badge variant="secondary" className={className} title={title}>
      <Award className="size-3" aria-hidden />
      {score}
    </Badge>
  );
}
