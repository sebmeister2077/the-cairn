// Lookup helpers + display metadata over the static item-sources dataset
// (bundled JSON extracted from the game's stackrandomizer loot pools).

import raw from "@/assets/GameData/item-sources.json";
import { bareItemCode } from "@/lib/trader-wares";
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

/** Loot sources + rarity for an item code, or null when it isn't loot-table drop. */
export function lookupItemSources(code: string | null | undefined): ItemSourceInfo | null {
    if (!code) return null;
    const info = DATA.items[bareItemCode(code)];
    if (!info) return null;
    // Lore-reward items have no loot sources but still render (a chip).
    if (!info.sources.length && !info.loreReward) return null;
    return info;
}
