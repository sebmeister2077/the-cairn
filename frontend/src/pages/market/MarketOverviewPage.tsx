import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/usage/StatCard";
import { useAuctionSummary, formatGears } from "@/lib/market/auction";
import { useRealDateForGameHours } from "@/hooks/useRealDateForGameHours";
import { MarketOverviewTrendsChart } from "@/components/market/overview/MarketTrendsChart";
import { MarketWealthChart } from "@/components/market/MarketWealthChart";
import { FreshnessBanner } from "@/components/market/FreshnessBanner";
import { MaintenanceChip } from "@/components/other/MaintenanceChip";
import { MarketOverviewNavigationCards } from "@/components/market/overview/NavigationCards";
import { MarketOverviewMostTradedItems } from "@/components/market/overview/MostTradedItems";

export function MarketOverviewPage() {
  const { data, isPending, isError } = useAuctionSummary();

  // Anchor in-game hours to real time so the charts can label the x-axis with
  // real dates. Prefer the live app clock (exact sweep time ↔ game clock); fall
  // back to the summary's generation time mapped to the end of the last bucket.
  const realDateForGameHours = useRealDateForGameHours();

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-destructive py-12 text-center">Failed to load market summary.</p>;
  }

  const t = data.totals;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">
          <div className="flex items-center gap-2">
            <a
              href="https://topsinfo.vintagestory.at"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              TOPS
            </a>{" "}
            Auction House
            <MaintenanceChip component="auction_overview" />
          </div>
        </h1>
        <FreshnessBanner generatedUtc={data.generatedUtc} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Gears traded" value={formatGears(t.gearsTraded)} />
        <StatCard
          label="Gears removed"
          value={formatGears(
            (t.feesPaid ?? 0) + (t.depositFeesPaid ?? 0) + (t.deliveryFeesPaid ?? 0),
          )}
        />
        <StatCard label="Items sold" value={t.soldCount} />
        <StatCard label="Sell-through" value={`${(t.sellThrough * 100).toFixed(0)}%`} />
        <StatCard label="Fees paid" value={formatGears(t.feesPaid)} />
        <StatCard label="Deposit fees paid" value={formatGears(t.depositFeesPaid ?? 0)} />
        <StatCard label="Delivery fees paid" value={formatGears(t.deliveryFeesPaid ?? 0)} />
        <StatCard
          label="Delivered sales"
          value={`${(t.deliveredCount ?? 0).toLocaleString()} · ${((t.deliveryRate ?? 0) * 100).toFixed(0)}%`}
        />
        <StatCard label="Active listings" value={t.activeListings} />
        <StatCard label="Unique items" value={t.uniqueItems} />
        <StatCard label="Sellers" value={t.uniqueSellers} />
        <StatCard label="Buyers" value={t.uniqueBuyers} />
      </div>

      <MarketOverviewTrendsChart
        series={data.timeSeries ?? []}
        recordingStart={data.recordingStartGameHours}
        realDateForGameHours={realDateForGameHours}
      />

      <MarketWealthChart
        wealth={data.wealth}
        recordingStart={data.recordingStartGameHours}
        realDateForGameHours={realDateForGameHours}
      />

      <MarketOverviewNavigationCards />

      <MarketOverviewMostTradedItems />
    </div>
  );
}
