// Aggregate + per-segment stats panel for the multi-tunnel network.
// The aggregate row shows totals across every rendered branch; the
// disclosure expands a per-segment table.

import { useMemo, useState } from "react";

import { useTranslation } from "@/lib/i18n";
import {
  HUB_ID,
  type MultiPathResult,
  type MultiPathStats,
  type MultiSegment,
  type TLEndpoint,
} from "@/lib/tunnel-multi";

const SPRINT_BLOCKS_PER_SEC = 7;

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

function StatRow({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="space-y-0.5 border-b border-border/50 py-1.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="font-mono text-sm tabular-nums">{value}</span>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">{description}</p>
    </div>
  );
}

interface StatsCardProps {
  stats: MultiPathStats;
  result: MultiPathResult;
  endpoints: TLEndpoint[];
}

function segmentLabel(seg: MultiSegment, byId: Map<string, TLEndpoint>, hubLabel: string): string {
  const aLabel = byId.get(seg.fromId)?.label?.trim() || seg.fromId;
  const bLabel = seg.toId === HUB_ID ? hubLabel : byId.get(seg.toId)?.label?.trim() || seg.toId;
  return `${aLabel} → ${bLabel}`;
}

export function StatsCard({ stats, result, endpoints }: StatsCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const byId = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);
  const hubLabel = t("tools.tunnel.hubMarker");

  const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : "—");
  const tunnelSeconds = stats.totalWalkable / SPRINT_BLOCKS_PER_SEC;
  const directSeconds = stats.totalStraightLine / SPRINT_BLOCKS_PER_SEC;
  const overheadSeconds = Math.max(0, tunnelSeconds - directSeconds);
  const tunnelTime = formatDuration(tunnelSeconds);
  const directTime = formatDuration(directSeconds);
  const overheadTime = formatDuration(overheadSeconds);
  const showLongest = result.segments.length > 1;
  const showSlabs = stats.totalSlabs > 0;

  return (
    <div className="space-y-1 rounded-md border bg-background p-3">
      <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionStats")}</h2>
      <StatRow
        label={t("tools.tunnel.statTotalBlocks")}
        value={String(stats.totalBlocks)}
        description={t("tools.tunnel.statTotalBlocksHint")}
      />
      {showLongest && (
        <StatRow
          label={t("tools.tunnel.statLongestBranch")}
          value={`${stats.longestSegmentBlocks} ${t("tools.tunnel.unitBlocks")}`}
          description={t("tools.tunnel.statLongestBranchHint")}
        />
      )}
      {showSlabs && (
        <StatRow
          label={t("tools.tunnel.statSlabBlocks")}
          value={`${stats.totalSlabs} / ${stats.totalBlocks - stats.totalSlabs}`}
          description={t("tools.tunnel.statSlabBlocksHint")}
        />
      )}
      <StatRow
        label={t("tools.tunnel.statStraightLine")}
        value={`${fmt(stats.totalStraightLine, 1)} ${t("tools.tunnel.unitBlocks")}`}
        description={t("tools.tunnel.statStraightLineHint")}
      />
      <StatRow
        label={t("tools.tunnel.statTraverseTime")}
        value={overheadSeconds > 0 ? `${tunnelTime} (+${overheadTime})` : tunnelTime}
        description={t("tools.tunnel.statTraverseTimeHint", {
          directTime,
          sprintingSpeed: SPRINT_BLOCKS_PER_SEC,
        })}
      />

      {result.segments.length > 1 && (
        <details
          className="border-t border-border/60 pt-2 group"
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground select-none">
            {t("tools.tunnel.statsBreakdownToggle")}
          </summary>
          {open && (
            <table className="mt-2 w-full text-[11px]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-normal">
                    {t("tools.tunnel.statsBreakdownSegmentCol")}
                  </th>
                  <th className="text-right font-normal">
                    {t("tools.tunnel.statsBreakdownBlocksCol")}
                  </th>
                  <th className="text-right font-normal">
                    {t("tools.tunnel.statsBreakdownDriftCol")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.segments.map((seg) => {
                  const segStats = stats.perSegment.get(seg.key);
                  if (!segStats) return null;
                  return (
                    <tr key={seg.key} className="border-t border-border/50">
                      <td className="py-1 pr-2 truncate">{segmentLabel(seg, byId, hubLabel)}</td>
                      <td className="py-1 text-right font-mono tabular-nums">
                        {segStats.totalBlocks}
                      </td>
                      <td className="py-1 text-right font-mono tabular-nums">
                        {fmt(segStats.maxDeviation, 2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </details>
      )}
    </div>
  );
}
