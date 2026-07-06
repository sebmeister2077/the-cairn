import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ApiError } from "@/lib/api";
import { formatGears } from "@/lib/auction";
import { ordersApi, useInvalidateOrders } from "@/lib/orders";
import type { OrderAnalytics, OrderFill, SellUnit } from "@/models/orders";
import { formatQtyInUnit, priceUnitLabel, SELL_UNIT_ONE } from "./ordersShared";

export function OrderAnalyticsPanel({
  analytics,
  blockedBy,
  unitLabel,
  fills,
  sellUnit,
  myId,
}: {
  analytics: OrderAnalytics;
  blockedBy: string;
  unitLabel: string;
  fills: OrderFill[];
  sellUnit: SellUnit;
  myId: string | null;
}) {
  const invalidate = useInvalidateOrders();
  // The offerer may toggle a false-price flag on their own trade.
  const [pendingFlag, setPendingFlag] = useState<OrderFill | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  const flag = useMutation({
    mutationFn: ({ id, flagged }: { id: number; flagged: boolean }) =>
      ordersApi.flagFill(id, flagged),
    onSuccess: () => {
      invalidate();
      setPendingFlag(null);
      setFlagError(null);
    },
    onError: (e) =>
      setFlagError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to update flag"),
  });

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
  // Every stat is a *per-unit* price (per stack/crate as the owner chose), so a
  // 2-stack trade and a 20-stack trade are directly comparable.
  const perUnit = priceUnitLabel({ sell_unit: sellUnit });
  return (
    <Card size="sm" className="space-y-2 px-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">Price analytics</div>
        <div className="text-xs text-muted-foreground">Price {perUnit}</div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Avg / {SELL_UNIT_ONE[sellUnit]}</div>
          <div className="font-semibold">{fmtStat(analytics.avg_price ?? 0)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Min / {SELL_UNIT_ONE[sellUnit]}</div>
          <div className="font-semibold">{fmtStat(analytics.min_price ?? 0)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Max / {SELL_UNIT_ONE[sellUnit]}</div>
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
            {trades.map((f) => {
              const mine = f.counterparty_api_key_id != null && f.counterparty_api_key_id === myId;
              return (
                <li key={f.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-muted-foreground">{formatTradeWhen(f.created_at)}</span>
                    {f.counterparty && (
                      <span className="truncate font-medium text-foreground">{f.counterparty}</span>
                    )}
                    {f.flagged && (
                      <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                        Flagged
                      </Badge>
                    )}
                  </span>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className={f.flagged ? "text-muted-foreground line-through" : undefined}>
                      {formatQtyInUnit(f.quantity_reduced, { sell_unit: sellUnit })} @{" "}
                      {formatGears(f.unit_price ?? 0)}/{SELL_UNIT_ONE[sellUnit]}
                    </span>
                    {mine && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => {
                          setFlagError(null);
                          setPendingFlag(f);
                        }}
                      >
                        {f.flagged ? "Unflag" : "Flag"}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {flagError && <p className="text-xs text-destructive">{flagError}</p>}
        </div>
      )}

      <ConfirmDialog
        open={pendingFlag != null}
        title={pendingFlag?.flagged ? "Remove the false-price flag?" : "Flag this trade as false?"}
        description={
          pendingFlag?.flagged
            ? "This restores the trade to the price analytics."
            : "This marks the recorded price as inaccurate and excludes it from the price analytics. The trade stays visible to everyone with a \u201CFlagged\u201D marker."
        }
        confirmLabel={pendingFlag?.flagged ? "Remove flag" : "Flag as false"}
        variant={pendingFlag?.flagged ? "default" : "destructive"}
        loading={flag.isPending}
        onConfirm={() => {
          if (pendingFlag) flag.mutate({ id: pendingFlag.id, flagged: !pendingFlag.flagged });
        }}
        onCancel={() => setPendingFlag(null)}
      />
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
