import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/usage/StatCard";
import { useAuctionSummary, formatGears } from "@/lib/auction";

function FreshnessBanner({ generatedUtc }: { generatedUtc: string }) {
  const when = new Date(generatedUtc);
  const rel = (() => {
    const mins = Math.round((Date.now() - when.getTime()) / 60000);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} days ago`;
  })();
  return (
    <p className="text-xs text-muted-foreground">
      Market snapshot last updated {when.toLocaleString()} ({rel}). Data is captured periodically
      from the in-game Auction House.
    </p>
  );
}

export function MarketOverviewPage() {
  const { data, isLoading, isError } = useAuctionSummary();

  if (isLoading) {
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
        <h1 className="text-2xl font-semibold">Auction House</h1>
        <FreshnessBanner generatedUtc={data.generatedUtc} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Gears traded" value={formatGears(t.gearsTraded)} />
        <StatCard label="Items sold" value={t.soldCount} />
        <StatCard label="Sell-through" value={`${(t.sellThrough * 100).toFixed(0)}%`} />
        <StatCard label="Fees paid" value={formatGears(t.feesPaid)} />
        <StatCard label="Active listings" value={t.activeListings} />
        <StatCard label="Unique items" value={t.uniqueItems} />
        <StatCard label="Traders" value={t.uniqueSellers} />
        <StatCard label="Buyers" value={t.uniqueBuyers} />
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <Link to="/market/listings">
          <Card className="hover:border-primary transition-colors h-full">
            <CardContent className="py-4">
              <div className="font-medium">Browse listings</div>
              <p className="text-sm text-muted-foreground">
                Filter {t.totalAuctions.toLocaleString()} auctions by item, price, category and
                more.
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link to="/market/leaderboards">
          <Card className="hover:border-primary transition-colors h-full">
            <CardContent className="py-4">
              <div className="font-medium">Leaderboards</div>
              <p className="text-sm text-muted-foreground">
                Top traders, buyers and the most valuable items on the market.
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link to="/market/map">
          <Card className="hover:border-primary transition-colors h-full">
            <CardContent className="py-4">
              <div className="font-medium">Trade map</div>
              <p className="text-sm text-muted-foreground">
                Heatmaps of where items are sold and delivered across the world.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-2">Most traded items</h2>
        <div className="rounded-md border divide-y">
          {data.itemStats.slice(0, 10).map((it) => (
            <Link
              key={it.itemId}
              to={`/market/items/${it.itemId}`}
              className="flex items-center justify-between px-3 py-2 hover:bg-muted/50"
            >
              <span className="font-medium">{it.name}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {it.unitsSold.toLocaleString()} sold · {formatGears(it.gearsTraded)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
