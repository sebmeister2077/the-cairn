import type { InsightsRow } from "@/models/auction";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/helpers/utils";
import { MarketInsightsHint } from "./Hint";

export function MarketInsightsConfidenceBadge({ row }: { row: InsightsRow }) {
  const label = row.confidence === "high" ? "High" : row.confidence === "medium" ? "Medium" : "Low";
  const variant =
    row.confidence === "high" ? "outline" : row.confidence === "medium" ? "secondary" : "outline";
  return (
    <MarketInsightsHint label={`${row.soldCount} sold — statistical confidence`}>
      <Badge
        variant={variant}
        className={cn(row.confidence === "low" && "border-dashed text-muted-foreground")}
      >
        {label}
      </Badge>
    </MarketInsightsHint>
  );
}
