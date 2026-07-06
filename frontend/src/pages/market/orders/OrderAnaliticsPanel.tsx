import { Card } from "@/components/ui/card";
import { formatGears } from "@/lib/auction";
import type { OrderAnalytics, OrderFill, SellUnit } from "@/models/orders";
import { formatQtyInUnit } from "./ordersShared";

export function OrderAnalyticsPanel({
  analytics,
  blockedBy,
  unitLabel,
  fills,
  sellUnit,
}: {
  analytics: OrderAnalytics;
  blockedBy: string;
  unitLabel: string;
  fills: OrderFill[];
  sellUnit: SellUnit;
}) {
  if (analytics.blocked) {
    return (
      <Card size="sm" className="px-3 text-sm text-muted-foreground">
        Price analytics blocked by {blockedBy}.
      </Card>
    );
  }
  if (!analytics.published || analytics.count === 0) {
    return (
      <Card size="sm" className="px-3 text-sm text-muted-foreground">
        No published trade prices yet.
      </Card>
    );
  }
  // Published, priced trades only — matches the aggregate `count` above.
  const trades = fills.filter((f) => f.publish_analytics && f.unit_price != null);
  // When prices are small, whole gears lose too much detail — show 2 decimals.
  const precise = (analytics.avg_price ?? 0) < 4;
  const fmtStat = (n: number) => (precise ? `${n.toFixed(2)}⚙` : formatGears(n));
  return (
    <Card size="sm" className="space-y-2 px-3">
      <div className="text-sm font-medium">Price analytics</div>
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Avg</div>
          <div className="font-semibold">{fmtStat(analytics.avg_price ?? 0)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Min</div>
          <div className="font-semibold">{fmtStat(analytics.min_price ?? 0)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Max</div>
          <div className="font-semibold">{fmtStat(analytics.max_price ?? 0)}</div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {analytics.count} trade{analytics.count === 1 ? "" : "s"}
        {analytics.total_quantity != null && ` · ${analytics.total_quantity} ${unitLabel}`}
      </div>
      {trades.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <div className="text-xs font-medium text-muted-foreground">Recent trades</div>
          <ul className="max-h-44 space-y-1 overflow-y-auto text-xs">
            {trades.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{formatTradeWhen(f.created_at)}</span>
                <span className="whitespace-nowrap">
                  {formatQtyInUnit(f.quantity_reduced, { sell_unit: sellUnit })} @{" "}
                  {formatGears(f.unit_price ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function formatTradeWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
