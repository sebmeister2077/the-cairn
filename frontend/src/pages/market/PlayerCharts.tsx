// Charts for the player-profile page.
//
//  * PlayerPricingChart — how the player priced their listings relative to the
//    prevailing market median over (in-game) time. Each point is one listing,
//    plotted as its % premium vs the market reference; the zero line IS the
//    market median, so points above it were listed above market and below it
//    below market. Sold vs unsold are distinguished, not judged.
//  * PlayerActivityChart — the player's trading cadence per in-game month.

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  ScatterChart,
  Scatter,
  Bar,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { formatGameDate } from "./VirtualListingsTable";
import { percentileSorted } from "@/lib/auction";
import type { PlayerActivityPoint, PlayerPricingHistoryPoint } from "@/models/auction";

/** Track the app's dark/light theme (a `dark` class on `<html>`). */
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

const tooltipStyle = {
  fontSize: 12,
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgb(0 0 0 / 0.15)",
} as const;

const SOLD_COLOR = "#10b981";
const UNSOLD_COLOR = "#94a3b8";
const LISTED_COLOR = "#3b82f6";
const BOUGHT_COLOR = "#f59e0b";

/** Minimal shape of the props Recharts passes to a custom Tooltip `content`. */
interface PricingTooltipProps {
  active?: boolean;
  payload?: { payload: PlotPoint }[];
}

function PricingTooltip({ active, payload }: PricingTooltipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const prem = p.premiumPct ?? 0;
  const sign = prem >= 0 ? "+" : "";
  const premClass =
    prem > 1
      ? "text-emerald-600 dark:text-emerald-400"
      : prem < -1
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <div style={tooltipStyle} className="min-w-40 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-2">
        <span
          className="inline-block size-2 shrink-0 rounded-sm"
          style={{ background: p.sold ? SOLD_COLOR : UNSOLD_COLOR }}
          aria-hidden
        />
        <span className="truncate font-medium">{p.name}</span>
      </div>
      <div className="mb-1 text-xs text-muted-foreground">
        {formatGameDate(p.gameHours)} · {p.sold ? "Sold" : "Listed"}
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Price / unit</span>
        <span className="font-medium tabular-nums">{p.pricePerUnit.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Market median</span>
        <span className="font-medium tabular-nums">
          {p.refPricePerUnit?.toLocaleString() ?? "—"}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-4 border-t pt-0.5">
        <span className="text-muted-foreground">vs market</span>
        <span className={`font-semibold tabular-nums ${premClass}`}>
          {sign}
          {prem.toFixed(0)}%{p.clamped ? " (off scale)" : ""}
        </span>
      </div>
    </div>
  );
}

/** A pricing point positioned for the chart: `plotPremium` is the (possibly
 * clamped-to-axis) value actually drawn, while `premiumPct` keeps the true
 * figure for the tooltip. */
interface PlotPoint extends PlayerPricingHistoryPoint {
  plotPremium: number;
  clamped: boolean;
}

/** Above this many points we thin the scatter to keep rendering smooth; the
 * most extreme over/under-priced points are always kept. */
const MAX_SCATTER_POINTS = 1200;

/** Hard upper bound (%) for the pricing chart's Y axis — outliers above this
 * are clamped to the top edge rather than stretching the whole scale. */
const PREMIUM_CEILING = 250;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Scatter of per-listing price premium (%) vs the market median over in-game
 * time. Only listings with a market reference are plotted. The Y axis is capped
 * to a robust range so a single absurd outlier (e.g. +500,000%) can't flatten
 * every other point into an unreadable band; clamped points sit at the edge and
 * are labelled "off scale" in their tooltip. */
export function PlayerPricingChart({
  points,
  height = 300,
}: {
  points: PlayerPricingHistoryPoint[];
  height?: number;
}) {
  const isDark = useIsDarkTheme();
  const gridStroke = isDark ? "#1f2937" : "#e5e7eb";
  const axisStroke = isDark ? "#94a3b8" : "#64748b";

  const { sold, unsold, domain } = useMemo(() => {
    const withRef = points.filter((p) => p.premiumPct != null);
    const prem = withRef.map((p) => p.premiumPct as number).sort((a, b) => a - b);

    // Robust axis bounds from the 2nd/98th percentiles, padded a touch and
    // floored to a sensible minimum spread so tiny datasets still read well.
    let lo = -10;
    let hi = 25;
    if (prem.length) {
      const p2 = percentileSorted(prem, 0.02);
      const p98 = percentileSorted(prem, 0.98);
      const pad = Math.max(5, (p98 - p2) * 0.08);
      lo = Math.min(-5, Math.floor(p2 - pad));
      hi = Math.max(10, Math.ceil(p98 + pad));
      // Hard ceiling: never show above +250% on the axis, so a handful of
      // absurdly over-priced listings can't stretch the scale and squash
      // everything else. Anything higher is clamped to the top edge and marked
      // "(off scale)" in its tooltip.
      hi = Math.min(PREMIUM_CEILING, hi);
      // Never claim to show below a total giveaway (−100%).
      lo = Math.max(-100, lo);
    }

    const toPlot = (p: PlayerPricingHistoryPoint): PlotPoint => {
      const raw = p.premiumPct as number;
      const plot = clamp(raw, lo, hi);
      return { ...p, plotPremium: plot, clamped: plot !== raw };
    };

    // Thin the cloud if it's huge, but always keep the clamped extremes (the
    // interesting outliers) so downsampling never hides them.
    let sample = withRef;
    if (withRef.length > MAX_SCATTER_POINTS) {
      const extremes = withRef.filter(
        (p) => (p.premiumPct as number) <= lo || (p.premiumPct as number) >= hi,
      );
      const rest = withRef.filter(
        (p) => (p.premiumPct as number) > lo && (p.premiumPct as number) < hi,
      );
      const step = Math.ceil(rest.length / Math.max(1, MAX_SCATTER_POINTS - extremes.length));
      const thinned = rest.filter((_, i) => i % step === 0);
      sample = [...extremes, ...thinned];
    }

    const plotted = sample.map(toPlot);
    return {
      sold: plotted.filter((p) => p.sold),
      unsold: plotted.filter((p) => !p.sold),
      domain: [lo, hi] as [number, number],
    };
  }, [points]);

  if (sold.length + unsold.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">
        Not enough priced listings with a market reference to chart.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="gameHours"
          name="Game date"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v) => formatGameDate(v as number)}
          tick={{ fontSize: 11, fill: axisStroke }}
          stroke={axisStroke}
        />
        <YAxis
          type="number"
          dataKey="plotPremium"
          name="vs market"
          unit="%"
          domain={domain}
          allowDataOverflow
          tick={{ fontSize: 11, fill: axisStroke }}
          stroke={axisStroke}
        />
        <ZAxis range={[36, 36]} />
        <ReferenceLine
          y={0}
          stroke={axisStroke}
          strokeDasharray="4 4"
          label={{ value: "Market median", position: "insideTopRight", fontSize: 10, fill: axisStroke }}
        />
        <Tooltip content={<PricingTooltip />} wrapperStyle={{ outline: "none" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Scatter name="Sold" data={sold} fill={SOLD_COLOR} fillOpacity={0.7} />
        <Scatter name="Listed" data={unsold} fill={UNSOLD_COLOR} fillOpacity={0.55} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** Readable tooltip for the activity chart: the default recharts item text is
 * tinted with each series colour (low-contrast on the popover); this renders a
 * coloured swatch plus foreground-coloured labels/values instead. */
interface ActivityTooltipProps {
  active?: boolean;
  label?: number | string;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string | number }[];
}

function ActivityTooltip({ active, payload, label }: ActivityTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div style={tooltipStyle} className="px-2.5 py-1.5">
      <div className="mb-1 font-medium">{formatGameDate(Number(label))}</div>
      <div className="space-y-0.5">
        {payload.map((e) => (
          <div key={String(e.dataKey ?? e.name)} className="flex items-center gap-2">
            <span
              className="inline-block size-2 shrink-0 rounded-sm"
              style={{ background: e.color }}
              aria-hidden
            />
            <span className="text-muted-foreground">{e.name}</span>
            <span className="ml-auto font-medium tabular-nums">{e.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Grouped bars of listings / sales / purchases per in-game month. */
export function PlayerActivityChart({
  activity,
  height = 240,
}: {
  activity: PlayerActivityPoint[];
  height?: number;
}) {
  const isDark = useIsDarkTheme();
  const gridStroke = isDark ? "#1f2937" : "#e5e7eb";
  const axisStroke = isDark ? "#94a3b8" : "#64748b";

  if (activity.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">
        No activity in this window.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={activity} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis
          dataKey="gameHours"
          tickFormatter={(v) => formatGameDate(v as number)}
          tick={{ fontSize: 11, fill: axisStroke }}
          stroke={axisStroke}
        />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: axisStroke }} stroke={axisStroke} />
        <Tooltip content={<ActivityTooltip />} wrapperStyle={{ outline: "none" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="listed" name="Listed" fill={LISTED_COLOR} />
        <Bar dataKey="sold" name="Sold" fill={SOLD_COLOR} />
        <Bar dataKey="bought" name="Bought" fill={BOUGHT_COLOR} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
