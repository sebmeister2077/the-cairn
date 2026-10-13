// Market Insights — a screener surfacing every derived indicator (volatility,
// volume, demand/popularity, liquidity, deals, seller concentration, delivery
// premium, recency, confidence) per item, over a selectable time window. All
// metrics are computed client-side from the already-loaded listings (see
// `useMarketInsights`). Listing dates are shown in the in-game calendar; time to
// sell is shown in real-world time.

import { Badge } from "@/components/ui/badge";
import { MarketInsightsHint } from "@/components/market/insights/Hint";
import type { InsightsRow } from "@/models/auction";
import { DASH } from "./Dash";

export function MarketInsightsVolatilityBadge({ row }: { row: InsightsRow }) {
  if (!row.volatilityTier || row.dispersionCV == null) return DASH;
  const cls =
    row.volatilityTier === "stable"
      ? "bg-emerald-600 hover:bg-emerald-600 text-white"
      : row.volatilityTier === "moderate"
        ? "bg-amber-500 hover:bg-amber-500 text-white"
        : "bg-red-600 hover:bg-red-600 text-white";
  const label =
    row.volatilityTier === "stable"
      ? "Stable"
      : row.volatilityTier === "moderate"
        ? "Moderate"
        : "Volatile";
  return (
    <MarketInsightsHint label={`Dispersion CV ${(row.dispersionCV * 100).toFixed(0)}%`}>
      <Badge className={cls}>{label}</Badge>
    </MarketInsightsHint>
  );
}
