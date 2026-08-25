import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminUsage, type PromoAction, type UsageGranularity } from "@/lib/api";
import { StatCard } from "@/components/usage/StatCard";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";

const ACTION_LABELS: Record<PromoAction, string> = {
  impression: "Impressions",
  details_open: "Details opened",
  map_click: "Show-on-map clicks",
  announcement_click: "Announcement clicks",
  dismiss: "Dismissals",
};

const ACTION_SHORT: Record<PromoAction, string> = {
  impression: "Impression",
  details_open: "Opened details",
  map_click: "Show on map",
  announcement_click: "Announcement",
  dismiss: "Dismissed",
};

const FUNNEL_ORDER: PromoAction[] = [
  "impression",
  "details_open",
  "map_click",
  "announcement_click",
  "dismiss",
];

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

/**
 * Admin dashboard section for the promotion banner. Surfaces the interaction
 * funnel (impression → details → clicks/dismiss), the "dismissed after reading"
 * split, a per-action timeline, and a recent-events feed. Scopes to a single
 * promotion when more than one has been shown in the window.
 */
export function PromoSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const [promoId, setPromoId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["usage", "promo", props.from, props.to, props.granularity, promoId],
    queryFn: ({ signal }) =>
      adminUsage.promo(
        {
          from: props.from,
          to: props.to,
          granularity: props.granularity,
          promo_id: promoId ?? undefined,
          recent_limit: 100,
        },
        signal,
      ),
  });

  const timelineSeries = useMemo(
    () =>
      (q.data?.timeline ?? []).map((b) => ({
        bucket: b.bucket,
        series: ACTION_SHORT[b.series] ?? b.series,
        count: b.count,
      })),
    [q.data?.timeline],
  );

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="py-6 text-center text-sm text-red-600">Failed to load promo analytics.</div>
    );
  }

  const { summary, dismiss_split, by_promo, recent, promo_ids } = q.data;
  const impressions = summary.impression.count;
  const nothingYet = FUNNEL_ORDER.every((a) => summary[a].count === 0);

  return (
    <div className="space-y-4">
      {/* Promo picker — only when more than one promotion is in the window. */}
      {promo_ids.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPromoId(null)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              promoId == null
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:bg-accent"
            }`}
          >
            All promos
          </button>
          {promo_ids.map((pid) => (
            <button
              key={pid}
              type="button"
              onClick={() => setPromoId(pid)}
              className={`text-xs px-2.5 py-1 rounded-full border font-mono transition-colors ${
                promoId === pid
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-foreground border-border hover:bg-accent"
              }`}
            >
              {pid}
            </button>
          ))}
        </div>
      )}

      {/* Funnel counters. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {FUNNEL_ORDER.map((action) => {
          const s = summary[action];
          const rate =
            action === "impression" ? null : `${pct(s.count, impressions)} of impressions`;
          return (
            <StatCard
              key={action}
              label={ACTION_LABELS[action]}
              value={s.count.toLocaleString()}
              hint={
                rate
                  ? `${rate} · ${s.distinct_ips.toLocaleString()} distinct visitors`
                  : `${s.distinct_ips.toLocaleString()} distinct visitors`
              }
            />
          );
        })}
      </div>

      {/* Dismiss split. */}
      <Card>
        <CardHeader>
          <CardTitle>How people dismissed</CardTitle>
          <CardDescription>
            Whether the details dialog was opened before the banner was dismissed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Dismissed after reading"
            value={dismiss_split.after_details.toLocaleString()}
            hint="Opened the details, then dismissed."
          />
          <StatCard
            label="Dismissed outright"
            value={dismiss_split.outright.toLocaleString()}
            hint="Dismissed without opening details."
          />
          {dismiss_split.unknown > 0 && (
            <StatCard
              label="Dismissed (unknown)"
              value={dismiss_split.unknown.toLocaleString()}
              hint="Older events without the after-details flag."
            />
          )}
        </CardContent>
      </Card>

      {/* Timeline. */}
      <Card>
        <CardHeader>
          <CardTitle>Interactions over time</CardTitle>
          <CardDescription>Counts of each promo action per {props.granularity}.</CardDescription>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={timelineSeries}
            xKey="bucket"
            yKey="count"
            seriesKey="series"
            granularity={props.granularity}
          />
        </CardContent>
      </Card>

      {/* Per-promo breakdown (only when scoped to "all" and >1 promo). */}
      {promoId == null && by_promo.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By promotion</CardTitle>
            <CardDescription>Per-action totals for each promo in this window.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Promo</th>
                  {FUNNEL_ORDER.map((a) => (
                    <th key={a} className="px-3 py-2 text-right">
                      {ACTION_SHORT[a]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {by_promo.map((row) => (
                  <tr key={row.promo_id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{row.promo_id}</td>
                    {FUNNEL_ORDER.map((a) => (
                      <td key={a} className="px-3 py-2 text-right font-mono">
                        {row.actions[a].toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Recent events feed. */}
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Latest {recent.length} promo events (most recent first). Anonymous visitors show as “—”.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Details</th>
                <th className="px-3 py-2">Visitor</th>
                {promoId == null && <th className="px-3 py-2">Promo</th>}
              </tr>
            </thead>
            <tbody>
              {nothingYet ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                    No promo activity in this window.
                  </td>
                </tr>
              ) : (
                recent.map((r, i) => (
                  <tr key={`${r.created_at}-${i}`} className="border-t">
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{ACTION_SHORT[r.action] ?? r.action}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.action === "dismiss" && r.after_details != null
                        ? r.after_details
                          ? "after reading"
                          : "outright"
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.actor ?? "—"}</td>
                    {promoId == null && (
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                        {r.promo_id ?? "—"}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
