// Wealth concentration on the Auction House overview. Answers "how much of the
// gears traded happens between rich players?" using the precomputed `wealth`
// block on `summary.json` (see `build_wealth_concentration` in
// `backend/process_auction_data.py`). A player's wealth is their net seller
// revenue plus buyer spend; the wealthiest 10% are the "elite". The stacked bar
// splits every matched sale into trades between the elite, trades bridging the
// elite and everyone else, and trades among the rest.

import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/usage/StatCard";
import { formatGears } from "@/lib/auction";
import { cn } from "@/lib/utils";
import type { WealthConcentration, WealthTier } from "@/models/auction";

/** Gears traded between two tiers, looked up order-independently. */
function flowGears(w: WealthConcentration, a: WealthTier, b: WealthTier): number {
  const f = w.flows.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  return f?.gears ?? 0;
}

const SEGMENTS = [
  {
    key: "elite",
    label: "Between elite traders",
    color: "bg-amber-500",
  },
  {
    key: "mixed",
    label: "Elite ↔ everyone else",
    color: "bg-sky-500",
  },
  {
    key: "rest",
    label: "Among the rest",
    color: "bg-slate-400 dark:bg-slate-500",
  },
] as const;

export function MarketWealthChart({ wealth }: { wealth?: WealthConcentration }) {
  if (!wealth || wealth.matchedGears <= 0) return null;

  const ee = flowGears(wealth, "elite", "elite");
  const mixed = flowGears(wealth, "elite", "mid") + flowGears(wealth, "elite", "regular");
  const rest =
    flowGears(wealth, "mid", "mid") +
    flowGears(wealth, "mid", "regular") +
    flowGears(wealth, "regular", "regular");

  const total = wealth.matchedGears;
  const values: Record<(typeof SEGMENTS)[number]["key"], number> = {
    elite: ee,
    mixed,
    rest,
  };
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  const tc = wealth.tierPlayerCounts;
  const gini = wealth.gini;
  // Plain-language descriptor for the Gini number so viewers don't need to know
  // the term. Gini runs 0 (everyone equally wealthy) → 1 (one player owns it all).
  const giniWord =
    gini == null
      ? "—"
      : gini >= 0.6
        ? "Very high"
        : gini >= 0.45
          ? "High"
          : gini >= 0.3
            ? "Moderate"
            : "Low";

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div>
          <div className="font-medium">Wealth concentration</div>
          <p className="text-xs text-muted-foreground">
            Player wealth = net seller revenue + buyer spend; the wealthiest 10% are the “elite”.
            The bar splits gears traded (sold auctions with a known buyer and seller) by who was on
            each side.
          </p>
        </div>

        {/* How the trader population splits across the wealth tiers. */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {wealth.traderCount.toLocaleString()}
            </span>{" "}
            traders
          </span>
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {tc.elite.toLocaleString()}
            </span>{" "}
            elite (top 10%)
          </span>
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {tc.mid.toLocaleString()}
            </span>{" "}
            mid (next 40%)
          </span>
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {tc.regular.toLocaleString()}
            </span>{" "}
            regular (bottom 50%)
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label="Top 10% wealth share"
            value={`${(wealth.eliteShareOfWealth * 100).toFixed(0)}%`}
            hint={`held by ${tc.elite.toLocaleString()} elite traders`}
          />
          <StatCard label="Traded between elite" value={`${pct(ee).toFixed(0)}%`} />
          <StatCard
            label="Wealth inequality"
            value={giniWord}
            hint={gini != null ? `Gini ${gini.toFixed(2)} — 0 even, 1 concentrated` : undefined}
          />
        </div>

        {/* 100% stacked flow bar */}
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {SEGMENTS.map((s) => {
            const share = pct(values[s.key]);
            if (share <= 0) return null;
            return (
              <div
                key={s.key}
                className={s.color}
                style={{ width: `${share}%` }}
                title={`${s.label}: ${share.toFixed(1)}% · ${formatGears(values[s.key])}`}
              />
            );
          })}
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {SEGMENTS.map((s) => {
            const v = values[s.key];
            return (
              <div key={s.key} className="flex items-start gap-2">
                <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", s.color)} />
                <div className="min-w-0">
                  <div className="text-sm font-medium tabular-nums">
                    {pct(v).toFixed(0)}%{" "}
                    <span className="font-normal text-muted-foreground">· {formatGears(v)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
