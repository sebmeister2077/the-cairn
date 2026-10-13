// Lookup helpers + display metadata over the static loot-pools dataset
// (bundled JSON extracted from the game's weighted loot tables). Pool-centric
// counterpart to `item-sources.ts`; reuses its rarity colours/labels.

import raw from "@/assets/GameData/loot-pools.json";
import { RARITY_COLORS, RARITY_LABELS, RARITY_RANK } from "@/lib/item-sources";
import type { LootPool, LootPoolCategory, LootPoolsData } from "@/models/loot-pools";

const DATA = raw as unknown as LootPoolsData;

export { RARITY_COLORS, RARITY_LABELS, RARITY_RANK };

/** Display order for the category groups (ruins first — the most common). */
export const LOOT_CATEGORY_ORDER: LootPoolCategory[] = [
    "ruins",
    "vessel",
    "clutter",
    "library",
    "mines",
];

const CATEGORY_RANK = Object.fromEntries(
    LOOT_CATEGORY_ORDER.map((c, i) => [c, i]),
) as Record<LootPoolCategory, number>;

/** All loot pools, ordered by the display category order then label. (The bundled
 *  JSON is sorted alphabetically by category, which would surface the many
 *  single-item clutter pools before the meaningful ruins ones.) */
export function getLootPools(): LootPool[] {
    return [...DATA.pools].sort(
        (a, b) =>
            (CATEGORY_RANK[a.category] ?? 99) - (CATEGORY_RANK[b.category] ?? 99) ||
            a.label.localeCompare(b.label),
    );
}

export function getLootPoolsMeta(): { generatedUtc: string; sources: string[]; poolCount: number } {
    return { generatedUtc: DATA.generatedUtc, sources: DATA.sources, poolCount: DATA.poolCount };
}

/** Pools belonging to a category, keeping the generated label order. */
export function getPoolsByCategory(category: LootPoolCategory): LootPool[] {
    return DATA.pools.filter((p) => p.category === category);
}

/** Human-friendly item name from a bare code, e.g. `clothes-foot-shepherd-sandals`
 *  -> "Clothes Foot Shepherd Sandals". Mirrors the rock page's code prettifier. */
export function prettifyItemCode(code: string): string {
    return code
        .replace(/[-_]+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a stack-size range as `1` or `2–12`. */
export function formatQuantity(minQty: number, maxQty: number): string {
    return minQty === maxQty ? String(minQty) : `${minQty}\u2013${maxQty}`;
}
