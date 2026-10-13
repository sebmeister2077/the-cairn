import type { InsightsRow } from "@/models/auction";
import { Badge } from "@/components/ui/badge";
import { MarketInsightsHint } from "./Hint";
import { DASH } from "./Dash";
import { cn } from "@/lib/utils";
import { Flame, TriangleAlert } from "lucide-react";

export function MarketInsightsDemandCell({ row }: { row: InsightsRow }) {
  if (row.demandScore == null || !row.demandTier) return DASH;
  const tier = row.demandTier;
  const cls =
    tier === "hot"
      ? "bg-red-600 hover:bg-red-600 text-white"
      : tier === "high"
        ? "bg-orange-500 hover:bg-orange-500 text-white"
        : tier === "normal"
          ? "bg-secondary text-secondary-foreground"
          : "border-border text-muted-foreground";
  const label =
    tier === "hot" ? "Hot" : tier === "high" ? "High" : tier === "normal" ? "Normal" : "Low";
  return (
    <span className="inline-flex items-center gap-1">
      <MarketInsightsHint
        label={`Demand score ${row.demandScore}/100 (volume + speed + sell-through)`}
      >
        <Badge
          variant={tier === "low" ? "outline" : "default"}
          className={cn("w-18 justify-center", cls)}
        >
          {tier === "hot" ? <Flame className="size-3" /> : null}
          {label}
        </Badge>
      </MarketInsightsHint>
      <span className="inline-flex w-3.5 justify-center">
        {row.shortage ? (
          <MarketInsightsHint label="Shortage — strong demand with little stock left">
            <TriangleAlert className="size-3.5 text-amber-500" aria-label="Shortage" />
          </MarketInsightsHint>
        ) : null}
      </span>
    </span>
  );
}
