// Client-side player index for the Player Search page. The full `listings.json`
// is already loaded for the rest of the Auction House, so rather than add a
// backend endpoint we aggregate one lightweight row per player (keyed by uid)
// in a single pass. Heavier per-player analytics (archetypes, pricing style)
// stay on the profile page — here we only surface the cheap headline metrics
// used to find and compare traders.

import { useMemo } from "react";
import { specializationGroupFor } from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";

/** Whether a player shows up mainly as a seller, a buyer, or does both. */
export type PlayerRoleKind = "seller" | "buyer" | "both";

export interface PlayerIndexRow {
    uid: string;
    name: string;
    /** Net seller revenue (sold price minus trader cut). */
    revenue: number;
    /** Total spent as a buyer (sum of purchase prices). */
    spent: number;
    /** Listings posted as a seller. */
    listed: number;
    /** Listings that sold as a seller. */
    sold: number;
    /** Purchases made as a buyer. */
    bought: number;
    /** Sold / listed, or null when the player never listed anything. */
    sellThrough: number | null;
    /** Most-traded (grouped) category across both roles. */
    topCategory: string | null;
    /** Newest real-world observation across the player's trades, ISO or null. */
    lastActiveUtc: string | null;
    role: PlayerRoleKind;
}

interface Agg {
    uid: string;
    name: string | null;
    revenue: number;
    spent: number;
    listed: number;
    sold: number;
    bought: number;
    categories: Map<string, number>;
    lastActiveUtc: string | null;
}

function ensure(map: Map<string, Agg>, uid: string): Agg {
    let a = map.get(uid);
    if (!a) {
        a = {
            uid,
            name: null,
            revenue: 0,
            spent: 0,
            listed: 0,
            sold: 0,
            bought: 0,
            categories: new Map(),
            lastActiveUtc: null,
        };
        map.set(uid, a);
    }
    return a;
}

function bumpCategory(a: Agg, category: string): void {
    const group = specializationGroupFor(category);
    a.categories.set(group, (a.categories.get(group) ?? 0) + 1);
}

function touchActive(a: Agg, l: AuctionListing): void {
    const ts = l.lastObservedUtc ?? l.observedUtc;
    // ISO-8601 UTC strings compare lexicographically, so a plain > works.
    if (ts && (a.lastActiveUtc == null || ts > a.lastActiveUtc)) a.lastActiveUtc = ts;
}

function roleFor(a: Agg): PlayerRoleKind {
    if (a.listed > 0 && a.bought > 0) return "both";
    return a.bought > 0 ? "buyer" : "seller";
}

function topCategoryFor(a: Agg): string | null {
    let best = -1;
    let top: string | null = null;
    for (const [cat, count] of a.categories) {
        if (count > best) {
            best = count;
            top = cat;
        }
    }
    return top;
}

/**
 * Build one aggregate row per player from the shared listings dataset. Spam and
 * off-platform barter trades are excluded (as everywhere else). Memoised on the
 * listings reference so it only recomputes when the dataset changes.
 */
export function usePlayerSearchIndex(listings: AuctionListing[] | undefined): PlayerIndexRow[] {
    return useMemo(() => {
        const map = new Map<string, Agg>();
        for (const l of listings ?? []) {
            if (l.spam || l.externalTrade) continue;

            if (l.sellerUid) {
                const a = ensure(map, l.sellerUid);
                if (!a.name && l.sellerName) a.name = l.sellerName;
                a.listed += 1;
                bumpCategory(a, l.category);
                touchActive(a, l);
                if (l.sold) {
                    a.sold += 1;
                    a.revenue += l.price - (l.traderCut || 0);
                }
            }

            if (l.buyerUid && l.sold) {
                const a = ensure(map, l.buyerUid);
                if (!a.name && l.buyerName) a.name = l.buyerName;
                a.bought += 1;
                a.spent += l.price;
                bumpCategory(a, l.category);
                touchActive(a, l);
            }
        }

        const rows: PlayerIndexRow[] = [];
        for (const a of map.values()) {
            rows.push({
                uid: a.uid,
                name: a.name ?? a.uid,
                revenue: a.revenue,
                spent: a.spent,
                listed: a.listed,
                sold: a.sold,
                bought: a.bought,
                sellThrough: a.listed ? a.sold / a.listed : null,
                topCategory: topCategoryFor(a),
                lastActiveUtc: a.lastActiveUtc,
                role: roleFor(a),
            });
        }
        return rows;
    }, [listings]);
}
