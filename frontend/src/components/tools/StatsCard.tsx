// Read-only stats panel for the current path.

import { useTranslation } from "@/lib/i18n";
import type { PathStats } from "@/lib/tunnel-pattern";

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/50 py-1 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function StatsCard({ stats }: { stats: PathStats }) {
  const { t } = useTranslation();
  const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : "—");
  return (
    <div className="space-y-1 rounded-md border bg-background p-3">
      <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionStats")}</h2>
      <StatRow label={t("tools.tunnel.statTotalBlocks")} value={String(stats.totalBlocks)} />
      <StatRow
        label={t("tools.tunnel.statStraightLine")}
        value={fmt(stats.straightLineBlocks, 1)}
      />
      <StatRow
        label={t("tools.tunnel.statLengthRatio")}
        value={`${fmt(stats.lengthRatio * 100, 1)}%`}
      />
      <StatRow label={t("tools.tunnel.statMaxDeviation")} value={fmt(stats.maxDeviation, 2)} />
      <StatRow label={t("tools.tunnel.statRmsDeviation")} value={fmt(stats.rmsDeviation, 2)} />
    </div>
  );
}
