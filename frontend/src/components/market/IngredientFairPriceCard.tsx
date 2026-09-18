import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  formatGears,
  humanizeItemCode,
  percentileSorted,
  weightedMedian,
  listingHasText,
  resolveItemFamily,
  metalUnitsForEntry,
  METAL_FAMILY_KEYS,
} from "@/lib/auction";
import { filterListingsByWindow, confidenceFor } from "@/hooks/useMarketInsights";
import { lookupRecipes, type RecipeDef } from "@/lib/recipes";
import { cn } from "@/lib/utils";
import type { AuctionListing, ItemCatalog, ConfidenceTier } from "@/models/auction";
import type { MarketPriceMode } from "@/hooks/useMarketPriceMode";

/** Bare item code: drop an asset domain prefix (`game:leather` -> `leather`). */
function bareCode(code: string): string {
  return code.includes(":") ? code.split(":").pop()!.trim() : code;
}

/** Statistical confidence in an ingredient's price. `none` = no data at all. */
type Conf = ConfidenceTier | "none";
const CONF_RANK: Record<Conf, number> = { none: 0, low: 1, medium: 2, high: 3 };
const RANK_CONF: Conf[] = ["none", "low", "medium", "high"];
/** How deep to chase a missing ingredient's own recipe (guards runaway chains). */
const MAX_DERIVE_DEPTH = 4;

/** A resolved per-unit price for one code: from direct sales, a sub-recipe, or a
 *  blended metal-content estimate. `note` explains a `derived` (estimated) price. */
type ResolvePoint = {
  price: number | null;
  itemId: number | null;
  confidence: Conf;
  derived: boolean;
  note?: string;
};

/** Dot colour + label for each confidence tier, shown per ingredient. */
const CONF_META: Record<Conf, { dot: string; label: string }> = {
  high: { dot: "bg-emerald-500", label: "High confidence" },
  medium: { dot: "bg-amber-500", label: "Medium confidence" },
  low: { dot: "bg-red-500", label: "Low confidence" },
  none: { dot: "bg-muted-foreground/40", label: "No price data" },
};

/** A confidence dot with a tooltip; ringed when the price was derived. */
function ConfDot({
  confidence,
  derived,
  note,
}: {
  confidence: Conf;
  derived: boolean;
  note?: string;
}) {
  const meta = CONF_META[confidence];
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        meta.dot,
        derived && "ring-1 ring-foreground/40",
      )}
      title={derived ? `${meta.label} · ${note ?? "estimated from its own recipe"}` : meta.label}
    />
  );
}

interface PricedIngredient {
  code: string;
  name: string;
  /** A representative itemId to link to, when the ingredient is in the catalog. */
  itemId: number | null;
  quantity: number;
  /** Median / weighted per-unit price (direct or derived), or null when unknown. */
  unitPrice: number | null;
  /** `unitPrice × quantity`, or null when unpriced. */
  subtotal: number | null;
  /** Confidence in `unitPrice` (derived = its worst sub-ingredient's). */
  confidence: Conf;
  /** True when the price was derived from this ingredient's own recipe, not sales. */
  derived: boolean;
  /** For a derived/estimated price, a short note on how it was estimated. */
  derivedNote?: string;
}

interface CostedRecipe {
  ingredients: PricedIngredient[];
  /** Fair price for ONE crafted item (sum of known subtotals ÷ output). */
  perItem: number;
  /** Ingredients that had no price at all (so the estimate is a partial floor). */
  missing: number;
  /** Total distinct ingredient lines. */
  total: number;
  /** Overall confidence: the lowest among the priced ingredients. */
  confidence: Conf;
  /** Whether any ingredient price was derived from a sub-recipe. */
  anyDerived: boolean;
}

/**
 * "Fair price from ingredients" — an item's estimated value as the summed market
 * price of what it's crafted from (from the bundled grid-recipe dataset). Useful
 * for goods that add little beyond their materials: a sturdy leather backpack is
 * essentially its leather, a crafted tool its parts. When an item has several
 * recipes, the cheapest fully-priced one is shown. Ingredients with no market
 * data are listed but can't be valued, so the figure is a floor — flagged as
 * such. Renders nothing unless the item is craftable and at least one ingredient
 * has a market price.
 */
export function IngredientFairPriceCard({
  code,
  catalog,
  listings,
  priceMode,
  windowDays,
  smart,
  excludeExternalTrades,
  stackPriced = false,
  stackSize = 1,
  className,
}: {
  code: string | null;
  catalog: ItemCatalog;
  listings: AuctionListing[];
  priceMode: MarketPriceMode;
  windowDays: number | null;
  smart: boolean;
  excludeExternalTrades: boolean;
  /** Mirror the main Fair-price card: show per-stack figures when it does. */
  stackPriced?: boolean;
  stackSize?: number;
  className?: string;
}) {
  const recipes = useMemo(() => lookupRecipes(code), [code]);

  // Reverse index: bare ingredient code -> the catalog itemIds that carry it (so
  // we can price an ingredient and link to its item page).
  const idsByCode = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const [key, e] of Object.entries(catalog)) {
      if (!e.code) continue;
      const bare = bareCode(e.code);
      const list = map.get(bare);
      if (list) list.push(Number(key));
      else map.set(bare, [Number(key)]);
    }
    return map;
  }, [catalog]);

  // Windowed, non-spam sold listings grouped by itemId, for pricing ingredients.
  const soldByItemId = useMemo(() => {
    // Window the full set first so the shared reference clock refreshes from all
    // listings (matches how the item page windows), then keep priced sold sales.
    let base = filterListingsByWindow(listings, windowDays, smart).filter(
      (l) => l.sold && !listingHasText(l),
    );
    if (excludeExternalTrades) base = base.filter((l) => !l.externalTrade);
    const map = new Map<number, AuctionListing[]>();
    for (const l of base) {
      const list = map.get(l.itemId);
      if (list) list.push(l);
      else map.set(l.itemId, [l]);
    }
    return map;
  }, [listings, excludeExternalTrades, windowDays, smart]);

  // itemId -> {metal family, pure-metal units} for every metal form in the
  // catalog, so a metal ingredient (e.g. a lead plate) with no sales can be
  // valued from the metal's other forms ("value by metal content").
  const metalInfoByItemId = useMemo(() => {
    const map = new Map<number, { familyKey: string; units: number }>();
    for (const [key, e] of Object.entries(catalog)) {
      const fam = resolveItemFamily(e);
      if (!fam || !METAL_FAMILY_KEYS.has(fam.key)) continue;
      const units = metalUnitsForEntry(e);
      if (units == null || units <= 0) continue;
      map.set(Number(key), { familyKey: fam.key, units });
    }
    return map;
  }, [catalog]);

  const costed = useMemo<CostedRecipe | null>(() => {
    if (!recipes) return null;

    // Direct market price for a single bare code (pooled across the catalog
    // itemIds that carry it), its confidence (from the sold-sample size) and a
    // representative itemId to link to.
    const priceForCode = (
      bare: string,
    ): { price: number | null; itemId: number | null; confidence: Conf } => {
      const ids = idsByCode.get(bare) ?? [];
      const pooled: AuctionListing[] = [];
      let linkId: number | null = ids[0] ?? null;
      for (const iid of ids) {
        const ls = soldByItemId.get(iid);
        if (ls && ls.length) {
          pooled.push(...ls);
          linkId = iid;
        }
      }
      if (pooled.length === 0) return { price: null, itemId: ids[0] ?? null, confidence: "none" };
      const price =
        priceMode === "weighted"
          ? weightedMedian(pooled.map((l) => ({ value: l.pricePerUnit, weight: l.qty })))
          : percentileSorted(
              pooled.map((l) => l.pricePerUnit).sort((a, b) => a - b),
              0.5,
            );
      return { price, itemId: linkId, confidence: confidenceFor(pooled.length) };
    };

    // The concrete codes a (possibly wildcard) ingredient can be satisfied by.
    const candidatesFor = (ing: { code: string; allowed?: string[] }): string[] => {
      const bare = bareCode(ing.code);
      if (!bare.includes("*")) return [bare];
      const prefix = bare.replace(/\*$/, "");
      if (ing.allowed?.length) return ing.allowed.map((v) => prefix + v);
      return [...idsByCode.keys()].filter((c) => c.startsWith(prefix));
    };

    // Blended "value by metal content" (price per unit of pure metal) per family,
    // from every sold form of that metal, for estimating a metal ingredient that
    // never sold on its own.
    const metalPairsByFamily = new Map<string, { value: number; weight: number }[]>();
    for (const [iid, info] of metalInfoByItemId) {
      const ls = soldByItemId.get(iid);
      if (!ls || !ls.length) continue;
      const arr = metalPairsByFamily.get(info.familyKey) ?? [];
      for (const l of ls)
        arr.push({ value: l.pricePerUnit / info.units, weight: l.qty * info.units });
      metalPairsByFamily.set(info.familyKey, arr);
    }
    const blendedCache = new Map<string, { price: number | null; count: number }>();
    const blendedPerMetalUnit = (familyKey: string): { price: number | null; count: number } => {
      const cached = blendedCache.get(familyKey);
      if (cached) return cached;
      const pairs = metalPairsByFamily.get(familyKey) ?? [];
      let out: { price: number | null; count: number } = { price: null, count: 0 };
      if (pairs.length) {
        const price =
          priceMode === "weighted"
            ? weightedMedian(pairs)
            : percentileSorted(
                pairs.map((p) => p.value).sort((a, b) => a - b),
                0.5,
              );
        out = { price, count: pairs.length };
      }
      blendedCache.set(familyKey, out);
      return out;
    };

    // Estimate a metal code's per-unit price from its metal family's blended
    // content value (its own pure-metal units × the blended price per unit).
    const metalEstimate = (bare: string): ResolvePoint | null => {
      const iid = idsByCode.get(bare)?.[0] ?? null;
      const entry = (iid != null && catalog[String(iid)]) || {
        code: bare,
        name: humanizeItemCode(bare),
        category: bare.includes("-") ? bare.split("-")[0] : bare,
      };
      const fam = resolveItemFamily(entry);
      if (!fam || !METAL_FAMILY_KEYS.has(fam.key)) return null;
      const units = metalUnitsForEntry(entry);
      if (units == null || units <= 0) return null;
      const blended = blendedPerMetalUnit(fam.key);
      if (blended.price == null) return null;
      return {
        price: blended.price * units,
        itemId: iid,
        confidence: confidenceFor(blended.count),
        derived: true,
        note: `estimated from ${fam.label.toLowerCase()} metal-content value`,
      };
    };

    // Resolve one concrete code's per-unit price: first from direct sales, else
    // (recursively) derived from its own recipe's cheapest fully-priced variant,
    // else a blended metal-content estimate for metal forms. A derived price's
    // confidence is its worst sub-ingredient's. `visiting` guards recipe cycles;
    // `depth` caps the derivation chain.
    const resolveCode = (bare: string, depth: number, visiting: Set<string>): ResolvePoint => {
      const direct = priceForCode(bare);
      if (direct.price != null) return { ...direct, derived: false };

      if (depth < MAX_DERIVE_DEPTH && !visiting.has(bare)) {
        const recs = lookupRecipes(bare);
        if (recs && recs.length) {
          visiting.add(bare);
          let best: { price: number; confidence: Conf } | null = null;
          for (const r of recs) {
            let sum = 0;
            let ok = true;
            let minRank = CONF_RANK.high;
            for (const ing of r.ingredients) {
              const cp = resolveIngredient(ing, depth + 1, visiting);
              if (cp.price == null) {
                ok = false;
                break;
              }
              sum += cp.price * ing.quantity;
              minRank = Math.min(minRank, CONF_RANK[cp.confidence]);
            }
            if (ok) {
              const per = sum / (r.output || 1);
              if (best == null || per < best.price)
                best = { price: per, confidence: RANK_CONF[minRank] };
            }
          }
          visiting.delete(bare);
          if (best)
            return {
              price: best.price,
              itemId: idsByCode.get(bare)?.[0] ?? null,
              confidence: best.confidence,
              derived: true,
            };
        }
      }
      // Metal forms (ingot/plate/nugget/ore…) fall back to blended content value.
      const est = metalEstimate(bare);
      if (est) return est;
      return {
        price: null,
        itemId: idsByCode.get(bare)?.[0] ?? null,
        confidence: "none",
        derived: false,
      };
    };

    // Resolve a (possibly wildcard) ingredient to its cheapest priced match.
    type IngPoint = ResolvePoint & { code: string };
    const resolveIngredient = (
      ing: { code: string; allowed?: string[] },
      depth: number,
      visiting: Set<string>,
    ): IngPoint => {
      let best: IngPoint | null = null;
      let fallback: IngPoint | null = null;
      for (const cand of candidatesFor(ing)) {
        const pp = resolveCode(cand, depth, visiting);
        if (pp.price != null) {
          if (best == null || pp.price < (best.price as number)) best = { ...pp, code: cand };
        } else if (fallback == null || (fallback.itemId == null && pp.itemId != null)) {
          fallback = { ...pp, code: cand };
        }
      }
      return (
        best ??
        fallback ?? {
          price: null,
          itemId: null,
          confidence: "none",
          derived: false,
          code: bareCode(ing.code),
        }
      );
    };

    const rootBare = code ? bareCode(code) : null;

    const cost = (recipe: RecipeDef): CostedRecipe => {
      const ingredients: PricedIngredient[] = recipe.ingredients.map((ing) => {
        // Fresh cycle-guard per top-level ingredient, seeded with the item itself
        // so a sub-recipe can't loop back to the thing we're pricing.
        const seed = new Set<string>(rootBare ? [rootBare] : []);
        const pp = resolveIngredient(ing, 1, seed);
        const name =
          (pp.itemId != null && catalog[String(pp.itemId)]?.name) || humanizeItemCode(pp.code);
        return {
          code: ing.code,
          name,
          itemId: pp.itemId,
          quantity: ing.quantity,
          unitPrice: pp.price,
          subtotal: pp.price != null ? pp.price * ing.quantity : null,
          confidence: pp.confidence,
          derived: pp.derived,
          derivedNote: pp.note,
        };
      });
      const known = ingredients.reduce((s, i) => s + (i.subtotal ?? 0), 0);
      const priced = ingredients.filter((i) => i.subtotal != null);
      const missing = ingredients.length - priced.length;
      const confidence = priced.length
        ? RANK_CONF[Math.min(...priced.map((i) => CONF_RANK[i.confidence]))]
        : "none";
      return {
        ingredients,
        perItem: known / (recipe.output || 1),
        missing,
        total: ingredients.length,
        confidence,
        anyDerived: ingredients.some((i) => i.derived),
      };
    };

    const all = recipes.map(cost).filter((r) => r.total - r.missing > 0);
    if (all.length === 0) return null;
    // Prefer a fully-priced recipe (cheapest); else the best-covered one.
    const full = all.filter((r) => r.missing === 0);
    const pool = full.length ? full : all;
    pool.sort((a, b) => a.missing - b.missing || a.perItem - b.perItem);
    return pool[0];
  }, [recipes, idsByCode, soldByItemId, metalInfoByItemId, priceMode, catalog, code]);

  if (!costed) return null;

  // Scale to whole-stack figures when the item is stack-priced, so this card's
  // number lines up unit-for-unit with the main Fair price card. Everything
  // (headline + breakdown) scales together so the lines still sum to the total.
  const scale = stackPriced ? Math.max(1, stackSize) : 1;
  const unitLabel = stackPriced ? "stack" : "unit";

  return (
    <Card className={cn(className)}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold">Fair price from ingredients</h2>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="How is the ingredient fair price computed?"
                  className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Info className="size-4" />
                </button>
              }
            />
            <PopoverContent className="max-w-xs text-sm">
              <p className="text-left">
                What this item&apos;s crafting materials cost on the market right now, summed for
                one crafted item (using the game&apos;s grid recipe). It ignores any labour, fuel or
                tool wear, so it&apos;s a rough floor — a finished good usually sells for at least
                this.
              </p>
              <p className="mt-2 text-left text-muted-foreground">
                An ingredient with no sales of its own is priced from <em>its</em> recipe in turn.
                The dot shows each price&apos;s confidence
                <span className="mx-1 inline-flex items-center gap-1 align-middle">
                  <span className="inline-block size-2 rounded-full bg-emerald-500" />
                  <span className="inline-block size-2 rounded-full bg-amber-500" />
                  <span className="inline-block size-2 rounded-full bg-red-500" />
                </span>
                (high → low, from how many sales backed it); a ringed dot means the price was
                estimated — from a sub-recipe, or (for metals with no sales) the blended value of
                the metal it contains.
              </p>
            </PopoverContent>
          </Popover>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <div className="text-2xl font-semibold tabular-nums">
              {formatGears(costed.perItem * scale)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/ {unitLabel}</span>
            </div>
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
              title={`Overall confidence: the lowest among the priced ingredients${
                costed.anyDerived ? " (some estimated from sub-recipes)" : ""
              }`}
            >
              <ConfDot confidence={costed.confidence} derived={costed.anyDerived} />
              {CONF_META[costed.confidence].label
                .replace(" confidence", "")
                .replace("No price data", "No data")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {costed.missing > 0
              ? `Materials floor — ${costed.missing} of ${costed.total} ingredient${
                  costed.total === 1 ? "" : "s"
                } had no price`
              : stackPriced
                ? "Total market value of a stack's worth of crafting materials"
                : "Total market value of its crafting materials"}
          </p>
        </div>

        <ul className="space-y-1 text-sm">
          {costed.ingredients.map((ing) => (
            <li key={ing.code} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <ConfDot confidence={ing.confidence} derived={ing.derived} note={ing.derivedNote} />
                <span className="min-w-0 truncate">
                  <span className="tabular-nums text-muted-foreground">
                    ×{ing.quantity * scale}{" "}
                  </span>
                  {ing.itemId != null ? (
                    <Link to={`/market/items/${ing.itemId}`} className="hover:underline">
                      {ing.name}
                    </Link>
                  ) : (
                    ing.name
                  )}
                  {ing.derived && (
                    <span
                      className="ml-1 text-xs text-muted-foreground"
                      title={ing.derivedNote ?? "Estimated from its own recipe"}
                    >
                      (est.)
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {ing.subtotal != null ? formatGears(ing.subtotal * scale) : "—"}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
