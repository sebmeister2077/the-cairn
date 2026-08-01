// Item loot sources + derived rarity extracted from the game's stackrandomizer
// by `backend/extract_item_sources.py` (served from
// `frontend/src/assets/GameData/item-sources.json`). Keyed by bare item code.

export type Rarity = "common" | "uncommon" | "rare" | "very_rare" | "legendary";

/** One loot pool an item can drop from, with its drop chance in that pool. */
export interface ItemLootSource {
    pool: string;
    label: string;
    /** Drop chance within this pool, in percent. */
    chancePct: number;
}

export interface ItemSourceInfo {
    rarity: Rarity;
    sources: ItemLootSource[];
}

export interface ItemSourcesData {
    generatedUtc: string;
    source: string;
    poolCount: number;
    items: Record<string, ItemSourceInfo>;
}
