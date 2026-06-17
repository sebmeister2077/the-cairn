// Read-only preview table of waypoint records with optional per-row
// include/exclude toggles. Rows are virtualized so very large lists
// (thousands of translocator endpoints) render fully without lag.

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { WaypointRecord } from "@/lib/waypoint-macro";

interface WaypointRecordTableProps {
  records: WaypointRecord[];
  /** Whether to render the id column (chat-log uploads have ids). */
  showId?: boolean;
  /** Stable per-row key. Required to enable the include/exclude column. */
  rowKey?: (wp: WaypointRecord, index: number) => string;
  /** Keys that are excluded from the final output. */
  excludedKeys?: ReadonlySet<string>;
  /** Toggle a single row's excluded state. */
  onToggleExclude?: (key: string) => void;
}

const ROW_HEIGHT = 36;

export function WaypointRecordTable({
  records,
  showId = false,
  rowKey,
  excludedKeys,
  onToggleExclude,
}: WaypointRecordTableProps) {
  const selectable = Boolean(rowKey && onToggleExclude);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Shared column template so the header and every row line up.
  const gridTemplate = [
    selectable ? "4rem" : null,
    showId ? "3rem" : null,
    "minmax(8rem,1fr)",
    "4rem",
    "4rem",
    "4rem",
    "6rem",
    "7rem",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rounded-lg border border-border">
      {/* Header */}
      <div
        className="grid items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {selectable && <span>Include</span>}
        {showId && <span>Id</span>}
        <span className="min-w-0">Name</span>
        <span className="text-right">X</span>
        <span className="text-right">Y</span>
        <span className="text-right">Z</span>
        <span className="min-w-0">Icon</span>
        <span className="min-w-0">Color</span>
      </div>

      {/* Virtualized body */}
      <div ref={parentRef} className="max-h-96 overflow-auto">
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const wp = records[virtualRow.index];
            const key = rowKey?.(wp, virtualRow.index);
            const excluded = key !== undefined && excludedKeys?.has(key);
            return (
              <div
                key={key ?? wp.id ?? `${wp.x},${wp.z},${virtualRow.index}`}
                className="absolute left-0 top-0 grid w-full items-center gap-2 border-b border-border/60 px-3 text-sm"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  gridTemplateColumns: gridTemplate,
                }}
              >
                {selectable && (
                  <span className="flex items-center justify-center">
                    <Checkbox
                      checked={!excluded}
                      onCheckedChange={() => key !== undefined && onToggleExclude?.(key)}
                      aria-label={excluded ? "Include this waypoint" : "Exclude this waypoint"}
                    />
                  </span>
                )}
                {showId && (
                  <span className={cn("tabular-nums", excluded && "opacity-40")}>{wp.id}</span>
                )}
                <span
                  className={cn("min-w-0 truncate", excluded && "opacity-40 line-through")}
                  title={wp.name}
                >
                  {wp.name}
                </span>
                <span className={cn("text-right tabular-nums", excluded && "opacity-40")}>
                  {wp.x}
                </span>
                <span className={cn("text-right tabular-nums", excluded && "opacity-40")}>
                  {wp.y ?? "—"}
                </span>
                <span className={cn("text-right tabular-nums", excluded && "opacity-40")}>
                  {wp.z}
                </span>
                <span className={cn("min-w-0 truncate", excluded && "opacity-40")}>{wp.icon}</span>
                <span
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 overflow-hidden",
                    excluded && "opacity-40",
                  )}
                >
                  <span
                    className="inline-block size-3 shrink-0 rounded-full ring-1 ring-foreground/20"
                    style={{ backgroundColor: wp.color }}
                  />
                  <span className="truncate text-xs text-muted-foreground">{wp.color}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {records.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No waypoints to show.</p>
      )}
    </div>
  );
}
