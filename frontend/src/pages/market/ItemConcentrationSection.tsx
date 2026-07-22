// "Market concentration" for a single item — the mirror image of the player
// profile's dominance table (see `PlayerDominanceTable`). There we ask "which
// items does this player control?"; here we ask "which players control this
// item's selling and buying power?".
//
// Both sides are driven off the item's sold listings in the selected window:
// selling power is the seller side, buying power is the buyer side. A player's
// share is their units moved over the total attributable units on that side, so
// the shares sum to 1 across known traders. The HHI (Herfindahl–Hirschman
// index) summarises how concentrated each side is overall, reusing the same
// tier bands as the Insights screener's "Seller concentration" column.
//
// The min-trades and min-share thresholds are user-adjustable: they only gate
// which players are *listed* as dominant, never the HHI (which always reflects
// the full distribution).

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setMinSharePct, setMinTrades } from "@/store/slices/marketConcentration";
import type { AuctionListing, DominanceTier } from "@/models/auction";

const DOMINANCE_TIER: Record<
  DominanceTier,
  { label: string; variant: "secondary" | "destructive" | "default" }
> = {
  leading: { label: "Leading", variant: "secondary" },
  dominant: { label: "Dominant", variant: "default" },
  monopoly: { label: "Monopoly", variant: "destructive" },
};

type HhiTier = "competitive" | "moderate" | "concentrated" | "monopoly";

const HHI_TIER: Record<
  HhiTier,
  { label: string; variant: "secondary" | "destructive" | "default" }
> = {
  competitive: { label: "Competitive", variant: "secondary" },
  moderate: { label: "Moderate", variant: "secondary" },
  concentrated: { label: "Concentrated", variant: "default" },
  monopoly: { label: "Monopoly", variant: "destructive" },
};

interface ConcRow {
  uid: string;
  name: string;
  units: number;
  trades: number;
  /** Player's share of the side's total attributable units (0–1). */
  share: number;
  /** Distinct other traders on this side (0 → sole participant). */
  otherTraders: number;
  tier: DominanceTier;
}

interface SideResult {
  /** All traders on the side, ranked by share (before the threshold filter). */
  rows: ConcRow[];
  totalUnits: number;
  traderCount: number;
  /** Herfindahl–Hirschman index over the unit-share distribution (0–1). */
  hhi: number | null;
  hhiTier: HhiTier | null;
}

/** Same grip bands as the player-profile dominance table. */
function tierFor(share: number, otherTraders: number): DominanceTier {
  if (otherTraders === 0) return "monopoly";
  if (share >= 0.6) return "dominant";
  return "leading";
}

/** Same HHI bands as `concentrationTierFor` in the Insights engine. */
function hhiTierFor(traderCount: number, hhi: number): HhiTier {
  if (traderCount <= 1) return "monopoly";
  if (hhi > 0.25) return "concentrated";
  if (hhi > 0.15) return "moderate";
  return "competitive";
}

/** Aggregate one side (seller or buyer) of the sold listings into per-player
 *  unit shares plus a concentration index. */
function aggregateSide(
  sold: AuctionListing[],
  uidOf: (l: AuctionListing) => string | null,
  nameOf: (l: AuctionListing) => string | null,
): SideResult {
  const byUid = new Map<string, { name: string; units: number; trades: number }>();
  let totalUnits = 0;
  for (const l of sold) {
    const uid = uidOf(l);
    if (!uid) continue;
    totalUnits += l.qty;
    const e = byUid.get(uid) ?? { name: nameOf(l) ?? uid, units: 0, trades: 0 };
    e.units += l.qty;
    e.trades += 1;
    const nm = nameOf(l);
    if (nm) e.name = nm;
    byUid.set(uid, e);
  }

  const traderCount = byUid.size;
  let hhi: number | null = null;
  if (totalUnits > 0) {
    hhi = 0;
    for (const e of byUid.values()) {
      const share = e.units / totalUnits;
      hhi += share * share;
    }
  }

  const rows: ConcRow[] = [];
  for (const [uid, e] of byUid) {
    const share = totalUnits > 0 ? e.units / totalUnits : 0;
    const otherTraders = traderCount - 1;
    rows.push({
      uid,
      name: e.name,
      units: e.units,
      trades: e.trades,
      share,
      otherTraders,
      tier: tierFor(share, otherTraders),
    });
  }
  rows.sort((a, b) => b.share - a.share || b.units - a.units);

  return {
    rows,
    totalUnits,
    traderCount,
    hhi,
    hhiTier: hhi != null ? hhiTierFor(traderCount, hhi) : null,
  };
}

const GRID = "minmax(6rem,1fr) 4rem minmax(5rem,6rem) 6rem";

function SideTable({
  title,
  side,
  minTrades,
  minShare,
}: {
  title: string;
  side: SideResult;
  minTrades: number;
  minShare: number;
}) {
  const dominant = side.rows.filter((r) => r.trades >= minTrades && r.share >= minShare);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">{title}</h3>
        {side.hhiTier && side.hhi != null ? (
          <Badge
            variant={HHI_TIER[side.hhiTier].variant}
            title={`HHI ${side.hhi.toFixed(3)} · ${side.traderCount} trader${
              side.traderCount === 1 ? "" : "s"
            } · ${side.totalUnits.toLocaleString()} units`}
          >
            {HHI_TIER[side.hhiTier].label} · HHI {side.hhi.toFixed(2)}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">No sales in range</span>
        )}
      </div>

      {dominant.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          {side.traderCount === 0
            ? "No completed trades in this range."
            : "No player clears the current thresholds."}
        </p>
      ) : (
        <div className="rounded-md border">
          <div
            className="grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns: GRID }}
          >
            <span>Player</span>
            <span className="text-right">Share</span>
            <span className="text-right">Units</span>
            <span className="text-right">Grip</span>
          </div>
          <div className="max-h-72 overflow-auto">
            {dominant.map((r) => {
              const tier = DOMINANCE_TIER[r.tier];
              return (
                <Link
                  key={r.uid}
                  to={`/market/players/${encodeURIComponent(r.uid)}`}
                  className="grid items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent/50"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className="truncate text-primary hover:underline" title={r.name}>
                    {r.name}
                  </span>
                  <span className="text-right font-medium tabular-nums">
                    {(r.share * 100).toFixed(0)}%
                  </span>
                  <span
                    className="text-right tabular-nums text-muted-foreground"
                    title={`${r.units.toLocaleString()} units across ${r.trades} trade${
                      r.trades === 1 ? "" : "s"
                    } · ${r.otherTraders} other trader${r.otherTraders === 1 ? "" : "s"}`}
                  >
                    {r.units.toLocaleString()}
                  </span>
                  <span className="text-right">
                    <Badge variant={tier.variant}>{tier.label}</Badge>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Market-concentration panel for one item. `listings` should be the item's
 * listings restricted to the selected window (all forms merged); only sold
 * listings count toward the buy/sell power figures.
 */
export function ItemConcentrationSection({ listings }: { listings: AuctionListing[] }) {
  // User-adjustable thresholds for *listing* a player as dominant. Persisted in
  // the store (root envelope) so they survive reloads and stay in sync across
  // tabs and item pages.
  const dispatch = useAppDispatch();
  const minTrades = useAppSelector((s) => s.marketConcentration.minTrades);
  const minSharePct = useAppSelector((s) => s.marketConcentration.minSharePct);

  const { sell, buy } = useMemo(() => {
    const sold = listings.filter((l) => l.sold && !l.spam);
    return {
      sell: aggregateSide(
        sold,
        (l) => l.sellerUid,
        (l) => l.sellerName,
      ),
      buy: aggregateSide(
        sold,
        (l) => l.buyerUid,
        (l) => l.buyerName,
      ),
    };
  }, [listings]);

  // Nothing to show at all — keep the page tidy on items with no completed sales.
  if (sell.traderCount === 0 && buy.traderCount === 0) return null;

  const minShare = Math.min(1, Math.max(0, minSharePct / 100));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 flex items-center gap-1.5">
          <h2 className="font-semibold">Market concentration</h2>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="What is market concentration?"
                  className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Info className="size-4" />
                </button>
              }
            />
            <PopoverContent className="max-w-xs">
              <p className="text-left">
                Who controls this item's trade in the selected window. A player's share is the units
                they sold (selling power) or bought (buying power) over the total units traded on
                that side. The badge is the Herfindahl–Hirschman index (HHI) — the sum of every
                trader's squared share — a standard measure of how concentrated the market is. The
                thresholds below only decide which players are listed, not the HHI.
              </p>
            </PopoverContent>
          </Popover>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Players moving a large share of this item's completed trades.
        </p>

        {/* Adjustable thresholds */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Min trades
            <Input
              type="number"
              min={1}
              value={minTrades}
              onChange={(e) => dispatch(setMinTrades(Number(e.target.value) || 1))}
              className="h-8 w-16"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Min share
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                max={100}
                value={minSharePct}
                onChange={(e) => dispatch(setMinSharePct(Number(e.target.value) || 0))}
                className="h-8 w-16"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </label>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <SideTable title="Selling power" side={sell} minTrades={minTrades} minShare={minShare} />
          <SideTable title="Buying power" side={buy} minTrades={minTrades} minShare={minShare} />
        </div>
      </CardContent>
    </Card>
  );
}
