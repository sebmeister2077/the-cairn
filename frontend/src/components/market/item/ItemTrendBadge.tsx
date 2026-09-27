import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Info } from "lucide-react";
import type { PriceTrend } from "@/models/auction";

/** Small colored pill showing whether the recent price is trending up/down. */
export function ItemTrendBadge({
  trend,
  perUnit,
  stackSize,
}: {
  trend: PriceTrend;
  perUnit: boolean;
  stackSize: number;
}) {
  const { direction, changePct } = trend;
  const up = direction === "up";
  const down = direction === "down";
  const cls = up
    ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
    : down
      ? "bg-red-500/15 text-red-600 border-red-500/30"
      : "bg-muted text-muted-foreground border-input";
  const arrow = up ? "▲" : down ? "▼" : "→";
  const sign = changePct > 0 ? "+" : "";
  const label = direction === "flat" ? "Stable price" : `${sign}${changePct}% recently`;
  // The trend medians are per-unit (server-side). When the page is stack-priced
  // the per-unit figures round below 1 gear and read poorly (e.g. 0.703/unit),
  // so scale them to whole-stack prices to match the rest of the page. The
  // percentage change is a ratio, so it's unaffected by the scaling.
  const unit = perUnit ? "unit" : "stack";
  const scale = perUnit ? 1 : stackSize || 1;
  const fmt = (m: number) => (m * scale).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium ${cls}`}
    >
      <span aria-hidden>{arrow}</span>
      {label}
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="How is the price trend calculated?"
              className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Info className="size-4" />
            </button>
          }
        />
        <PopoverContent className="max-w-xs">
          <div className="space-y-1.5 text-left">
            <p>
              Compares this item&apos;s recent sale prices against older ones to show whether
              it&apos;s getting more expensive (▲), cheaper (▼), or holding steady (→).
            </p>
            <p>
              Timeframe: the most recent third of recorded sales (by real-world time) vs. the rest —
              here the latest {trend.recentCount} sales (median {fmt(trend.recentMedian)}/{unit})
              against the {trend.olderCount} older sales (median {fmt(trend.olderMedian)}/{unit}).
            </p>
            <p>Changes within ±8% are treated as “Stable price”.</p>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
