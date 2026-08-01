// Trader wares extracted from the Vintage Story game assets by
// `backend/extract_trader_wares.py` (served from
// `frontend/src/assets/GameData/trader-wares.json`). Keyed by bare item code.

import type { TraderType } from "@/lib/trader-types";

/** One trader profession's price interval (in gears) for an item. */
export interface TraderWarePrice {
    traderType: TraderType;
    /** Lowest realised price (avg − var). */
    priceMin: number;
    /** Highest realised price (avg + var). */
    priceMax: number;
    /** Nominal average price. */
    priceAvg: number;
    /** Quantity of items exchanged for that price (per-trade stack size). */
    stacksize?: number;
}

/** Trader availability for a single item code. `sells` = traders sell it to the
 *  player (player buys); `buys` = traders buy it from the player (player sells). */
export interface ItemTraderInfo {
    sells?: TraderWarePrice[];
    buys?: TraderWarePrice[];
}

export interface TraderWaresData {
    generatedUtc: string;
    source: string;
    traderFiles: number;
    wareEntries: number;
    items: Record<string, ItemTraderInfo>;
}
