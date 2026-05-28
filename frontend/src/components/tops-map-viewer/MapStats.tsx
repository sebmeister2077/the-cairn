import type { MapStats } from "@/components/MapViewer";
import { useTranslation } from "@/lib/i18n";
import { formatTimestamp } from "@/lib/utils";

export function MapStatsHeader({
  stats,
  generatedAt,
}: {
  stats: MapStats | null;
  generatedAt?: string | null;
}) {
  const { t } = useTranslation();
  if (!stats) return null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
      <span>
        <span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span>{" "}
        {t("topsMap.mapChunks")}
      </span>
      <span>
        <span className="font-medium text-foreground">{stats.size_mb}</span> MB
      </span>
      <span>
        <span className="font-medium text-foreground">
          {stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}
        </span>{" "}
        {t("topsMap.blocks")}
      </span>
      <span>
        {t("topsMap.lastGenerated")}{" "}
        <span className="font-medium text-foreground">{formatTimestamp(generatedAt)}</span>
      </span>
    </div>
  );
}
