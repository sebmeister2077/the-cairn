import type { MapStats } from "@/components/MapViewer";

export function MapStatsHeader({ stats }: { stats: MapStats | null }) {
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
    </div>
  );
}
