// Read-only stats panel for the current path.

import { useTranslation } from "@/lib/i18n";
import type { PathStats } from "@/lib/tunnel-pattern";

// Sprint speed in Vintage Story (blocks per second). Used to convert
// block counts into a wall-clock estimate so the "tunnel vs. flying
// straight" cost is concrete instead of abstract.
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

export function StatsCard({ stats }: { stats: PathStats }) {
  const { t } = useTranslation();
  const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : "—");
  const tunnelSeconds = stats.walkableLength / SPRINT_BLOCKS_PER_SEC;
  const directSeconds = stats.straightLineBlocks / SPRINT_BLOCKS_PER_SEC;
  const overheadSeconds = Math.max(0, tunnelSeconds - directSeconds);
  const tunnelTime = formatDuration(tunnelSeconds);
  const directTime = formatDuration(directSeconds);
  const overheadTime = formatDuration(overheadSeconds);
  return (
    <div className="space-y-1 rounded-md border bg-background p-3">
      <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionStats")}</h2>
      <StatRow
        label={t("tools.tunnel.statTotalBlocks")}
        value={String(stats.totalBlocks)}
        description={t("tools.tunnel.statTotalBlocksHint")}
      />
      {stats.slabBlocks > 0 && (
        <StatRow
          label={t("tools.tunnel.statSlabBlocks")}
          value={`${stats.slabBlocks} / ${stats.totalBlocks - stats.slabBlocks}`}
          description={t("tools.tunnel.statSlabBlocksHint")}
        />
      )}
      <StatRow
        label={t("tools.tunnel.statStraightLine")}
        value={`${fmt(stats.straightLineBlocks, 1)} ${t("tools.tunnel.unitBlocks")}`}
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
      <StatRow
        label={t("tools.tunnel.statMaxDeviation")}
        value={`${fmt(stats.maxDeviation, 2)} ${t("tools.tunnel.unitBlocks")}`}
        description={t("tools.tunnel.statMaxDeviationHint")}
      />
      <StatRow
        label={t("tools.tunnel.statRmsDeviation")}
        value={`${fmt(stats.rmsDeviation, 2)} ${t("tools.tunnel.unitBlocks")}`}
        description={t("tools.tunnel.statRmsDeviationHint")}
      />
    </div>
  );
}
