import type { InsightsRow } from "@/models/auction";
import { cn } from "@/lib/helpers/utils";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "../Sparkline";
import { DASH } from "./Dash";

export function MarketInsightsTrendCell({ row }: { row: InsightsRow }) {
  const { trend, priceSeries } = row;
  const spark =
    priceSeries && priceSeries.length >= 2 ? (
      <Sparkline
        data={priceSeries}
        className={cn(
          "shrink-0",
          trend?.direction === "up"
            ? "text-emerald-600"
            : trend?.direction === "down"
              ? "text-red-600"
              : "text-muted-foreground/70",
        )}
      />
    ) : null;

  let label: ReactNode;
  if (!trend) {
    label = spark ? null : DASH;
  } else if (trend.direction === "flat") {
    label = (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus className="size-3" /> Flat
      </span>
    );
  } else {
    const up = trend.direction === "up";
    label = (
      <span
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          up ? "text-emerald-600" : "text-red-600",
        )}
      >
        {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
        {up ? "+" : ""}
        {trend.changePct}%
      </span>
    );
  }

  if (!spark && !trend) return DASH;
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {spark}
      {label}
    </span>
  );
}
