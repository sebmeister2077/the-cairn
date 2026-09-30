import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAuctionSummary } from "@/lib/auction";
import { FreshnessBanner } from "@/components/market/FreshnessBanner";
import { MarketInflationChart } from "@/components/market/MarketInflationChart";
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
    blurb: "Sellers disagree a lot or there weren't many matching sales — read this as a rough hint.",
  },
};

function Pill({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span className={up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}>
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function Headline({ h }: { h: PriceIndexHeadline }) {
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

function Explainer() {
  return (
    <Card>
      <CardContent className="py-4 text-sm text-muted-foreground space-y-2">
        <div className="font-medium text-foreground">How this is measured</div>
        <p>
          We take thousands of real Auction House sales and compare what the same items sold for
          recently versus at the start of tracking — like a shopping basket you re-price over time.
        </p>
        <p>
          Not every seller raises prices with inflation, and a few rare items swing wildly. So we
          use the <strong>typical</strong> change across many items (not the average), which stops a
          handful of big jumps from distorting the picture. Items that never change price correctly
          pull the number toward zero.
        </p>
        <p>
          “Confidence” reflects how much sellers agree and how many items we could match between the
          two periods — not a guarantee.
        </p>
      </CardContent>
    </Card>
  );
}

export function MarketInflationPage() {
  const { data, isPending, isError } = useAuctionSummary();

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

  const pi = data.priceIndex;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Inflation</h1>
        <FreshnessBanner generatedUtc={data.generatedUtc} />
      </div>

      {!pi ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Not enough sales have been recorded yet to estimate inflation.
          </CardContent>
        </Card>
      ) : (
        <>
          <Headline h={pi.headline} />
          <MarketInflationChart trend={pi.trend} />

          {pi.categories.length > 0 && (
            <Card>
              <CardContent className="py-4">
                <div className="mb-1 font-medium">Which goods moved the most</div>
                <p className="mb-3 text-sm text-muted-foreground">
                  Price change by type of item, from the start of tracking to now. Sorted by how
                  much of the market they make up.
                </p>
                <ul className="divide-y divide-border text-sm">
                  {pi.categories.slice(0, 12).map((c) => (
                    <li key={c.category} className="flex items-center justify-between py-1.5">
                      <span className="capitalize">{c.category}</span>
                      <span className="tabular-nums">
                        <Pill pct={c.inflationPct} />
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Explainer />
        </>
      )}
    </div>
  );
}
