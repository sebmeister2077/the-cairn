import { Card, CardContent } from "@/components/ui/card";
import type { PriceIndexHeadline } from "@/models/auction";

const CONFIDENCE_STYLE: Record<string, { label: string; cls: string; blurb: string }> = {
  high: {
    label: "High confidence",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    blurb: "Lots of sellers agree and we matched many items, so this estimate is reliable.",
  },
  medium: {
    label: "Medium confidence",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    blurb: "A fair number of sales back this up, but treat it as a ballpark, not an exact figure.",
  },
  low: {
    label: "Low confidence",
    cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    blurb:
      "Sellers disagree a lot or there weren't many matching sales — read this as a rough hint.",
  },
};

export function MarketInflationHeadline({ h }: { h: PriceIndexHeadline }) {
  const up = h.inflationPct >= 0;
  const conf = CONFIDENCE_STYLE[h.confidence] ?? CONFIDENCE_STYLE.low;
  const months = Math.max(1, Math.round(h.spanDays / 30));
  return (
    <Card>
      <CardContent className="py-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="text-sm text-muted-foreground">
            Are prices going up? Over the last {months === 1 ? "month" : `${months} months`}…
          </div>
          <span
            className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium ${conf.cls}`}
            title={conf.blurb}
          >
            {conf.label}
          </span>
        </div>

        <div className="mt-1 text-4xl font-semibold tracking-tight">
          {up ? "+" : ""}
          {h.inflationPct.toFixed(1)}%
        </div>
        <p className="mt-1 text-sm">
          Things cost about{" "}
          <strong>
            {Math.abs(h.inflationPct).toFixed(0)}% {up ? "more" : "less"}
          </strong>{" "}
          in Rusty Gears than when tracking began. Most likely somewhere between{" "}
          <strong>
            {h.ciLowPct >= 0 ? "+" : ""}
            {h.ciLowPct.toFixed(0)}%
          </strong>{" "}
          and{" "}
          <strong>
            {h.ciHighPct >= 0 ? "+" : ""}
            {h.ciHighPct.toFixed(0)}%
          </strong>
          .
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{conf.blurb}</p>
      </CardContent>
    </Card>
  );
}
