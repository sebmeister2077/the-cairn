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
import { INSIGHTS_WINDOWS } from "./useMarketInsights";

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

/** Gini coefficient over positive wealth values (0 = equal, →1 = one holder).
 *  Mirrors the backend `_gini`; null when nothing positive to measure. */
function giniFromValues(values: ArrayLike<number>): number | null {
  const vals: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) vals.push(values[i]);
  vals.sort((a, b) => a - b);
  const m = vals.length;
  if (m === 0) return null;
  let total = 0;
  for (const v of vals) total += v;
  if (total <= 0) return null;
  let cum = 0;
  for (let i = 0; i < m; i++) cum += (i + 1) * vals[i];
  return (2 * cum) / (m * total) - (m + 1) / m;
}

// Quick presets for the "Top %" control (also drawn as slider ticks).
const PERCENT_PRESETS = [1, 5, 10, 25, 50];
// Resolution of the log-scaled net-worth slider.
const AMOUNT_SLIDER_STEPS = 1000;

// In-game hours per selectable "day" of the time window (one real day of play
// advances the clock ~720 in-game hours = one in-game month), matching the
// windowing used by the Insights page. The over-time buckets are monthly, so a
// window of N days keeps roughly the last N monthly buckets.
const GAME_HOURS_PER_WINDOW_DAY = 720;

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

  // Absolute (per-month) vs cumulative flow view for the over-time chart.
  const [overTimeCumulative, setOverTimeCumulative] = useState(false);
  // Time window applied to the WHOLE panel (stats, flow bar and over-time
  // chart). Local to this card — reuses the Insights window presets but doesn't
  // touch the shared market-wide window. Measured back from the end of the most
  // recent recorded month, so the Overview page needn't fetch the full listings
  // dataset just to know the live clock.
  const [windowKey, setWindowKey] = useState<(typeof INSIGHTS_WINDOWS)[number]["key"]>("all");

  // Aggregate the windowed months once (independent of the elite cutoff `k`):
  // window-total flow prefix sums, per-rank wealth prefix sums, matched total,
  // total wealth and Gini for the range — plus each month's own flow prefixes
  // (for the stacked area) and cumulative-within-window Gini (for the line).
  const overTime = useMemo(() => {
    const ts = wealth?.timeSeries;
    if (!ts || ts.length === 0 || !players || players.length === 0) return null;
    const len = players.length;
    const windowDays = INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null;
    const latest = ts[ts.length - 1].gameHours + GAME_HOURS_PER_WINDOW_DAY;
    const cutoff = windowDays == null ? -Infinity : latest - windowDays * GAME_HOURS_PER_WINDOW_DAY;

    const aggMax = new Float64Array(len);
    const aggMin = new Float64Array(len);
    const aggWealth = new Float64Array(len);
    const running = new Float64Array(len);
    let matched = 0;
    const buckets: {
      label: string;
      eePrefix: Float64Array;
      rrSuffix: Float64Array;
      matched: number;
      gini: number | null;
    }[] = [];

    for (const b of ts) {
      if (b.gameHours < cutoff) continue;
      const maxR = b.saleGearsByMaxRank ?? [];
      const minR = b.saleGearsByMinRank ?? [];
      const wR = b.wealthByRank ?? [];
      const bl = maxR.length;
      const eePrefix = new Float64Array(bl + 1);
      for (let i = 0; i < bl; i++) eePrefix[i + 1] = eePrefix[i] + (maxR[i] ?? 0);
      const rrSuffix = new Float64Array(bl + 1);
      for (let i = bl - 1; i >= 0; i--) rrSuffix[i] = rrSuffix[i + 1] + (minR[i] ?? 0);
      for (let i = 0; i < len; i++) {
        aggMax[i] += maxR[i] ?? 0;
        aggMin[i] += minR[i] ?? 0;
        const dv = wR[i] ?? 0;
        aggWealth[i] += dv;
        running[i] += dv;
      }
      matched += b.matchedGears;
      buckets.push({
        label: formatGameDate(b.gameHours),
        eePrefix,
        rrSuffix,
        matched: b.matchedGears,
        gini: giniFromValues(running),
      });
    }

    // Window-total flow prefix sums, keyed to the ALL-TIME rank (0 = richest
    // overall), so elite/rest flows for a global-rank cutoff are O(1). Flows can
    // only be split along the all-time ordering (the backend bins them that
    // way), so the flow bar/area stay all-time-ranked even when the elite are
    // re-ranked by window wealth below.
    const eePrefix = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) eePrefix[i + 1] = eePrefix[i] + aggMax[i];
    const rrSuffix = new Float64Array(len + 1);
    for (let i = len - 1; i >= 0; i--) rrSuffix[i] = rrSuffix[i + 1] + aggMin[i];

    // Re-rank every trader by the wealth they earned *in this window* (identity
    // comes from the all-time roster at the same index). Drives the windowed
    // count, elite roster, wealth share, cutoff floor and Gini.
    const windowPlayers = players
      .map((p, i) => ({ uid: p.uid, name: p.name, wealth: aggWealth[i] }))
      .filter((p) => p.wealth > 0)
      .sort((a, b) => b.wealth - a.wealth);
    const wealthPrefix = new Float64Array(windowPlayers.length + 1);
    for (let i = 0; i < windowPlayers.length; i++) {
      wealthPrefix[i + 1] = wealthPrefix[i] + windowPlayers[i].wealth;
    }

    return {
      buckets,
      eePrefix,
      rrSuffix,
      windowPlayers,
      wealthPrefix,
      activeCount: windowPlayers.length,
      matched,
      totalWealth: wealthPrefix[windowPlayers.length],
      gini: giniFromValues(aggWealth),
    };
  }, [wealth?.timeSeries, players, windowKey]);

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

  if (!wealth || !players || players.length === 0 || wealth.matchedGears <= 0 || !sums) {
    return null;
  }

  // Everything below honors the selected time window. "All time" uses the
  // global aggregates (which also count sales we couldn't date); a narrower
  // window re-ranks traders by the wealth they earned *in that range*.
  const usingWindow = windowKey !== "all" && overTime != null;
  // Roster + trader count for the current range: re-ranked by window wealth when
  // a window is active, else the all-time roster.
  const rankedPlayers = usingWindow ? overTime.windowPlayers : players;
  const nEff = usingWindow ? overTime.activeCount : n;

  // Resolve the chosen elite as the richest `k` traders in the active range.
  const k =
    mode === "percent"
      ? Math.min(nEff, Math.max(1, Math.ceil((percent / 100) * nEff)))
      : countAtLeast(rankedPlayers, effThreshold);

  // Flows can only be split along the ALL-TIME ranking (the backend bins them
  // that way), so the flow bar/area use the all-time prefix of the same size
  // `k` — this is surfaced in the UI when a window is active. Uses window flows
  // when a range is selected, else the global all-time flows.
  const ee = usingWindow ? overTime.eePrefix[k] : sums.eePrefix[k];
  const rest = usingWindow ? overTime.rrSuffix[k] : sums.rrSuffix[k];
  const total = usingWindow ? overTime.matched : wealth.matchedGears;
  const mixed = Math.max(0, total - ee - rest);
  const values: Record<(typeof SEGMENTS)[number]["key"], number> = { elite: ee, mixed, rest };
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  const eliteWealth = usingWindow ? overTime.wealthPrefix[k] : sums.wealthPrefix[k];
  const totalWealth = usingWindow ? overTime.totalWealth : wealth.totalWealth;
  const eliteShare = totalWealth > 0 ? eliteWealth / totalWealth : 0;
  // Wealth of the poorest player still counted as elite (the cutoff line).
  const eliteFloor = k > 0 ? rankedPlayers[k - 1].wealth : 0;
  const eliteRoster = rankedPlayers.slice(0, k);

  const gini = usingWindow ? overTime.gini : wealth.gini;
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

  // Per-month stacked-area data: apply the current cutoff `k` to each windowed
  // bucket's own flow prefixes (cheap), optionally accumulating. The Gini line
  // is the cumulative-within-window inequality precomputed in `overTime`.
  const overTimeData = (() => {
    if (!overTime) {
      return [] as {
        label: string;
        elite: number;
        mixed: number;
        rest: number;
        gini: number | null;
      }[];
    }
    let cee = 0;
    let cmix = 0;
    let crest = 0;
    return overTime.buckets.map((b) => {
      const kk = Math.min(k, b.eePrefix.length - 1);
      const bee = b.eePrefix[kk];
      const brest = b.rrSuffix[kk];
      const bmix = Math.max(0, b.matched - bee - brest);
      cee += bee;
      cmix += bmix;
      crest += brest;
      return {
        label: b.label,
        elite: overTimeCumulative ? cee : bee,
        mixed: overTimeCumulative ? cmix : bmix,
        rest: overTimeCumulative ? crest : brest,
        gini: b.gini,
      };
    });
  })();
  const hasTimeSeries = !!(wealth.timeSeries && wealth.timeSeries.length > 0);

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

        {/* Time window — scopes every figure in this panel (stats, bar, chart).
            The elite are still defined by all-time wealth; the range only limits
            the market activity measured for them. */}
        {hasTimeSeries && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Range:</span>
            {INSIGHTS_WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={windowKey === w.key ? "default" : "outline"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        )}

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
                  <span className="tabular-nums">
                    {nEff > 0 ? ((k / nEff) * 100).toFixed(1) : "0"}%
                  </span>
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
            hint={usingWindow ? "of market wealth in range" : "of all market wealth"}
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

        {usingWindow && (
          <p className="text-xs text-muted-foreground">
            In a time range the elite are re-ranked by the wealth they earned{" "}
            <span className="text-foreground">in that range</span>. The flow split above (and the
            area chart below) can only be broken down by <span className="text-foreground">all-time</span>{" "}
            wealth rank, so it shows trades among the {k.toLocaleString()} richest{" "}
            <span className="text-foreground">all-time</span> traders rather than this range&apos;s
            top {k.toLocaleString()}.
          </p>
        )}

        {/* Over-time view: how the flow split and inequality evolved. */}
        {hasTimeSeries && (
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

            {overTimeData.length > 0 ? (
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
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No dated sales in this time range.
              </p>
            )}
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
