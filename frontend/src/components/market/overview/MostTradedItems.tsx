import { formatGears, useAuctionSummary } from "@/lib/market/auction";
import { Link } from "react-router-dom";

export function MarketOverviewMostTradedItems() {
  const { data } = useAuctionSummary();
  if (!data) return null;

  return (
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
  );
}
