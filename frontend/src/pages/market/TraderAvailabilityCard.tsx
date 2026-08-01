import { Coins } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { lookupTraderInfo } from "@/lib/trader-wares";
import { TRADER_TYPE_COLORS, TRADER_TYPE_LABELS, type TraderType } from "@/lib/trader-types";
import type { TraderWarePrice } from "@/models/trader-wares";

// Named village NPCs (Nadiya villagers like Alba, Tobias) share one colour.
const VILLAGER_COLOR = "#6366f1"; // indigo-500

function traderName(w: TraderWarePrice): string {
  return w.label ?? TRADER_TYPE_LABELS[w.traderType as TraderType];
}

function traderColor(w: TraderWarePrice): string {
  return w.traderType === "villager" ? VILLAGER_COLOR : TRADER_TYPE_COLORS[w.traderType];
}

/** In-game gears range: prices are whole gears, so the realised span is
 *  floor(min)..ceil(max) — matching what the game/handbook shows. */
function priceRange(w: TraderWarePrice): string {
  const lo = Math.floor(w.priceMin);
  const hi = Math.ceil(w.priceMax);
  return lo === hi ? `${lo}⚙` : `${lo}–${hi}⚙`;
}

function WareRow({ ware }: { ware: TraderWarePrice }) {
  const qty = ware.stacksize && ware.stacksize > 1 ? ware.stacksize : null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: traderColor(ware) }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{traderName(ware)}</span>
      {qty ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          ×{qty}
        </span>
      ) : null}
      <span className="shrink-0 font-medium tabular-nums">{priceRange(ware)}</span>
    </div>
  );
}

function Direction({ label, wares }: { label: string; wares: TraderWarePrice[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {wares.map((w) => (
        <WareRow key={`${label}-${w.traderType}-${w.label ?? ""}`} ware={w} />
      ))}
    </div>
  );
}

/** Shows which trader professions sell/buy this item, the quantity per trade and
 *  the price interval. Renders nothing when no trader deals in the item. */
export function TraderAvailabilityCard({ code }: { code: string | null | undefined }) {
  const info = lookupTraderInfo(code);
  if (!info) return null;

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 py-3">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Coins className="size-4" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Traders</h2>
          <span className="ml-auto text-xs">qty · price</span>
        </div>
        {info.sells?.length ? <Direction label="Buy from" wares={info.sells} /> : null}
        {info.buys?.length ? <Direction label="Sell to" wares={info.buys} /> : null}
      </CardContent>
    </Card>
  );
}
