// Wealth concentration on the Auction House overview. Answers "how much of the
// gears traded happens between rich players?" using the precomputed `wealth`
// block on `summary.json` (see `build_wealth_concentration` in
// `backend/process_auction_data.py`). A player's wealth is their net seller
// revenue plus buyer spend; the wealthiest 10% are the "elite". The stacked bar
// splits every matched sale into trades between the elite, trades bridging the
// elite and everyone else, and trades among the rest.

import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { StatCard } from "@/components/usage/StatCard";
import { formatGears } from "@/lib/auction";
import { cn } from "@/lib/utils";
import type { WealthConcentration, WealthPlayer, WealthTier } from "@/models/auction";

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
  // Plain-language descriptor for the Gini number, calibrated for a GAME economy
  // rather than a real-world one. Virtual economies are naturally top-heavy —
  // veteran players have simply had far longer to accumulate than newcomers — so
  // they typically sit around 0.7–0.9, where a real country would be extreme.
  // The bands reflect that so a normal server doesn't read as alarming.
  const giniWord =
    gini == null
      ? "—"
      : gini >= 0.93
        ? "Extreme"
        : gini >= 0.85
          ? "High"
          : gini >= 0.6
            ? "Typical"
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
            hint={gini != null ? `Gini ${gini.toFixed(2)}` : undefined}
          />
        </div>

        {gini != null && (
          <p className="text-xs text-muted-foreground">
            “Wealth inequality” is the{" "}
            <a
              href="https://en.wikipedia.org/wiki/Gini_coefficient"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Gini coefficient
            </a>{" "}
            (0 = everyone equally wealthy, 1 = a single player holds it all). Accumulated wealth is
            very unequal even in the real world (national wealth Gini ≈ 0.85), and virtual game
            economies usually sit around 0.7–0.9, so a high number here is normal.
          </p>
        )}

        {/* Who the elite actually are. */}
        {wealth.elite && wealth.elite.length > 0 && <EliteRoster elite={wealth.elite} />}

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

/** Expandable roster of the elite players (richest 10%), opened in a dialog.
 *  Each row links to that player's market profile. */
function EliteRoster({ elite }: { elite: WealthPlayer[] }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" className="w-full sm:w-auto" />}>
        {`See the ${elite.length.toLocaleString()} elite trader${elite.length === 1 ? "" : "s"} →`}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Elite traders</DialogTitle>
          <DialogDescription>
            The wealthiest 10% by net seller revenue plus buyer spend, richest first.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border divide-y">
          {elite.map((p, i) => (
            <Link
              key={p.uid}
              to={`/market/players/${encodeURIComponent(p.uid)}`}
              className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="truncate font-medium">{p.name ?? "Unknown"}</span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {formatGears(p.wealth)}
              </span>
            </Link>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
