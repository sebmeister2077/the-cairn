import { Card, CardContent } from "@/components/ui/card";
import { useAuctionSummary } from "@/lib/market/auction";
import { Link } from "react-router-dom";

export function MarketOverviewNavigationCards() {
  const { data, isPending, isError } = useAuctionSummary();
  if (!data) return null;

  return (
    <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
      {data.priceIndex && (
        <Link to="/market/price-index">
          <Card className="hover:border-primary transition-colors h-full">
            <CardContent className="py-4">
              <div className="font-medium">Price Index</div>
              <p className="text-sm text-muted-foreground">
                Prices are about{" "}
                <strong>
                  {data.priceIndex.headline.inflationPct >= 0 ? "+" : ""}
                  {data.priceIndex.headline.inflationPct.toFixed(0)}%
                </strong>{" "}
                vs {Math.max(1, Math.round(data.priceIndex.headline.spanDays / 30))} months ago.
              </p>
            </CardContent>
          </Card>
        </Link>
      )}
      <Link to="/market/listings">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Browse listings</div>
            <p className="text-sm text-muted-foreground">
              Filter {data.totals.totalAuctions.toLocaleString()} auctions by item, price, category
              and more.
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link to="/market/items">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Items</div>
            <p className="text-sm text-muted-foreground">
              Search every item on the market and jump to its price history.
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link to="/market/insights">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Insights</div>
            <p className="text-sm text-muted-foreground">
              Screen items by demand, volatility, liquidity and deals over any time window.
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link to="/market/converter">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Converter</div>
            <p className="text-sm text-muted-foreground">
              Work out fair barter rates between any two items from their gear prices.
            </p>
          </CardContent>
        </Card>
      </Link>
      <Link to="/market/leaderboards">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Leaderboards</div>
            <p className="text-sm text-muted-foreground">
              Top seraphs, buyers and the most valuable items on the market.
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
      <Link to="/market/orders">
        <Card className="hover:border-primary transition-colors h-full">
          <CardContent className="py-4">
            <div className="font-medium">Orders</div>
            <p className="text-sm text-muted-foreground">
              Community buy &amp; sell orders — post what you have or want and negotiate directly.
            </p>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
