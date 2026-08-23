// Virtualized, collapsible "Market concentration" table for a player profile.
//
// A prolific trader can dominate dozens of items, so the rows are windowed with
// @tanstack/react-virtual and the whole panel collapses to keep the profile
// tidy. Columns are laid out on a fixed grid template so figures line up rather
// than drifting into one big gap.

import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DominanceTier, PlayerDominanceRow } from "@/models/auction";

const DOMINANCE_TIER: Record<
  DominanceTier,
  { label: string; variant: "secondary" | "destructive" | "default" }
> = {
  leading: { label: "Leading", variant: "secondary" },
  dominant: { label: "Dominant", variant: "default" },
  monopoly: { label: "Monopoly", variant: "destructive" },
};

const ROW_HEIGHT = 40;
// Item | Side | Share | Player/Market units | Concentration
const GRID = "minmax(7rem,1fr) 5rem 4.5rem minmax(6rem,7rem) 7rem";

// Persist the user's collapse preference across profiles and reloads.
const STORAGE_KEY = "market.concentrationExpanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function PlayerDominanceTable({ rows }: { rows: PlayerDominanceRow[] }) {
  const [open, setOpen] = useState(loadExpanded);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        )}
        <h2 className="font-semibold">Market concentration</h2>
        <Badge variant="secondary" className="ml-1">
          {rows.length}
        </Badge>
      </button>
      <p className="mb-2 ml-6 text-xs text-muted-foreground">
        Items where this player moves a large share of the total volume in the window (min 3
        trades).
      </p>

      {open && (
        <div className="rounded-md border">
          {/* Header */}
          <div
            className="grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns: GRID }}
          >
            <span>Item</span>
            <span>Side</span>
            <span className="text-right">Share</span>
            <span className="text-right">Units (you / mkt)</span>
            <span className="text-right">Concentration</span>
          </div>
          {/* Virtualized body */}
          <div ref={parentRef} className="max-h-80 overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index];
                const tier = DOMINANCE_TIER[row.tier];
                return (
                  <Link
                    key={`${row.itemId}-${row.side}`}
                    to={`/market/items/${row.itemId}`}
                    className="grid items-center gap-2 px-3 text-sm hover:bg-accent/50 transition-colors"
                    style={{
                      gridTemplateColumns: GRID,
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <span className="truncate text-primary hover:underline" title={row.name}>
                      {row.name}
                    </span>
                    <span>
                      <Badge variant="outline">{row.side === "sell" ? "Selling" : "Buying"}</Badge>
                    </span>
                    <span className="text-right tabular-nums font-medium">
                      {(row.share * 100).toFixed(0)}%
                    </span>
                    <span
                      className="text-right tabular-nums text-muted-foreground"
                      title={`${row.playerTrades} trade${row.playerTrades === 1 ? "" : "s"} · ${
                        row.otherTraders
                      } other trader${row.otherTraders === 1 ? "" : "s"}`}
                    >
                      {row.playerUnits.toLocaleString()} / {row.marketUnits.toLocaleString()}
                    </span>
                    <span className="text-right">
                      <Badge variant={tier.variant}>{tier.label}</Badge>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
