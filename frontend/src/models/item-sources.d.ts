// Item loot sources + derived rarity extracted from the game's stackrandomizer
// by `backend/extract_item_sources.py` (served from
// `frontend/src/assets/GameData/item-sources.json`). Keyed by bare item code.

export type Rarity = "common" | "uncommon" | "rare" | "very_rare" | "legendary" | "unique";

/** One loot pool an item can drop from, with its drop chance in that pool. */
export interface ItemLootSource {
    pool: string;
    label: string;
    /** Drop chance within this pool, in percent. */
    chancePct: number;
    /** Lazaret chest: lootable only once per server, so this source is one-shot. */
    oncePerServer?: boolean;
}

export interface ItemSourceInfo {
    rarity: Rarity;
    sources: ItemLootSource[];
    /** True when this item also has a crafting (grid) recipe. */
    craftable?: boolean;
    /** Handed to every player for completing the Lore — not rare loot. */
    loreReward?: boolean;
}

export interface ItemSourcesData {
    generatedUtc: string;
    source: string;
    poolCount: number;
    items: Record<string, ItemSourceInfo>;
}
