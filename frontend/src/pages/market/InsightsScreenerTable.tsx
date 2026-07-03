// Generic, virtualized, sortable table for the Market Insights screener. Mirrors
// the windowing approach of `VirtualListingsTable` (which is typed to
// `AuctionListing`) but is generic over the row type and adds click-to-sort
// headers, since the insights screener can list hundreds of items.

import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ScreenerColumn<T> {
  key: string;
  header: ReactNode;
  /** CSS grid track size, e.g. "minmax(8rem,1fr)" or "5rem". */
  width: string;
  align?: "left" | "right";
  /** Rendered cell content. */
  cell: (row: T) => ReactNode;
  /** Sort value; omit to make the column non-sortable. `null` sorts last. */
  sortValue?: (row: T) => number | string | null;
  /** Tooltip shown on the header. */
  title?: string;
}

const ROW_HEIGHT = 40;

interface ScreenerTableProps<T> {
  rows: T[];
  columns: ScreenerColumn<T>[];
  rowKey: (row: T) => string | number;
  /** Initial sort column key. */
  defaultSortKey?: string;
  defaultSortDir?: "asc" | "desc";
  maxHeightClass?: string;
  onRowClick?: (row: T) => void;
  /** Minimum content width (CSS length) that forces horizontal scroll. */
  minWidth?: string;
}

function compare(a: number | string | null, b: number | string | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function ScreenerTable<T>({
  rows,
  columns,
  rowKey,
  defaultSortKey,
  defaultSortDir = "desc",
  maxHeightClass = "max-h-[70vh]",
  onRowClick,
  minWidth = "1200px",
}: ScreenerTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDir);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const withVal = rows.map((r) => ({ r, v: col.sortValue!(r) }));
    withVal.sort((x, y) => {
      // Nulls always sort to the bottom, regardless of direction.
      if (x.v == null || y.v == null) return compare(x.v, y.v);
      return compare(x.v, y.v) * dir;
    });
    return withVal.map((x) => x.r);
  }, [rows, columns, sortKey, sortDir]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });
  const gridTemplate = columns.map((c) => c.width).join(" ");

  function toggleSort(col: ScreenerColumn<T>) {
    if (!col.sortValue) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir("desc");
    }
  }

  return (
    <div className="rounded-md border overflow-hidden">
      <div ref={parentRef} className={cn("overflow-auto", maxHeightClass)}>
        <div style={{ minWidth }}>
          {/* Sticky header — shares the scroll container so it stays aligned. */}
          <div
            className="sticky top-0 z-10 grid items-center gap-2 border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns.map((c) => {
              const active = sortKey === c.key;
              const header = (
                <button
                  type="button"
                  onClick={() => toggleSort(c)}
                  className={cn(
                    "flex min-w-0 items-center gap-1",
                    c.align === "right" && "justify-end",
                    c.sortValue ? "cursor-pointer hover:text-foreground" : "cursor-default",
                    active && "text-foreground",
                  )}
                >
                  <span className="truncate">{c.header}</span>
                  {c.sortValue ? (
                    active ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="size-3 shrink-0" />
                      ) : (
                        <ArrowDown className="size-3 shrink-0" />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3 shrink-0 opacity-40" />
                    )
                  ) : null}
                </button>
              );
              return c.title ? (
                <Tooltip key={c.key}>
                  <TooltipTrigger render={header} />
                  <TooltipContent>{c.title}</TooltipContent>
                </Tooltip>
              ) : (
                <Fragment key={c.key}>{header}</Fragment>
              );
            })}
          </div>

          {/* Virtualized body */}
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const row = sorted[vr.index];
              return (
                <div
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "absolute left-0 top-0 grid w-full items-center gap-2 border-b border-border/60 px-3 text-sm",
                    onRowClick && "cursor-pointer hover:bg-muted/50",
                  )}
                  style={{
                    height: `${vr.size}px`,
                    transform: `translateY(${vr.start}px)`,
                    gridTemplateColumns: gridTemplate,
                  }}
                >
                  {columns.map((c) => (
                    <span
                      key={c.key}
                      className={cn(
                        "min-w-0 truncate",
                        c.align === "right" && "text-right tabular-nums",
                      )}
                    >
                      {c.cell(row)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
