import { DASH } from "@/components/market/insights/Dash";
import { MarketInsightsFavoriteStar } from "@/components/market/insights/FavoriteStar";
import { MarketInsightsHint } from "@/components/market/insights/Hint";
import { MarketInsightsConcentrationBadge } from "@/components/market/insights/MarketInsightsConcentrationBadge";
import { MarketInsightsConfidenceBadge } from "@/components/market/insights/MarketInsightsConfidenceBadge";
import { MarketInsightsDemandCell } from "@/components/market/insights/MarketInsightsDemandCell";
import { MarketInsightsTrendCell } from "@/components/market/insights/MarketInsightsTrendCell";
import { MarketInsightsRecencyCell } from "@/components/market/insights/RecencyCell";
import { MarketInsightsVolatilityBadge } from "@/components/market/insights/VolatilityBadge";
import type { ScreenerColumn } from "@/components/market/InsightsScreenerTable";
import { formatGears, formatRealTimeToSell } from "@/lib/market/auction";
import { RARITY_COLORS, RARITY_LABELS, RARITY_RANK } from "@/lib/market/item-sources";
import type { InsightsRow } from "@/models/auction";
import { useMemo } from "react";
import { rowPrice, volumeDisplay, volumeValue } from "../useFilteredInsights";
import type { MarketPriceMode } from "../useMarketPriceMode";
import type { Rarity } from "@/models/loot-pools";
import type { InsightsVolumeMode } from "@/hooks/useFilteredInsights";

export function useMarketInsightsColumns(deps: {
  volumeMode: InsightsVolumeMode;
  priceMode: MarketPriceMode;
  rarityById: Map<number, Rarity | null>;
}) {
  const { volumeMode, priceMode, rarityById } = deps;
  return useMemo<ScreenerColumn<InsightsRow>[]>(
    () => [
      {
        key: "name",
        header: "Item",
        width: "minmax(11rem,1.6fr)",
        cell: (r) => (
          <span className="flex items-center gap-1.5 font-medium">
            <MarketInsightsFavoriteStar itemId={r.itemId} />
            <span className="truncate">{r.name}</span>
          </span>
        ),
        sortValue: (r) => r.name.toLowerCase(),
      },
      {
        key: "rarity",
        header: "Rarity",
        width: "minmax(6rem,0.8fr)",
        cell: (r) => {
          const rarity = rarityById.get(r.itemId) ?? null;
          if (!rarity) return <span className="text-muted-foreground">{DASH}</span>;
          return (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                color: RARITY_COLORS[rarity],
                backgroundColor: `${RARITY_COLORS[rarity]}1a`,
              }}
            >
              {RARITY_LABELS[rarity]}
            </span>
          );
        },
        sortValue: (r) => {
          const rarity = rarityById.get(r.itemId) ?? null;
          return rarity ? RARITY_RANK[rarity] : null;
        },
        title: "Loot-table rarity (rarest first)",
      },
      {
        key: "volume",
        header: volumeMode === "price" ? "Volume (gears)" : "Volume (units)",
        width: "minmax(7rem,1fr)",
        align: "right",
        cell: (r) => volumeDisplay(r, volumeMode),
        sortValue: (r) => volumeValue(r, volumeMode),
        title: "Total traded in the window",
      },
      {
        key: "median",
        header: priceMode === "weighted" ? "Weighted/unit" : "Median/unit",
        width: "minmax(6.5rem,1fr)",
        align: "right",
        cell: (r) => {
          const p = rowPrice(r, priceMode);
          if (p == null) return DASH;
          if (!r.upperBoundUnknown) return formatGears(p);
          return (
            <MarketInsightsHint label="Upper price bound unknown — nothing ever sold or expired above this, so treat it as a floor, not a ceiling.">
              <span className="inline-flex items-center gap-0.5">
                <span className="text-muted-foreground">≥</span>
                {formatGears(p)}
              </span>
            </MarketInsightsHint>
          );
        },
        sortValue: (r) => rowPrice(r, priceMode),
        title:
          priceMode === "weighted"
            ? "Quantity-weighted median per-unit sold price (bulk trades dominate)"
            : "Median per-unit sold price (fair price)",
      },
      {
        key: "volatility",
        header: "Volatility",
        width: "minmax(6rem,0.9fr)",
        align: "right",
        cell: (r) => <MarketInsightsVolatilityBadge row={r} />,
        sortValue: (r) => r.dispersionCV,
        title: "Price dispersion: (p75 − p25) / median",
      },
      {
        key: "trend",
        header: "Trend",
        width: "minmax(8rem,1.1fr)",
        align: "right",
        cell: (r) => <MarketInsightsTrendCell row={r} />,
        sortValue: (r) => r.trend?.changePct ?? null,
        title: "Recent vs older per-unit price, with an in-window price sparkline",
      },
      {
        key: "sellThrough",
        header: "Sell-through",
        width: "minmax(6rem,0.9fr)",
        align: "right",
        cell: (r) => (r.sellThrough != null ? `${(r.sellThrough * 100).toFixed(0)}%` : DASH),
        sortValue: (r) => r.sellThrough,
        title: "Sold / (sold + expired)",
      },
      {
        key: "timeToSell",
        header: "Time to sell",
        width: "minmax(6.5rem,1fr)",
        align: "right",
        cell: (r) =>
          r.medianTimeToSellHours != null ? formatRealTimeToSell(r.medianTimeToSellHours) : DASH,
        sortValue: (r) => r.medianTimeToSellHours,
        title: "Median real-world time from posting to sale",
      },
      {
        key: "demand",
        header: "Demand",
        width: "minmax(6.5rem,0.9fr)",
        align: "right",
        cell: (r) => <MarketInsightsDemandCell row={r} />,
        sortValue: (r) => r.demandScore,
        title: "Popularity: volume + speed + sell-through. ⚠ = shortage",
      },
      {
        key: "liquidity",
        header: "Liquidity",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) => (r.liquidityScore != null ? `${r.liquidityScore}/100` : DASH),
        sortValue: (r) => r.liquidityScore,
        title: "How easily & quickly it sells",
      },
      {
        key: "deal",
        header: "Deal",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) =>
          r.dealScore != null ? (
            <span>
              {(r.dealScore * 100).toFixed(0)}%
              {r.dealsAvailable > 0 ? (
                <MarketInsightsHint label="Active listings below fair price">
                  <span className="ml-1 text-emerald-600">·{r.dealsAvailable}</span>
                </MarketInsightsHint>
              ) : null}
            </span>
          ) : (
            DASH
          ),
        sortValue: (r) => r.dealScore,
        title: "How far cheap listings undercut the median (+ live deals)",
      },
      {
        key: "concentration",
        header: "Sellers",
        width: "minmax(6.5rem,0.9fr)",
        align: "right",
        cell: (r) => <MarketInsightsConcentrationBadge row={r} />,
        sortValue: (r) => r.hhi,
        title: "Seller concentration (HHI)",
      },
      {
        key: "delivery",
        header: "Delivery +",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) =>
          r.deliveryPremiumPct != null
            ? `${r.deliveryPremiumPct > 0 ? "+" : ""}${r.deliveryPremiumPct}%`
            : DASH,
        sortValue: (r) => r.deliveryPremiumPct,
        title: "Delivered vs non-delivered price premium",
      },
      {
        key: "confidence",
        header: "Confidence",
        width: "minmax(6rem,0.8fr)",
        align: "right",
        cell: (r) => <MarketInsightsConfidenceBadge row={r} />,
        sortValue: (r) => r.soldCount,
        title: "Sample size behind the stats",
      },
      {
        key: "lastSale",
        header: "Last sale",
        width: "minmax(7rem,1fr)",
        align: "right",
        cell: (r) => <MarketInsightsRecencyCell row={r} />,
        sortValue: (r) => (r.daysSinceLastSale != null ? -r.daysSinceLastSale : null),
        title: "In-game date of the most recent sale",
      },
    ],
    [volumeMode, priceMode, rarityById],
  );
}
