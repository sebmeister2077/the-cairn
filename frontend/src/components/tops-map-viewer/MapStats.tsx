import type { MapStats } from "@/components/MapViewer";
import { formatTimestamp } from "@/lib/utils";

export function MapStatsHeader({
  stats,
  generatedAt,
}: {
  stats: MapStats | null;
  generatedAt?: string | null;
}) {
  if (!stats) return null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
      <span>
        <span className="font-medium text-foreground">{stats.pieces.toLocaleString()}</span> map
        chunks
      </span>
      <span>
        <span className="font-medium text-foreground">{stats.size_mb}</span> MB
      </span>
      <span>
        <span className="font-medium text-foreground">
          {stats.width_blocks.toLocaleString()} × {stats.height_blocks.toLocaleString()}
        </span>{" "}
        blocks
      </span>
      <span>
        Last generated{" "}
        <span className="font-medium text-foreground">{formatTimestamp(generatedAt)}</span>
      </span>
    </div>
  );
}
