// Shared bits for the Orders marketplace UI: labels + an item autoselect that
// resolves a catalog item name to its numeric id.

import { useMemo } from "react";

import { useItemCatalog } from "@/lib/auction";
import type { OrderSide, SellUnit, TraderMobility } from "@/models/orders";

export const MOBILITY_LABELS: Record<TraderMobility, string> = {
    stationary: "Stationary (fixed base)",
    occasional: "Travels sometimes",
    frequent: "Travels a lot",
};

// A crate holds a fixed number of stacks in-game.
export const STACKS_PER_CRATE = 20;

/** Singular / plural nouns for each sell unit. */
export const SELL_UNIT_ONE: Record<SellUnit, string> = {
    unit: "unit",
    stack: "stack",
    crate: "crate",
};
export const SELL_UNIT_MANY: Record<SellUnit, string> = {
    unit: "units",
    stack: "stacks",
    crate: "crates",
};

type SellUnitShape = { sell_unit?: SellUnit | null; stack_size?: number | null };

/** Number of individual items in one of the order's sell units (stack size,
 *  times 20 for crates). 1 for plain per-item orders or when the stack size is
 *  unknown. */
export function unitsPerSellUnit({ sell_unit, stack_size }: SellUnitShape): number {
    const unit = sell_unit ?? "unit";
    const size = stack_size && stack_size > 0 ? stack_size : 1;
    if (unit === "crate") return size * STACKS_PER_CRATE;
    if (unit === "stack") return size;
    return 1;
}

/** e.g. "per crate" — the price qualifier for an order. */
export function priceUnitLabel(order: SellUnitShape): string {
    return `per ${SELL_UNIT_ONE[order.sell_unit ?? "unit"]}`;
}

/** e.g. "5 crates" / "1 stack". */
export function formatQtyInUnit(n: number, order: SellUnitShape): string {
    const unit = order.sell_unit ?? "unit";
    return `${n.toLocaleString()} ${n === 1 ? SELL_UNIT_ONE[unit] : SELL_UNIT_MANY[unit]}`;
}

/** Parenthetical individual-item total for stack/crate orders, e.g.
 *  "(1,600 items)". Empty string for plain per-item orders. */
export function unitTotalHint(n: number, order: SellUnitShape): string {
    if ((order.sell_unit ?? "unit") === "unit") return "";
    const total = n * unitsPerSellUnit(order);
    return `(${total.toLocaleString()} item${total === 1 ? "" : "s"})`;
}

export const MOBILITY_SHORT: Record<TraderMobility, string> = {
    stationary: "Stationary",
    occasional: "Travels sometimes",
    frequent: "Travels a lot",
};

export const SIDE_LABELS: Record<OrderSide, string> = {
    sell: "Selling",
    buy: "Looking to buy",
};

export interface CatalogItem {
    itemId: number;
    name: string;
    category: string;
}

/** Item name suggestions + a name→id resolver from the market item catalog. */
export function useItemPicker() {
    const { data: catalog, isPending } = useItemCatalog();

    const { suggestions, idByName, stackByName } = useMemo(() => {
        const byName = new Map<string, number>();
        const stackSizes = new Map<string, number>();
        const names = new Set<string>();
        if (catalog) {
            for (const [idStr, entry] of Object.entries(catalog)) {
                const id = Number.parseInt(idStr, 10);
                if (!Number.isFinite(id)) continue;
                const name = entry.name?.trim();
                if (!name) continue;
                names.add(name);
                const key = name.toLowerCase();
                // Keep the first id seen for a given name (stable ordering).
                if (!byName.has(key)) byName.set(key, id);
                if (entry.maxStackSize != null && !stackSizes.has(key)) {
                    stackSizes.set(key, entry.maxStackSize);
                }
            }
        }
        return {
            suggestions: Array.from(names).sort((a, b) => a.localeCompare(b)),
            idByName: byName,
            stackByName: stackSizes,
        };
    }, [catalog]);

    const resolveId = (name: string): number | null => {
        const id = idByName.get(name.trim().toLowerCase());
        return id ?? null;
    };

    /** The item's known in-game max stack size, or null when the catalog
     *  doesn't record one (the caller then asks the user to enter it). */
    const resolveStackSize = (name: string): number | null => {
        const size = stackByName.get(name.trim().toLowerCase());
        return size ?? null;
    };

    return { suggestions, resolveId, resolveStackSize, isPending };
}
