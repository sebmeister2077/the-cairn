// Lookup helpers + display metadata over the static item-sources dataset
// (bundled JSON extracted from the game's stackrandomizer loot pools).

import raw from "@/assets/GameData/item-sources.json";
import { bareItemCode, lookupTraderInfo } from "@/lib/trader-wares";
import type { ItemSourceInfo, ItemSourcesData, Rarity } from "@/models/item-sources";

const DATA = raw as unknown as ItemSourcesData;

export const RARITY_LABELS: Record<Rarity, string> = {
    common: "Common",
    uncommon: "Uncommon",
    rare: "Rare",
    very_rare: "Very Rare",
    legendary: "Legendary",
    unique: "Unique",
};

export const RARITY_COLORS: Record<Rarity, string> = {
    common: "#9ca3af", // gray-400
    uncommon: "#22c55e", // green-500
    rare: "#3b82f6", // blue-500
    very_rare: "#a855f7", // purple-500
    legendary: "#f59e0b", // amber-500
    unique: "#e11d48", // rose-600
};

// Ordinal from common (1) to unique (6), for sorting by rarity (rarest first).
export const RARITY_RANK: Record<Rarity, number> = {
    common: 1,
    uncommon: 2,
    rare: 3,
    very_rare: 4,
    legendary: 5,
    unique: 6,
};

/** Loot sources + rarity for an item code, or null when it isn't loot-table drop. */
export function lookupItemSources(code: string | null | undefined): ItemSourceInfo | null {
    if (!code) return null;
    const info = DATA.items[bareItemCode(code)];
    if (!info) return null;
    // Lore-reward items have no loot sources but still render (a chip).
    if (!info.sources.length && !info.loreReward) return null;
    return info;
}

// Smelted/processed staples that appear in loot pools but are trivially obtainable
// (so their loot rarity is misleading on the market browsing pages). Grid-craftable
// and trader-bought items are handled separately in `marketRarity`.
const COMMON_STAPLE_EXACT = new Set<string>(["coke", "gear-temporal", "gear-rusty"]);
const COMMON_STAPLE_PREFIXES = ["ingot-", "metalbit-", "nugget-", "chandelier", 'padlock-'];
const COMMON_STAPLE_SUFFIXES = ["-ingot", "-nugget", "-tinbronze", "-blackbronze", "-copper", "-bismuthbronze", "-iron", "-steel", "-sylvite"];

function isCommonStaple(bare: string): boolean {
    return COMMON_STAPLE_EXACT.has(bare) ||
        COMMON_STAPLE_PREFIXES.some((p) => bare.startsWith(p)) ||
        COMMON_STAPLE_SUFFIXES.some((s) => bare.endsWith(s));
}

/** Rarity to show on the market browsing pages (Item Search, Insights): the loot
 * rarity, EXCEPT for items obtainable by crafting, buying, or smelting — those
 * return null so a mass-producible item (e.g. Gold ingot) isn't mislabelled as
 * Legendary. The item detail page uses `lookupItemSources` directly and still
 * shows the full loot-chest rarity/drop %. */
export function marketRarity(code: string | null | undefined): Rarity | null {
    const info = lookupItemSources(code);
    if (!info) return null;
    if (info.craftable || isCommonStaple(bareItemCode(code!)) || lookupTraderInfo(code)) return null;
    return info.rarity;
}
