import { MarketInsightsHint } from "@/components/market/insights/Hint";
import { DASH } from "./Dash";
import type { InsightsRow } from "@/models/auction";
import { cn } from "@/lib/helpers/utils";
import { formatGameDate } from "@/lib/formatting/format-duration";

export function MarketInsightsRecencyCell({ row }: { row: InsightsRow }) {
  if (row.lastSaleGameHours == null) return DASH;
  const tier = row.recencyTier;
  const dot =
    tier === "active"
      ? "bg-emerald-500"
      : tier === "cooling"
        ? "bg-amber-500"
        : "bg-muted-foreground";
  const dotLabel = tier === "active" ? "Active" : tier === "cooling" ? "Cooling off" : "Stale";
  const content = (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", dot)} role="img" aria-label={dotLabel} />
      {formatGameDate(row.lastSaleGameHours)}
    </span>
  );
  return row.daysSinceLastSale != null ? (
    <MarketInsightsHint label={`Last sale ~${row.daysSinceLastSale.toFixed(1)} real days ago`}>
      {content}
    </MarketInsightsHint>
  ) : (
    content
  );
}
