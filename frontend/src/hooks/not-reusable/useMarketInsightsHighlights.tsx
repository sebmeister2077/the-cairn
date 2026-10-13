import type { InsightsRow } from "@/models/auction";
import { useMemo } from "react";
import { volumeValue, volumeDisplay, type InsightsVolumeMode } from "@/hooks/useFilteredInsights";
import type { MarketInsightsHighlight } from "@/components/market/insights/MarketInsightsHighlightCard";

const HIGHLIGHT_MAX = 25;

export function useMarketInsightsHighlights(rows: InsightsRow[], volumeMode: InsightsVolumeMode) {
  return useMemo<MarketInsightsHighlight[]>(() => {
    if (!rows.length) return [];
    const withConfidence = rows.filter((r) => r.confidence !== "low");
    const byVolatility = (dir: 1 | -1) =>
      [...withConfidence]
        .filter((r) => r.dispersionCV != null)
        .sort((a, b) => (a.dispersionCV! - b.dispersionCV!) * dir)
        .slice(0, HIGHLIGHT_MAX);
    const top = <K,>(pool: InsightsRow[], val: (r: InsightsRow) => K | null, dir: 1 | -1) =>
      [...pool]
        .filter((r) => val(r) != null)
        .sort((a, b) => ((val(a) as number) - (val(b) as number)) * dir)
        .slice(0, HIGHLIGHT_MAX);
    return [
      {
        title: "Most volatile",
        hint: "Widest price spread among sellers",
        rows: byVolatility(-1),
        value: (r) => `${((r.dispersionCV ?? 0) * 100).toFixed(0)}%`,
      },
      {
        title: "Most stable",
        hint: "Tightest, most reliable pricing",
        rows: byVolatility(1),
        value: (r) => `${((r.dispersionCV ?? 0) * 100).toFixed(0)}%`,
      },
      {
        title: "Highest volume",
        hint: volumeMode === "price" ? "Most gears traded" : "Most units sold",
        rows: top(rows, (r) => volumeValue(r, volumeMode), -1),
        value: (r) => volumeDisplay(r, volumeMode),
      },
      {
        title: "Biggest shortages",
        hint: "Sell fast with little stock left",
        rows: rows
          .filter((r) => r.shortage)
          .sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `${r.activeListings} on board`,
      },
      {
        title: "Best deals",
        hint: "Cheap listings undercut the median most",
        rows: top(withConfidence, (r) => r.dealScore, -1),
        value: (r) => `${((r.dealScore ?? 0) * 100).toFixed(0)}% under`,
      },
      {
        title: "Most liquid",
        hint: "Easiest and fastest to sell",
        rows: top(rows, (r) => r.liquidityScore, -1),
        value: (r) => `${r.liquidityScore}/100`,
      },
      {
        title: "Trending up",
        hint: "Rising per-unit prices",
        rows: rows
          .filter((r) => r.trend?.direction === "up")
          .sort((a, b) => (b.trend?.changePct ?? 0) - (a.trend?.changePct ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `+${r.trend?.changePct ?? 0}%`,
      },
      {
        title: "Trending down",
        hint: "Falling per-unit prices",
        rows: rows
          .filter((r) => r.trend?.direction === "down")
          .sort((a, b) => (a.trend?.changePct ?? 0) - (b.trend?.changePct ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `${r.trend?.changePct ?? 0}%`,
      },
    ];
  }, [rows, volumeMode]);
}
