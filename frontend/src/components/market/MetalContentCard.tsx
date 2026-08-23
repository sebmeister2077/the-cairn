import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listingHasText, percentileSorted, weightedMedian, type MetalForm } from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";

/** Price-per-unit-of-metal formatter: keep two decimals for the small values
 * that content-normalization produces (e.g. 5.30⚙/unit), whole gears above 100. */
function formatUnitPrice(n: number): string {
  if (n >= 100) return `${Math.round(n).toLocaleString()}⚙`;
  return `${n.toFixed(2)}⚙`;
}

interface FormRow {
  key: string;
  label: string;
  /** A representative itemId to link to (opens that form's item page). */
  linkId: number;
  /** Fair price per unit of pure metal (median or qty-weighted). */
  pricePerMetalUnit: number;
  /** Sold listings backing the figure. */
  soldCount: number;
}

/** Aggregate one metal form's sold listings into a price-per-unit-of-metal. */
function formPricePerMetalUnit(
  form: MetalForm,
  listings: AuctionListing[],
  unitsByItemId: Map<number, number>,
  weighted: boolean,
): FormRow | null {
  const ids = new Set(form.itemIds);
  const pairs: { value: number; weight: number }[] = [];
  let linkId = form.itemIds[0];
  for (const l of listings) {
    if (!l.sold || !ids.has(l.itemId) || listingHasText(l)) continue;
    const units = unitsByItemId.get(l.itemId);
    if (!units || units <= 0) continue;
    // Normalize to price per single unit of pure metal so forms of differing
    // content (a 5-unit nugget vs a 100-unit ingot) become directly comparable.
    pairs.push({ value: l.pricePerUnit / units, weight: l.qty * units });
    linkId = l.itemId;
  }
  if (pairs.length === 0) return null;
  const price = weighted
    ? weightedMedian(pairs)
    : percentileSorted(
        pairs.map((p) => p.value).sort((a, b) => a - b),
        0.5,
      );
  if (price == null) return null;
  return {
    key: form.key,
    label: form.label,
    linkId,
    pricePerMetalUnit: price,
    soldCount: pairs.length,
  };
}

/**
 * "Value by metal content" — compares every tradeable form of a metal on a
 * common basis (price per unit of pure metal), so you can see at a glance which
 * forms trade at a premium or discount to the one you're viewing. All ore-chunk
 * grades and host rocks collapse into a single "Ore chunks" row; crystallized
 * chunks are excluded upstream. Renders nothing unless at least two forms have
 * sold data to compare.
 */
export function MetalContentCard({
  familyLabel,
  forms,
  unitsByItemId,
  listings,
  weighted,
  currentFormKey,
}: {
  familyLabel: string;
  forms: MetalForm[];
  unitsByItemId: Map<number, number>;
  listings: AuctionListing[];
  weighted: boolean;
  currentFormKey: string;
}) {
  const rows = useMemo(() => {
    const out: FormRow[] = [];
    for (const f of forms) {
      const r = formPricePerMetalUnit(f, listings, unitsByItemId, weighted);
      if (r) out.push(r);
    }
    return out;
  }, [forms, listings, unitsByItemId, weighted]);

  // The row representing the item currently being viewed, used as the baseline
  // every other form's price is measured against.
  const baseline = rows.find((r) => r.key === currentFormKey) ?? null;

  if (rows.length < 2) return null;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="font-semibold">Value by metal content</h2>
          <span className="text-xs text-muted-foreground">
            {familyLabel} · price per unit of pure metal
          </span>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="How is value by metal content calculated?"
                  className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Info className="size-4" />
                </button>
              }
            />
            <PopoverContent className="max-w-xs">
              <div className="space-y-1.5 text-left">
                <p>
                  Each form is smelted down to its pure-metal content (an ingot = 100 units, a
                  nugget = 5, ore chunks by grade) and its{" "}
                  {weighted ? "quantity-weighted" : "median"} sold price divided by that content.
                </p>
                <p>
                  This puts every form on one scale, so you can see which trade at a premium (▲) or
                  discount (▼) to the form you&apos;re viewing. All ore-chunk grades and host rocks
                  are pooled; crystallized chunks are excluded.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">Form</th>
                <th className="px-3 py-1.5 text-right font-medium">Price / metal unit</th>
                <th className="px-3 py-1.5 text-right font-medium">vs this item</th>
                <th className="px-3 py-1.5 text-right font-medium">Sold</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isCurrent = r.key === currentFormKey;
                const delta =
                  baseline && baseline.pricePerMetalUnit > 0 && !isCurrent
                    ? (r.pricePerMetalUnit - baseline.pricePerMetalUnit) /
                      baseline.pricePerMetalUnit
                    : null;
                const up = delta != null && delta > 0.005;
                const down = delta != null && delta < -0.005;
                return (
                  <tr
                    key={r.key}
                    className={`border-b last:border-0 ${isCurrent ? "bg-primary/5" : ""}`}
                  >
                    <td className="px-3 py-1.5">
                      <Link
                        to={`/market/items/${r.linkId}`}
                        className="font-medium hover:underline"
                      >
                        {r.label}
                      </Link>
                      {isCurrent && (
                        <span className="ml-1.5 text-xs text-muted-foreground">(this item)</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatUnitPrice(r.pricePerMetalUnit)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {isCurrent ? (
                        <span className="text-muted-foreground">—</span>
                      ) : delta == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            up
                              ? "text-emerald-600"
                              : down
                                ? "text-red-600"
                                : "text-muted-foreground"
                          }
                        >
                          {up ? "▲" : down ? "▼" : "→"} {delta > 0 ? "+" : ""}
                          {(delta * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {r.soldCount.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!baseline && (
          <p className="mt-2 text-xs text-muted-foreground">
            No sold data for this exact form in the selected range, so the comparison has no
            baseline to measure against — figures above are still each form&apos;s own price per
            metal unit.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
