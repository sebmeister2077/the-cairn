import { useMemo } from "react";

interface Cell {
  day_of_week: number;
  hour: number;
  count: number;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 7 × 24 grid of buckets — rows are days of the week, columns are hours.
 *
 * Color intensity scales linearly with the bucket's share of the max
 * value in the dataset. Empty cells stay neutral so sparse windows
 * don't render as a wall of color.
 */
export function HeatmapGrid({ cells }: { cells: Cell[] }) {
  const grid = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const c of cells) {
      if (c.day_of_week < 0 || c.day_of_week > 6) continue;
      if (c.hour < 0 || c.hour > 23) continue;
      g[c.day_of_week][c.hour] = c.count;
      if (c.count > max) max = c.count;
    }
    return { g, max };
  }, [cells]);

  if (grid.max === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">No activity in window.</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="px-1 py-0.5" />
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="px-1 py-0.5 text-muted-foreground font-normal w-6">
                {h % 3 === 0 ? h : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.g.map((row, dow) => (
            <tr key={dow}>
              <th className="pr-2 py-0.5 text-right text-muted-foreground font-normal">
                {DAY_LABELS[dow]}
              </th>
              {row.map((v, h) => (
                <td
                  key={h}
                  className="border border-white/40 w-6 h-5"
                  style={{ backgroundColor: shade(v, grid.max) }}
                  title={`${DAY_LABELS[dow]} ${h.toString().padStart(2, "0")}:00 — ${v} events`}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shade(v: number, max: number): string {
  if (v === 0) return "#f3f4f6";
  const ratio = Math.min(1, v / max);
  // Blend white → blue-600.
  const r = Math.round(255 + (37 - 255) * ratio);
  const g = Math.round(255 + (99 - 255) * ratio);
  const b = Math.round(255 + (235 - 255) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}
