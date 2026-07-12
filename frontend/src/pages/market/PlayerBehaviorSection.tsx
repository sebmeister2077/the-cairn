// Behaviour panel for the player-profile page: a headline archetype, the
// pricing/buying-style cards behind it, specialization, market-concentration
// ("monopolies"), flips, and the trades that deviated most from market.
//
// All labels are intentionally neutral — they describe trading habits, they
// don't pass judgement on the player.

import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatGameDate } from "./VirtualListingsTable";
import { PLAYER_MIN_TRADES } from "./usePlayerProfile";
import { PlayerDominanceTable } from "./PlayerDominanceTable";
import type {
  BuyerStyle,
  PlayerArchetype,
  PlayerNotableTrade,
  PlayerProfile,
  SellerPricingStyle,
  SpecializationTier,
} from "@/models/auction";

const ARCHETYPE: Record<PlayerArchetype, { label: string; desc: string }> = {
  "price-discoverer": {
    label: "Price Discoverer",
    desc: "Lists the same items across a wide range of prices — probing for what the market will bear.",
  },
  "stable-seller": {
    label: "Stable Seller",
    desc: "Holds consistent prices across their listings.",
  },
  wholesaler: {
    label: "Wholesaler",
    desc: "Sells mainly in large lots.",
  },
  "bargain-seller": {
    label: "Bargain Seller",
    desc: "Tends to list below the market median — good deals for buyers.",
  },
  "value-buyer": {
    label: "Value Buyer",
    desc: "Tends to buy below the market median.",
  },
  "eager-buyer": {
    label: "Eager Buyer",
    desc: "Often pays above the market median to secure items.",
  },
  "market-maker": {
    label: "Market Maker",
    desc: "Actively trades both sides — buying and selling in volume.",
  },
  monopolist: {
    label: "Monopolist",
    desc: "Controls a large share of one or more items' supply.",
  },
  flipper: {
    label: "Flipper",
    desc: "Buys items and resells them at a higher price.",
  },
  specialist: {
    label: "Specialist",
    desc: "Concentrates on a narrow set of items.",
  },
  generalist: {
    label: "Generalist",
    desc: "Trades a broad variety of items.",
  },
  newcomer: {
    label: "Newcomer",
    desc: `Not enough trades yet to characterise (needs ${PLAYER_MIN_TRADES}+).`,
  },
};

/** Display order for the "what do these labels mean?" popover. */
const ARCHETYPE_ORDER: PlayerArchetype[] = [
  "market-maker",
  "monopolist",
  "flipper",
  "wholesaler",
  "price-discoverer",
  "stable-seller",
  "bargain-seller",
  "value-buyer",
  "eager-buyer",
  "specialist",
  "generalist",
  "newcomer",
];

const SELLER_STYLE: Record<SellerPricingStyle, string> = {
  stable: "Stable pricing",
  adjusting: "Adjusts prices",
  discoverer: "Price discovery",
  insufficient: "Not enough data",
};

const BUYER_STYLE: Record<BuyerStyle, string> = {
  value: "Buys below market",
  market: "Buys around market",
  eager: "Buys above market",
  insufficient: "Not enough data",
};

const SPECIALIZATION: Record<SpecializationTier, string> = {
  specialist: "Specialist",
  focused: "Focused",
  generalist: "Generalist",
};

/** Neutral "±X% vs market" phrasing for a median premium. */
function premiumPhrase(pct: number | null, below: string, above: string): string {
  if (pct == null) return "—";
  if (Math.abs(pct) < 1) return "At market median";
  return pct < 0 ? `${below} ${Math.abs(pct).toFixed(0)}%` : `${above} ${pct.toFixed(0)}%`;
}

interface InfoItem {
  term: string;
  desc: string;
}

/** Small "ⓘ" trigger that opens a popover explaining the values a card can show. */
function InfoPopover({
  title,
  intro,
  items,
  align = "end",
}: {
  title: string;
  intro?: string;
  items: InfoItem[];
  align?: "start" | "center" | "end";
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={title}
            title={title}
          >
            <Info className="size-4" aria-hidden />
          </button>
        }
      />
      <PopoverContent align={align} className="w-80 max-h-96 overflow-auto">
        <p className="mb-2 text-sm font-medium">{title}</p>
        {intro ? <p className="mb-3 text-xs text-muted-foreground">{intro}</p> : null}
        <dl className="space-y-2">
          {items.map((it) => (
            <div key={it.term}>
              <dt className="text-sm font-medium">{it.term}</dt>
              <dd className="text-xs text-muted-foreground">{it.desc}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

/** A StatCard-styled tile with an info popover explaining its possible values. */
function BehaviorCard({
  label,
  value,
  hint,
  info,
}: {
  label: string;
  value: string;
  hint?: string;
  info: { title: string; intro?: string; items: InfoItem[] };
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm text-muted-foreground">{label}</div>
          <InfoPopover {...info} />
        </div>
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

// Explanations for each behaviour card's possible values.
const SELLER_PRICING_INFO: InfoItem[] = [
  { term: "Stable pricing", desc: "Holds consistent per-unit prices across their listings." },
  { term: "Adjusts prices", desc: "Moderate variation — nudges prices up and down over time." },
  {
    term: "Price discovery",
    desc: "Wide price spread on the same items — probing for what the market will bear.",
  },
  { term: "Not enough data", desc: "Too few comparable listings to judge a pricing style." },
];

const BUYER_BEHAVIOUR_INFO: InfoItem[] = [
  { term: "Buys below market", desc: "Their median purchase paid under the market median price." },
  { term: "Buys around market", desc: "Their median purchase sat near the market median." },
  {
    term: "Buys above market",
    desc: "Their median purchase paid over the market median — often to secure items quickly.",
  },
  { term: "Not enough data", desc: "Too few priced purchases with a market reference to judge." },
];

const SALE_PRICES_INFO: InfoItem[] = [
  {
    term: "Below by X%",
    desc: "On average they list under the market median — good deals for buyers.",
  },
  { term: "At market median", desc: "Their listings sit in line with the going rate." },
  { term: "Above by X%", desc: "On average they list above the market median." },
  {
    term: "How it's measured",
    desc: "Median of their sold listings compared to the market median price at the time each was posted.",
  },
];

const SPECIALIZATION_INFO: InfoItem[] = [
  { term: "Specialist", desc: "Concentrates on a narrow set of items." },
  { term: "Focused", desc: "Trades a moderate range of items." },
  { term: "Generalist", desc: "Trades a broad variety of items." },
  {
    term: "How it's measured",
    desc: "Concentration of their trades across items (plus their most-active category).",
  },
];

function NotableTradeList({ trades }: { trades: PlayerNotableTrade[] }) {
  return (
    <div className="rounded-md border divide-y">
      {trades.map((t) => {
        const sign = t.premiumPct >= 0 ? "+" : "";
        return (
          <Link
            key={t.auctionId}
            to={`/market/items/${t.itemId}`}
            className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
            title={`${t.pricePerUnit.toLocaleString()} vs market ${t.refPricePerUnit.toLocaleString()} · ${formatGameDate(
              t.postedTotalHours,
            )}`}
          >
            <span className="truncate text-primary hover:underline">{t.variant || t.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {sign}
              {t.premiumPct.toFixed(0)}%
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function PlayerBehaviorSection({ profile }: { profile: PlayerProfile }) {
  const enoughData = !profile.archetypes.includes("newcomer");

  return (
    <div className="space-y-4">
      {/* Headline archetype(s) — a trader can be several things at once. */}
      <div className="rounded-md border bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {profile.archetypes.map((a) => (
            <Badge key={a} className="text-sm">
              {ARCHETYPE[a].label}
            </Badge>
          ))}
          <span className="ml-auto">
            <InfoPopover
              title="Player labels"
              intro="A player gets every label that fits their trading habits — they can hold several at once. Descriptive, not judgements."
              items={ARCHETYPE_ORDER.map((key) => ({
                term: ARCHETYPE[key].label,
                desc: ARCHETYPE[key].desc,
              }))}
            />
          </span>
        </div>
        <ul className="mt-2 space-y-1">
          {profile.archetypes.map((a) => (
            <li key={a} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{ARCHETYPE[a].label}:</span>{" "}
              {ARCHETYPE[a].desc}
            </li>
          ))}
        </ul>
      </div>

      {enoughData && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <BehaviorCard
              label="Seller pricing"
              value={SELLER_STYLE[profile.sellerStyle]}
              hint={
                profile.sellerPriceCV != null
                  ? `Price spread (CV) ${(profile.sellerPriceCV * 100).toFixed(0)}%`
                  : undefined
              }
              info={{ title: "Seller pricing", items: SELLER_PRICING_INFO }}
            />
            <BehaviorCard
              label="Buyer behaviour"
              value={BUYER_STYLE[profile.buyerStyle]}
              hint={
                profile.buyerMedianPremiumPct != null
                  ? premiumPhrase(
                      profile.buyerMedianPremiumPct,
                      "Median pays under",
                      "Median pays over",
                    )
                  : undefined
              }
              info={{ title: "Buyer behaviour", items: BUYER_BEHAVIOUR_INFO }}
            />
            <BehaviorCard
              label="Sale prices vs market"
              value={premiumPhrase(profile.sellerMedianPremiumPct, "Below by", "Above by")}
              hint="Median of their sales vs the market median"
              info={{ title: "Sale prices vs market", items: SALE_PRICES_INFO }}
            />
            <BehaviorCard
              label="Specialization"
              value={SPECIALIZATION[profile.specialization]}
              hint={
                profile.topCategory
                  ? `Most active: ${profile.topCategory}${
                      profile.topCategoryShare != null
                        ? ` (${(profile.topCategoryShare * 100).toFixed(0)}%)`
                        : ""
                    }`
                  : undefined
              }
              info={{ title: "Specialization", items: SPECIALIZATION_INFO }}
            />
          </div>

          {/* Market concentration / monopolies */}
          {profile.dominance.length > 0 && <PlayerDominanceTable rows={profile.dominance} />}

          {/* Flips */}
          {profile.flips.length > 0 && (
            <div>
              <h2 className="font-semibold mb-1">Flips</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Items the player both buys and sells — median buy vs median sell price.
              </p>
              <div className="rounded-md border divide-y">
                {profile.flips.slice(0, 8).map((f) => (
                  <div
                    key={f.itemId}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-1.5 text-sm"
                  >
                    <Link
                      to={`/market/items/${f.itemId}`}
                      className="truncate text-primary hover:underline"
                    >
                      {f.name}
                    </Link>
                    <span className="tabular-nums text-muted-foreground">
                      {f.buyMedianPpu.toLocaleString()} → {f.sellMedianPpu.toLocaleString()}
                      <span
                        className={
                          f.marginPct >= 0
                            ? "ml-2 text-emerald-600 dark:text-emerald-400"
                            : "ml-2 text-red-600 dark:text-red-400"
                        }
                      >
                        {f.marginPct >= 0 ? "+" : ""}
                        {f.marginPct.toFixed(0)}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Best / worst trades vs market */}
          {(profile.overpriced.length > 0 || profile.underpriced.length > 0) && (
            <div className="grid md:grid-cols-2 gap-4">
              {profile.overpriced.length > 0 && (
                <div>
                  <h2 className="font-semibold mb-2">Sold furthest above market</h2>
                  <NotableTradeList trades={profile.overpriced} />
                </div>
              )}
              {profile.underpriced.length > 0 && (
                <div>
                  <h2 className="font-semibold mb-2">Sold furthest below market</h2>
                  <NotableTradeList trades={profile.underpriced} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
