// Lookup helpers over the static trader-wares dataset (bundled JSON extracted
// from the game assets). Pure + synchronous — the file is small enough to import.

import raw from "@/assets/GameData/trader-wares.json";
import type { ItemTraderInfo, TraderWaresData } from "@/models/trader-wares";

const DATA = raw as unknown as TraderWaresData;

/** Bare item code: drop the asset domain prefix (`game:ingot-copper` -> `ingot-copper`). */
export function bareItemCode(code: string): string {
    return code.split(":", 2).pop()!.trim();
}

/** Trader buy/sell info for an item code, or null when no trader deals in it. */
export function lookupTraderInfo(code: string | null | undefined): ItemTraderInfo | null {
    if (!code) return null;
    const info = DATA.items[bareItemCode(code)];
    if (!info) return null;
    if (!info.sells?.length && !info.buys?.length) return null;
    return info;
}
