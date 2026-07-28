// Wealth concentration on the Auction House overview. Answers "how much of the
// gears traded happens between rich players?" using the precomputed `wealth`
// block on `summary.json` (see `build_wealth_concentration` in
// `backend/process_auction_data.py`). A player's wealth is their net seller
// revenue plus buyer spend, so both sides of the market count.
//
// The backend no longer bakes in a fixed "elite" cutoff — it ships the full
// ranked wealth distribution (`players`, richest first) plus two cutoff-
// independent flow arrays indexed by trader rank. That lets the viewer choose
// how the elite are defined and recompute everything live:
//   * "Top %"     — the richest N% of traders. Simple, but dilutes as more
//                   players join a server.
//   * "Net worth" — everyone worth at least X gears. Stable regardless of how
//                   many players join, so it stays meaningful as a server grows.
// For a chosen elite of the top `k` traders, the three flow buckets are:
//   elite ↔ elite     = sum(saleGearsByMaxRank.slice(0, k))
//   rest  ↔ rest      = sum(saleGearsByMinRank.slice(k))
//   elite ↔ everyone  = matchedGears − the two above

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setWealthMode,
  setWealthPercent,
  setWealthThreshold,
  type WealthEliteMode,
} from "@/store/slices/marketWealth";
import type { WealthConcentration, WealthPlayer } from "@/models/auction";
import { formatGameDate } from "./VirtualListingsTable";

const SEGMENTS = [
  { key: "elite", label: "Between elite seraphs", color: "bg-amber-500" },
  { key: "mixed", label: "Elite ↔ everyone else", color: "bg-sky-500" },
  { key: "rest", label: "Among the rest", color: "bg-slate-400 dark:bg-slate-500" },
] as const;

// Hex equivalents of the SEGMENTS tailwind colors, for the recharts area fills
// (CSS var()/tailwind classes don't resolve inside SVG presentation attrs).
const SEGMENT_HEX: Record<(typeof SEGMENTS)[number]["key"], string> = {
  elite: "#f59e0b", // amber-500
  mixed: "#0ea5e9", // sky-500
  rest: "#94a3b8", // slate-400
};

type EliteMode = WealthEliteMode;

/** Short axis labels: 1.2M / 34k / 812. */
function compactNumber(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

// Quick presets for the "Top %" control (also drawn as slider ticks).
const PERCENT_PRESETS = [1, 5, 10, 25, 50];
// Resolution of the log-scaled net-worth slider.
const AMOUNT_SLIDER_STEPS = 1000;

/** Number of players (from the top, richest first) worth at least `threshold`.
 *  `players` is sorted by wealth descending, so this is a binary search for the
 *  first player below the threshold. */
function countAtLeast(players: WealthPlayer[], threshold: number): number {
  let lo = 0;
  let hi = players.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (players[mid].wealth >= threshold) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function MarketWealthChart({
  wealth,
  recordingStart,
}: {
  wealth?: WealthConcentration;
  recordingStart?: number | null;
}) {
  const players = wealth?.players;
  const n = wealth?.traderCount ?? 0;

  // Wealth at the default top-10% boundary — the initial net-worth threshold, so
  // switching from "Top %" (default 10%) to "Net worth" starts on equal footing.
  const defaultThreshold = useMemo(() => {
    if (!players || players.length === 0) return 0;
    const k = Math.max(1, Math.ceil(players.length * 0.1));
    return players[k - 1].wealth;
  }, [players]);

  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.marketWealth.mode);
  const percent = useAppSelector((s) => s.marketWealth.percent);
  const threshold = useAppSelector((s) => s.marketWealth.threshold);
  const effThreshold = threshold ?? defaultThreshold;

  // Prefix sums for the flow arrays + running wealth, so any cutoff `k` is O(1).
  const sums = useMemo(() => {
    if (!wealth?.saleGearsByMaxRank || !wealth.saleGearsByMinRank || !players) {
      return null;
    }
    const maxR = wealth.saleGearsByMaxRank;
    const minR = wealth.saleGearsByMinRank;
    const len = players.length;
    // eePrefix[k] = gears where both parties rank < k (both elite).
    const eePrefix = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) eePrefix[i + 1] = eePrefix[i] + (maxR[i] ?? 0);
    // rrSuffix[k] = gears where both parties rank >= k (both non-elite).
    const rrSuffix = new Float64Array(len + 1);
    for (let i = len - 1; i >= 0; i--) rrSuffix[i] = rrSuffix[i + 1] + (minR[i] ?? 0);
    // wealthPrefix[k] = total wealth of the richest k players.
    const wealthPrefix = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) wealthPrefix[i + 1] = wealthPrefix[i] + players[i].wealth;
    return { eePrefix, rrSuffix, wealthPrefix };
  }, [wealth, players]);

  // Log-scale mapping for the net-worth slider (wealth is heavily skewed, so a
  // linear slider would waste most of its travel on the poorest players).
  const amountRange = useMemo(() => {
    if (!players || players.length === 0) return null;
    const hi = Math.max(players[0].wealth, 1);
    const lo = 1; // 1 gear floor keeps the log defined.
    return { lo, hi, logLo: Math.log(lo), logHi: Math.log(hi) };
  }, [players]);

  const sliderPos = useMemo(() => {
    if (!amountRange) return 0;
    const { lo, logLo, logHi } = amountRange;
    const w = Math.max(effThreshold, lo);
    const frac = (Math.log(w) - logLo) / (logHi - logLo || 1);
    return Math.round(frac * AMOUNT_SLIDER_STEPS);
  }, [amountRange, effThreshold]);

  // Over-time view: per-month prefix sums over each bucket's rank-binned flow
  // arrays, so the elite/rest split for any cutoff `k` is O(1) per bucket (same
  // trick as `sums` above, but one set per month).
  const bucketSums = useMemo(() => {
    const ts = wealth?.timeSeries;
    if (!ts || ts.length === 0) return null;
    return ts.map((b) => {
      const maxR = b.saleGearsByMaxRank ?? [];
      const minR = b.saleGearsByMinRank ?? [];
      const len = maxR.length;
      const eePrefix = new Float64Array(len + 1);
      for (let i = 0; i < len; i++) eePrefix[i + 1] = eePrefix[i] + (maxR[i] ?? 0);
      const rrSuffix = new Float64Array(len + 1);
      for (let i = len - 1; i >= 0; i--) rrSuffix[i] = rrSuffix[i + 1] + (minR[i] ?? 0);
      return { eePrefix, rrSuffix };
    });
  }, [wealth?.timeSeries]);

  // Snap the real-world "started recording" moment onto the monthly x-axis by
  // picking the bucket whose in-game clock is closest (mirrors MarketTrendsChart).
  const recordingLabel = useMemo(() => {
    const ts = wealth?.timeSeries;
    if (recordingStart == null || !ts || ts.length === 0) return null;
    let best = ts[0];
    for (const p of ts) {
      if (Math.abs(p.gameHours - recordingStart) < Math.abs(best.gameHours - recordingStart)) {
        best = p;
      }
    }
    return formatGameDate(best.gameHours);
  }, [recordingStart, wealth?.timeSeries]);

  // Absolute (per-month) vs cumulative flow view for the over-time chart.
  const [overTimeCumulative, setOverTimeCumulative] = useState(false);

  if (!wealth || !players || players.length === 0 || wealth.matchedGears <= 0 || !sums) {
    return null;
  }

  // Resolve the chosen elite as the richest `k` traders.
  const k =
    mode === "percent"
      ? Math.min(n, Math.max(1, Math.ceil((percent / 100) * n)))
      : countAtLeast(players, effThreshold);

  const ee = sums.eePrefix[k];
  const rest = sums.rrSuffix[k];
  const total = wealth.matchedGears;
  const mixed = Math.max(0, total - ee - rest);
  const values: Record<(typeof SEGMENTS)[number]["key"], number> = { elite: ee, mixed, rest };
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  const eliteWealth = sums.wealthPrefix[k];
  const eliteShare = wealth.totalWealth > 0 ? eliteWealth / wealth.totalWealth : 0;
  // Wealth of the poorest player still counted as elite (the cutoff line).
  const eliteFloor = k > 0 ? players[k - 1].wealth : 0;
  const eliteRoster = players.slice(0, k);

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

  const setThresholdFromPos = (pos: number) => {
    if (!amountRange) return;
    const { logLo, logHi, lo } = amountRange;
    const w = Math.exp(logLo + (pos / AMOUNT_SLIDER_STEPS) * (logHi - logLo));
    dispatch(setWealthThreshold(Math.max(lo, Math.round(w))));
  };

  const eliteLabel =
    mode === "percent" ? `top ${percent}%` : `worth ≥ ${formatGears(effThreshold)}`;

  // Per-month elite/rest/mixed split for the current cutoff `k`, optionally
  // accumulated. Gini rides along as the cumulative inequality line.
  const overTimeData =
    wealth.timeSeries && bucketSums
      ? (() => {
          let cee = 0;
          let cmix = 0;
          let crest = 0;
          return wealth.timeSeries.map((b, i) => {
            const bs = bucketSums[i];
            const kk = Math.min(k, bs.eePrefix.length - 1);
            const bee = bs.eePrefix[kk];
            const brest = bs.rrSuffix[kk];
            const bmix = Math.max(0, b.matchedGears - bee - brest);
            cee += bee;
            cmix += bmix;
            crest += brest;
            return {
              label: formatGameDate(b.gameHours),
              elite: overTimeCumulative ? cee : bee,
              mixed: overTimeCumulative ? cmix : bmix,
              rest: overTimeCumulative ? crest : brest,
              gini: b.gini,
            };
          });
        })()
      : [];

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div>
          <div className="font-medium">Wealth concentration</div>
          <p className="text-xs text-muted-foreground">
            Player wealth = net seller revenue + buyer spend. Choose how the “elite” are defined,
            then the bar splits gears traded (sold auctions with a known buyer and seller) by
            whether the elite were on one side, both, or neither.
          </p>
        </div>

        {/* Elite definition controls. */}
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Define the elite by</span>
            <Tabs value={mode} onValueChange={(v) => dispatch(setWealthMode(v as EliteMode))}>
              <TabsList className="h-8">
                <TabsTrigger value="percent" className="text-xs">
                  Top %
                </TabsTrigger>
                <TabsTrigger value="amount" className="text-xs">
                  Net worth
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {mode === "percent" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Richest{" "}
                  <span className="font-medium text-foreground tabular-nums">{percent}%</span> of
                  traders
                </span>
                <span>
                  ={" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {k.toLocaleString()}
                  </span>{" "}
                  seraph{k === 1 ? "" : "s"} · worth ≥ {formatGears(eliteFloor)}
                </span>
              </div>
              <Slider
                value={percent}
                min={1}
                max={50}
                step={1}
                onValueChange={(v) => dispatch(setWealthPercent(v))}
                snapMarkers={PERCENT_PRESETS.map((v) => ({ value: v }))}
                aria-label="Elite share of traders (percent)"
              />
              <div className="flex flex-wrap gap-1.5">
                {PERCENT_PRESETS.map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={percent === v ? "default" : "outline"}
                    className="h-6 px-2 text-xs"
                    onClick={() => dispatch(setWealthPercent(v))}
                  >
                    {v}%
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>Everyone worth at least</span>
                <span>
                  ={" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {k.toLocaleString()}
                  </span>{" "}
                  seraph{k === 1 ? "" : "s"} ·{" "}
                  <span className="tabular-nums">{n > 0 ? ((k / n) * 100).toFixed(1) : "0"}%</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  value={sliderPos}
                  min={0}
                  max={AMOUNT_SLIDER_STEPS}
                  step={1}
                  onValueChange={setThresholdFromPos}
                  className="flex-1"
                  aria-label="Minimum net worth to be elite (gears)"
                />
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    value={Math.round(effThreshold)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      dispatch(setWealthThreshold(Number.isFinite(v) && v >= 0 ? v : 0));
                    }}
                    className="h-7 w-24 text-right tabular-nums"
                    aria-label="Minimum net worth (gears)"
                  />
                  <span className="text-xs text-muted-foreground">⚙</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Elite seraphs" value={k.toLocaleString()} hint={eliteLabel} />
          <StatCard
            label="Elite wealth share"
            value={`${(eliteShare * 100).toFixed(0)}%`}
            hint="of all market wealth"
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
            (0 = everyone equally wealthy, 1 = a single player holds it all) and doesn’t change with
            your elite cutoff. Accumulated wealth is very unequal even in the real world (national
            wealth Gini ≈ 0.85), and virtual game economies usually sit around 0.7–0.9, so a high
            number here is normal.
          </p>
        )}

        {/* Who the elite actually are. */}
        {eliteRoster.length > 0 && <EliteRoster elite={eliteRoster} label={eliteLabel} />}

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

        {/* Over-time view: how the flow split and inequality evolved. */}
        {overTimeData.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Over time</div>
                <p className="text-xs text-muted-foreground">
                  {overTimeCumulative ? "Cumulative" : "Per in-game month"} gears traded, split by
                  your elite cutoff ({eliteLabel}), with cumulative wealth inequality (Gini) on the
                  right.
                </p>
              </div>
              <Button
                size="sm"
                variant={overTimeCumulative ? "default" : "outline"}
                onClick={() => setOverTimeCumulative((c) => !c)}
              >
                {overTimeCumulative ? "Cumulative" : "Per month"}
              </Button>
            </div>

            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={overTimeData}
                  margin={{ top: 4, right: 8, bottom: 18, left: 4 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={28}
                  />
                  <YAxis
                    yAxisId="gears"
                    tick={{ fontSize: 11 }}
                    width={48}
                    tickFormatter={(v: number) => compactNumber(v)}
                  />
                  <YAxis
                    yAxisId="gini"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    width={40}
                    domain={[0, 1]}
                    ticks={[0, 0.25, 0.5, 0.75, 1]}
                    tickFormatter={(v: number) => v.toFixed(2)}
                  />
                  <ChartTooltip
                    contentStyle={{
                      fontSize: 12,
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                    }}
                    labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    labelFormatter={(label) => `≈ ${label}`}
                    formatter={(value, name) =>
                      name === "Wealth inequality (Gini)"
                        ? [value == null ? "—" : Number(value).toFixed(3), name]
                        : [formatGears(Number(value)), name]
                    }
                  />
                  {SEGMENTS.map((s) => (
                    <Area
                      key={s.key}
                      yAxisId="gears"
                      type="monotone"
                      dataKey={s.key}
                      stackId="flows"
                      stroke={SEGMENT_HEX[s.key]}
                      fill={SEGMENT_HEX[s.key]}
                      fillOpacity={0.5}
                      strokeWidth={1}
                      name={s.label}
                    />
                  ))}
                  <Line
                    yAxisId="gini"
                    type="monotone"
                    dataKey="gini"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    name="Wealth inequality (Gini)"
                  />
                  {recordingLabel != null && (
                    <ReferenceLine
                      yAxisId="gears"
                      x={recordingLabel}
                      stroke="currentColor"
                      strokeDasharray="5 4"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                      label={{
                        value: "Started recording",
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "currentColor",
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Expandable roster of the elite players, opened in a dialog. Each row links to
 *  that player's market profile. */
function EliteRoster({ elite, label }: { elite: WealthPlayer[]; label: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" className="w-full sm:w-auto" />}>
        {`See the ${elite.length.toLocaleString()} elite seraph${elite.length === 1 ? "" : "s"} →`}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Elite Seraphs</DialogTitle>
          <DialogDescription>
            The {label} by net seller revenue plus buyer spend, richest first.
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
