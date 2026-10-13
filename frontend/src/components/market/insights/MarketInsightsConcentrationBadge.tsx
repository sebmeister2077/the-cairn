import type { InsightsRow } from "@/models/auction";
import { Badge } from "@/components/ui/badge";
import { MarketInsightsHint } from "./Hint";
import { DASH } from "./Dash";

export function MarketInsightsConcentrationBadge({ row }: { row: InsightsRow }) {
  if (!row.concentrationTier || row.hhi == null) return DASH;
  const tier = row.concentrationTier;
  const cls =
    tier === "competitive"
      ? "bg-emerald-600 hover:bg-emerald-600 text-white"
      : tier === "moderate"
        ? "bg-amber-500 hover:bg-amber-500 text-white"
        : "bg-red-600 hover:bg-red-600 text-white";
  const label =
    tier === "competitive"
      ? "Competitive"
      : tier === "moderate"
        ? "Moderate"
        : tier === "concentrated"
          ? "Concentrated"
          : "Monopoly";
  return (
    <MarketInsightsHint label={`HHI ${(row.hhi * 100).toFixed(0)}% · ${row.sellerCount} seller(s)`}>
      <Badge className={cls}>{label}</Badge>
    </MarketInsightsHint>
  );
}
