// Community Orders marketplace — browse page. Anyone can view; posting an order
// requires an account. Independent of the static Auction House. Filter by
// side / item text / availability and sort by newest / price.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Package, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getMyAccountSafe } from "@/lib/api";
import { formatGears } from "@/lib/auction";
import { useOrdersList, useOrdersUnreadIds } from "@/lib/orders";
import type { Order, OrderFilters, OrderSide, OrderSort, TraderMobility } from "@/models/orders";
import { MOBILITY_SHORT, priceUnitLabel, unitTotalHint } from "./orders/ordersShared";
import { CreateOrderDialog } from "./orders/CreateOrderDialog";

const ALL = "__all__";

const MOBILITY_OPTIONS: { value: TraderMobility | typeof ALL; label: string }[] = [
  { value: ALL, label: "Any availability" },
  { value: "stationary", label: MOBILITY_SHORT.stationary },
  { value: "occasional", label: MOBILITY_SHORT.occasional },
  { value: "frequent", label: MOBILITY_SHORT.frequent },
];
const ORDER_SIDE_OPTIONS: { value: OrderSide | typeof ALL; label: string }[] = [
  { value: ALL, label: "All orders" },
  { value: "sell", label: "Selling" },
  { value: "buy", label: "Buying" },
];

const SORTING_OPTIONS: { value: OrderSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "price_asc", label: "Price: low → high" },
  { value: "price_desc", label: "Price: high → low" },
];

export function MarketOrdersPage() {
  const accountQuery = useQuery({ queryKey: ["account-me"], queryFn: getMyAccountSafe });
  const isLoggedIn = Boolean(accountQuery.data?.user);
  const unreadIds = useOrdersUnreadIds(isLoggedIn);

  const [side, setSide] = useState<OrderSide | "">("");
  const [q, setQ] = useState("");
  const [mobility, setMobility] = useState<TraderMobility | "">("");
  const [sort, setSort] = useState<OrderSort>("newest");
  const [showClosed, setShowClosed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const filters: OrderFilters = {
    side: side || undefined,
    q: q.trim() || undefined,
    mobility: mobility || undefined,
    sort,
    include_closed: showClosed || undefined,
    limit: 100,
  };
  const { data, isPending, isError, featureDisabled } = useOrdersList(filters);

  const postDisabled = !isLoggedIn || featureDisabled;
  const postDisabledReason = !isLoggedIn
    ? "Create an account to post an order"
    : featureDisabled
      ? "The Orders marketplace is not currently available."
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Community buy &amp; sell orders — post what you have or want, negotiate directly, and
            track fair prices. Independent of the in-game Auction House.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className={postDisabled ? "inline-block cursor-not-allowed" : "inline-block"} />
            }
          >
            <Button
              onClick={() => {
                if (postDisabled) return;
                setCreateOpen(true);
              }}
              disabled={postDisabled}
              className={postDisabled ? "pointer-events-none" : undefined}
            >
              <Plus className="h-4 w-4" aria-hidden />
              New order
            </Button>
          </TooltipTrigger>
          {postDisabledReason && <TooltipContent>{postDisabledReason}</TooltipContent>}
        </Tooltip>
      </div>

      {!isLoggedIn && (
        <p className="text-sm text-muted-foreground">
          You can browse freely.{" "}
          <Link to="/account" className="underline">
            Create an account
          </Link>{" "}
          to post orders, send requests, or negotiate.
        </p>
      )}

      {/* Filter / sort bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search items…"
            className="pl-8"
          />
        </div>
        <Select
          value={side || ALL}
          onValueChange={(v) => setSide(v === ALL ? "" : (v as OrderSide))}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="All orders">
              {(value) => ORDER_SIDE_OPTIONS.find((o) => o.value === value)?.label || "All orders"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ORDER_SIDE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={mobility || ALL}
          onValueChange={(v) => setMobility(v === ALL ? "" : (v as TraderMobility))}
        >
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Any availability">
              {(value) =>
                MOBILITY_OPTIONS.find((o) => o.value === value)?.label || "Any availability"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MOBILITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as OrderSort)}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue>
              {(value) => SORTING_OPTIONS.find((o) => o.value === value)?.label || "Newest"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SORTING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={showClosed} onCheckedChange={(v) => setShowClosed(v === true)} />
          Show closed
        </label>
      </div>

      {featureDisabled ? (
        <p className="py-12 text-center text-muted-foreground">
          The Orders marketplace is not currently available.
        </p>
      ) : isPending ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Spinner /> Loading orders…
        </div>
      ) : isError ? (
        <p className="py-12 text-center text-destructive">Failed to load orders.</p>
      ) : !data || data.orders.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">No orders match your filters yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.orders.map((order) => (
            <OrderCard key={order.id} order={order} unread={unreadIds.has(order.id)} />
          ))}
        </div>
      )}

      <CreateOrderDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function OrderCard({ order, unread }: { order: Order; unread: boolean }) {
  const sideLabel = order.side === "sell" ? "Selling" : "Buying";
  const sideClass =
    order.side === "sell"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : "bg-sky-500/15 text-sky-600 dark:text-sky-400";
  return (
    <Link to={`/market/orders/${order.id}`} className="block">
      <Card size="sm" className="px-3 transition-shadow hover:ring-foreground/20">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge className={sideClass}>{sideLabel}</Badge>
              {unread && (
                <span
                  title="New activity"
                  aria-label="New activity"
                  className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                />
              )}
              <span className="truncate font-medium">{order.item_name}</span>
            </div>
            {order.preview_text && (
              <p className="mt-1 truncate text-sm text-muted-foreground">{order.preview_text}</p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="font-semibold">{formatGears(order.unit_price)}</div>
            <div className="text-xs text-muted-foreground">{priceUnitLabel(order)}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Package className="h-3.5 w-3.5" aria-hidden />
            {order.quantity_remaining} / {order.quantity}{" "}
            {order.sell_unit === "unit" ? "left" : `${order.sell_unit}s left`}{" "}
            {unitTotalHint(order.quantity_remaining, order)}
          </span>
          {order.author && <span>by {order.author}</span>}
          {order.mobility && <span>· {MOBILITY_SHORT[order.mobility]}</span>}
          {order.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              {order.location.label || `${order.location.x}, ${order.location.z}`}
            </span>
          )}
          {order.created_at && (
            <span title={`Posted ${new Date(order.created_at).toLocaleString()}`}>
              · Posted {new Date(order.created_at).toLocaleDateString()}
            </span>
          )}
          {order.updated_at && order.updated_at !== order.created_at && (
            <span title={`Updated ${new Date(order.updated_at).toLocaleString()}`}>
              · Updated {new Date(order.updated_at).toLocaleDateString()}
            </span>
          )}
          {order.status === "fulfilled" && <Badge variant="outline">Fulfilled</Badge>}
        </div>
      </Card>
    </Link>
  );
}
