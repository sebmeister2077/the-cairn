// Market Insights — a screener surfacing every derived indicator (volatility,
// volume, demand/popularity, liquidity, deals, seller concentration, delivery
// premium, recency, confidence) per item, over a selectable time window. All
// metrics are computed client-side from the already-loaded listings (see
// `useMarketInsights`). Listing dates are shown in the in-game calendar; time to
// sell is shown in real-world time.

import { InsightsFilterBar } from "@/components/market/InsightsFilterBar";
import { customCategoriesFrom } from "@/lib/market/item-categories";
import { MarketEconomyPieChart } from "@/components/market/MarketEconomyPieChart";
import { ScreenerTable } from "@/components/market/InsightsScreenerTable";
import { PriceModeInfo } from "@/components/market/PriceModeInfo";
import { SmartWindowNote } from "@/components/market/SmartWindowNote";
import { MarketInsightsColumnGlossary } from "@/components/market/insights/ColumnGlossary";
import { MarketInsightsColumnPicker } from "@/components/market/insights/MarketInsightsColumnPicker";
import { MarketInsightsHighlightCard } from "@/components/market/insights/MarketInsightsHighlightCard";
import { MarketInsightsSkeleton } from "@/components/market/insights/MarketInsightsSkeleton";
import { downloadInsightsCsv } from "@/components/market/insightsCsv";
import { MaintenanceChip } from "@/components/other/MaintenanceChip";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/usage/StatCard";
import { useMarketInsightsColumns } from "@/hooks/not-reusable/useMarketInsightsColumns";
import { useMarketInsightsHighlights } from "@/hooks/not-reusable/useMarketInsightsHighlights";
import { useFilteredInsights } from "@/hooks/useFilteredInsights";
import { useInsightsHiddenColumns } from "@/hooks/useInsightsColumns";
import { INSIGHTS_WINDOWS, resolveWindowDays, useMarketInsights } from "@/hooks/useMarketInsights";
import { useMarketPriceMode } from "@/hooks/useMarketPriceMode";
import { useMarketVolumeMode } from "@/hooks/useMarketVolumeMode";
import { useMarketWindow } from "@/hooks/useMarketWindow";
import {
  formatGears,
  formatRealTimeToSell,
  useAuctionListings,
  useAuctionSummary,
  useItemCatalog,
} from "@/lib/market/auction";
import { marketRarity } from "@/lib/market/item-sources";
import type { Rarity } from "@/models/item-sources";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { patchInsightsFilters } from "@/store/slices/insightsFilters";
import { Download } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

export function MarketInsightsPage() {
  const { data: listings, isPending, isError } = useAuctionListings();
  const { data: summary } = useAuctionSummary();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.insightsFilters);
  const favoriteIds = useAppSelector((s) => s.marketFavorites.ids);
  const favorites = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const [windowKey, setWindowKey] = useMarketWindow();
  const [volumeMode, setVolumeMode] = useMarketVolumeMode();
  const [priceMode, setPriceMode] = useMarketPriceMode();
  const hiddenColumns = useInsightsHiddenColumns();
  const catalogQ = useItemCatalog();

  // itemId -> loot rarity (resolved from the catalogue's item code), for the
  // optional Rarity column.
  const rarityById = useMemo(() => {
    const map = new Map<number, Rarity | null>();
    for (const [idStr, entry] of Object.entries(catalogQ.data ?? {})) {
      map.set(Number(idStr), marketRarity(entry.code));
    }
    return map;
  }, [catalogQ.data]);

  const windowDays = useMemo(
    () => resolveWindowDays(windowKey, summary?.recordingStartGameHours),
    [windowKey, summary?.recordingStartGameHours],
  );
  const excludeExternalTrades = useAppSelector((s) => s.auctionFilters.excludeExternalTrades);
  const insights = useMarketInsights(
    listings,
    windowDays,
    excludeExternalTrades,
    windowKey === "smart",
  );

  // Screener rows: items with at least one sale in the window carry meaningful
  // stats; drop the rest so the table isn't padded with empty indicators.
  const rows = useMemo(
    () => (insights ? insights.rows.filter((r) => r.soldCount > 0) : []),
    [insights],
  );

  // Categories present in the (window-scoped) screener rows, for the filter bar.
  const categories = useMemo(() => Array.from(new Set(rows.map((r) => r.category))).sort(), [rows]);
  const customCategories = useMemo(() => customCategoriesFrom(rows.map((r) => r.category)), [rows]);

  // Filters apply to the screener table only — highlight cards and window totals
  // below intentionally use the full `rows`/`insights` so they stay market-wide.
  const filteredRows = useFilteredInsights(rows, filters, volumeMode, priceMode, favorites);

  const highlights = useMarketInsightsHighlights(rows, volumeMode);

  const columns = useMarketInsightsColumns({
    volumeMode,
    priceMode,
    rarityById,
  });

  // The "Item" column is always shown; the rest respect the persisted picker.
  const visibleColumns = useMemo(
    () => columns.filter((c) => c.key === "name" || !hiddenColumns.includes(c.key)),
    [columns, hiddenColumns],
  );

  if (isPending) {
    return <MarketInsightsSkeleton />;
  }
  if (isError || !listings || !insights) {
    return <p className="py-12 text-center text-destructive">Failed to load market data.</p>;
  }

  const t = insights.totals;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">Market Insights</h1>
          <MaintenanceChip component="auction_insights" />
        </div>
        <p className="text-xs text-muted-foreground">
          Derived indicators per item. Listing dates use the in-game calendar; time to sell is
          real-world. Windows are real days of play (1 real day ≈ 1 in-game month).
          {summary ? (
            <> Snapshot updated {new Date(summary.generatedUtc).toLocaleString()}.</>
          ) : null}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {INSIGHTS_WINDOWS.map((w) => (
            <Button
              key={w.key}
              size="sm"
              variant={windowKey === w.key ? "default" : "outline"}
              aria-pressed={windowKey === w.key}
              title={w.hint}
              onClick={() => setWindowKey(w.key)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Volume unit">
          <span className="mr-1 text-sm text-muted-foreground">Volume:</span>
          <Button
            size="sm"
            variant={volumeMode === "price" ? "default" : "outline"}
            aria-pressed={volumeMode === "price"}
            onClick={() => setVolumeMode("price")}
          >
            Gears
          </Button>
          <Button
            size="sm"
            variant={volumeMode === "unit" ? "default" : "outline"}
            aria-pressed={volumeMode === "unit"}
            onClick={() => setVolumeMode("unit")}
          >
            Units
          </Button>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Price basis">
          <span className="mr-1 text-sm text-muted-foreground">Price:</span>
          <Button
            size="sm"
            variant={priceMode === "median" ? "default" : "outline"}
            aria-pressed={priceMode === "median"}
            onClick={() => setPriceMode("median")}
          >
            Median
          </Button>
          <Button
            size="sm"
            variant={priceMode === "weighted" ? "default" : "outline"}
            aria-pressed={priceMode === "weighted"}
            onClick={() => setPriceMode("weighted")}
          >
            Qty-weighted
          </Button>
          <PriceModeInfo />
        </div>
      </div>

      <SmartWindowNote windowKey={windowKey} />

      {/* Window totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Gears traded" value={formatGears(t.gearsTraded)} />
        <StatCard label="Units sold" value={t.unitsSold} />
        <StatCard label="Sales" value={t.soldCount} />
        <StatCard
          label="Sell-through"
          value={t.sellThrough != null ? `${(t.sellThrough * 100).toFixed(0)}%` : "—"}
        />
        <StatCard label="Items traded" value={t.uniqueItemsTraded} />
        <StatCard
          label="Median time to sell"
          value={
            t.medianTimeToSellHours != null ? formatRealTimeToSell(t.medianTimeToSellHours) : "—"
          }
        />
        <StatCard label="Delivery fees paid" value={formatGears(t.deliveryFeesPaid)} />
        <StatCard
          label="Delivered sales"
          value={
            t.deliveryRate != null
              ? `${t.deliveredCount.toLocaleString()} · ${(t.deliveryRate * 100).toFixed(0)}%`
              : "—"
          }
        />
      </div>

      {/* Economy composition */}
      <MarketEconomyPieChart
        listings={listings}
        recordingStartGameHours={summary?.recordingStartGameHours}
      />

      {/* Highlights */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {highlights.map((h) => (
          <MarketInsightsHighlightCard
            key={h.title}
            highlight={h}
            onSelect={(itemId) => navigate(`/market/items/${itemId}`)}
          />
        ))}
      </div>

      {/* Screener */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold">Item screener</h2>
            <span className="text-xs text-muted-foreground">
              {filteredRows.length.toLocaleString()}
              {filteredRows.length !== rows.length
                ? ` of ${rows.length.toLocaleString()}`
                : ""}{" "}
              items · click a row for details · click a header to sort
            </span>
          </div>
          <div className="flex items-center gap-2">
            <MarketInsightsColumnPicker hidden={hiddenColumns} />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={filteredRows.length === 0}
              onClick={() =>
                downloadInsightsCsv(
                  filteredRows,
                  volumeMode,
                  priceMode,
                  (INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey)
                    .replace(/\s+/g, "-")
                    .toLowerCase(),
                )
              }
            >
              <Download className="size-4" />
              Export CSV
            </Button>
          </div>
        </div>
        <div className="mb-3">
          <MarketInsightsColumnGlossary />
        </div>
        <div className="mb-3">
          <InsightsFilterBar categories={categories} customCategories={customCategories} />
        </div>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No sales recorded in this window.
          </p>
        ) : filteredRows.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No items match the current filters.
          </p>
        ) : (
          // Break out of the centered page container so the wide screener can
          // use the full viewport width (minus a little breathing room).
          <div className="mx-[calc(50%-50vw)] px-4 sm:px-6 lg:px-8">
            <ScreenerTable
              rows={filteredRows}
              columns={visibleColumns}
              rowKey={(r) => r.itemId}
              sortKey={filters.sortKey}
              sortDir={filters.sortDir}
              onSortChange={(key, dir) =>
                dispatch(patchInsightsFilters({ sortKey: key, sortDir: dir }))
              }
              minWidth="1180px"
              onRowClick={(r) => navigate(`/market/items/${r.itemId}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
