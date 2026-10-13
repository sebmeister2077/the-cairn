// --------------------------------------------------------------------------- //
// Column glossary

import { ExternalLink } from "lucide-react";

// --------------------------------------------------------------------------- //
type GlossaryEntry = {
  /** Column header this explains. */
  term: string;
  /** Plain-language meaning. */
  what: string;
  /** How to read the number/badge you see. */
  read: string;
  /** Optional “learn more” link (e.g. Wikipedia for the underlying metric). */
  link?: { label: string; href: string };
};

export const MARKET_INSIGHTS_COLUMN_GLOSSARY: GlossaryEntry[] = [
  {
    term: "Volume",
    what: "Total traded in the window. Toggle shows either gears (money that changed hands) or units (quantity sold).",
    read: "Higher = more actively traded.",
  },
  {
    term: "Median/unit",
    what: "The typical per-unit sale price. The price toggle switches this between the plain median (middle sale, outlier-resistant) and a quantity-weighted median, where each sale counts in proportion to the quantity it moved so bulk trades set the price.",
    read: "Your fair-price reference for one unit.",
  },
  {
    term: "Volatility",
    what: "How much sellers disagree on price, from the spread between the cheap (25th) and pricey (75th) sales.",
    read: "Stable = tight, predictable pricing · Volatile = wide, risky spread.",
  },
  {
    term: "Trend",
    what: "Whether the per-unit price is rising or falling — recent sales compared to older sales in the window.",
    read: "+% = getting more expensive · −% = getting cheaper · Flat = steady.",
  },
  {
    term: "Sell-through",
    what: "Of the listings that finished, the share that actually sold instead of expiring.",
    read: "High % = strong demand, sells reliably · Low % = often goes unsold.",
  },
  {
    term: "Time to sell",
    what: "Typical real-world wait from posting a listing to it selling.",
    read: "Lower = sells faster.",
  },
  {
    term: "Demand",
    what: "Popularity score (0–100) blending volume, sell speed and sell-through.",
    read: "Hot / High / Normal / Low. ⚠ marks a shortage: selling fast with little stock left.",
  },
  {
    term: "Liquidity",
    what: "How easily and quickly you can turn the item into gears (0–100).",
    read: "High = fast, reliable sales · Low = expect to wait or undercut.",
  },
  {
    term: "Deal",
    what: "How far the cheapest listings sit below the fair (median) price.",
    read: '"30%" = bargains are ~30% under median · "·N" = N live listings priced below fair right now (buy targets).',
  },
  {
    term: "Sellers",
    what: "How concentrated supply is among sellers (HHI).",
    read: "Competitive = many sellers · Concentrated / Monopoly = one or few control supply, so prices are easier to swing.",
    link: {
      label: "About HHI",
      href: "https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index",
    },
  },
  {
    term: "Delivery +",
    what: "Extra that buyers pay for delivered listings (sent to them) versus pickup (they travel to collect).",
    read: "+% = delivery commands a premium · −% = delivered listings are actually cheaper. Example: if pickup sells for ~10 gears and delivered for ~8, that's −20% (delivered went for less).",
  },
  {
    term: "Confidence",
    what: "How much data backs the numbers — based on the number of recorded sales.",
    read: "High = trust it · Medium = decent · Low = few sales, treat as rough.",
  },
  {
    term: "Last sale",
    what: "In-game date of the most recent sale, with a recency dot.",
    read: "Green = active · Amber = cooling off · Grey = stale.",
  },
];

export function MarketInsightsColumnGlossary() {
  return (
    <details className="group rounded-lg border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium">
        <span>What do these columns mean?</span>
        <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="grid gap-x-6 gap-y-3 border-t px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {MARKET_INSIGHTS_COLUMN_GLOSSARY.map((g) => (
          <div key={g.term} className="text-sm">
            <div className="font-medium">{g.term}</div>
            <p className="text-muted-foreground">{g.what}</p>
            <p className="mt-0.5 text-xs text-muted-foreground/80">{g.read}</p>
            {g.link ? (
              <a
                href={g.link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {g.link.label}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}
