// Weighted loot pools + per-item rarity extracted from the game's loot assets
// by `backend/extract_loot_pools.py` (served from
// `frontend/src/assets/GameData/loot-pools.json`). Pool-centric: each pool keeps
// its own weighted item list, unlike the item-centric `item-sources.json`.

import type { Rarity } from "./item-sources";

export type { Rarity };

/** Which source asset / in-game context a pool belongs to. */
export type LootPoolCategory = "ruins" | "clutter" | "library" | "mines" | "vessel" | "fishing";

/** One item that can roll out of a loot pool, with its in-pool drop chance. */
export interface LootPoolItem {
    /** Bare item/block code (domain prefix stripped). */
    code: string;
    /** Drop chance within this pool, in percent. */
    chancePct: number;
    rarity: Rarity;
    /** Minimum stack size rolled. */
    minQty: number;
    /** Maximum stack size rolled. */
    maxQty: number;
    /** True when this item appears ONLY in once-per-server pools, so exactly one
     *  exists per world. */
    uniquePerServer?: boolean;
}

export interface LootPool {
    /** Unique id across all source files (e.g. `ruins-cloth-lowstatus`). */
    id: string;
    /** Bare pool key within its source file (e.g. `cloth-lowstatus`). */
    key: string;
    /** In-game randomizer / vessel name. */
    label: string;
    category: LootPoolCategory;
    itemCount: number;
    items: LootPoolItem[];
    /** Loot-vessel pools only: average number of draws made per vessel. */
    draws?: number;
    /** Fishing pool only: chance (percent) that a catch is junk rather than a fish. */
    junkChancePct?: number;
    /** True when this pool is only placed by once-per-world "story" structures. */
    oncePerServer?: boolean;
}

export interface LootPoolsData {
    generatedUtc: string;
    sources: string[];
    poolCount: number;
    oncePerServerPoolCount: number;
    uniqueItemCount: number;
    pools: LootPool[];
}
