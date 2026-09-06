// Client-side player index for the Player Search page. The full `listings.json`
// is already loaded for the rest of the Auction House, so rather than add a
// backend endpoint we aggregate one lightweight row per player (keyed by uid)
// in a single pass. Heavier per-player analytics (archetypes, pricing style)
// stay on the profile page — here we only surface the cheap headline metrics
// used to find and compare traders.

import { useMemo } from "react";
import {
    getLatestObservedUtc,
    refreshMarketReferences,
    specializationGroupFor,
} from "@/lib/auction";
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
    lastActiveMs: number;
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
            lastActiveMs: 0,
        };
        map.set(uid, a);
    }
    return a;
}

function bumpCategory(a: Agg, category: string): void {
    const group = specializationGroupFor(category);
    a.categories.set(group, (a.categories.get(group) ?? 0) + 1);
}

function touchActive(a: Agg, ms: number): void {
    if (ms > a.lastActiveMs) a.lastActiveMs = ms;
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
        // "Last active" needs a real-world time for the player's own actions
        // (posting a listing, buying it) — not sweep observation times, which
        // keep ticking on lingering listings and make absent players look live.
        // Convert in-game hours to real UTC using the market-clock anchor
        // (`currentGameHours` ↔ `latestObservedUtc`) and VS's 1 in-game hour
        // ≈ 2 real minutes rate.
        const currentGameHours = refreshMarketReferences(listings ?? []);
        const anchorMs = Date.parse(getLatestObservedUtc());
        const IN_GAME_HOUR_MS = 2 * 60 * 1000;
        const nowMs = Date.now();
        const anchorReady = currentGameHours > 0 && Number.isFinite(anchorMs);
        const realMsFromGameHours = (gameHours: number | null | undefined): number => {
            if (!anchorReady || gameHours == null) return 0;
            const ms = anchorMs - (currentGameHours - gameHours) * IN_GAME_HOUR_MS;
            return ms > nowMs ? nowMs : ms;
        };

        const map = new Map<string, Agg>();
        for (const l of listings ?? []) {
            if (l.spam || l.externalTrade) continue;

            const postedMs =
                realMsFromGameHours(l.postedTotalHours) ||
                (l.observedUtc ? Date.parse(l.observedUtc) : 0);
            const saleMs = l.sold
                ? realMsFromGameHours(
                      l.postedTotalHours != null && l.timeToSellHours != null
                          ? l.postedTotalHours + l.timeToSellHours
                          : null,
                  ) ||
                  (l.lastObservedUtc ? Date.parse(l.lastObservedUtc) : 0) ||
                  postedMs
                : 0;

            if (l.sellerUid) {
                const a = ensure(map, l.sellerUid);
                if (!a.name && l.sellerName) a.name = l.sellerName;
                a.listed += 1;
                bumpCategory(a, l.category);
                // Posting the listing is the seller's only pinpointable action;
                // a later sale/expiry is the buyer's or the clock's doing, not
                // theirs. Older `observedUtc` fallback only used when we can't
                // reconstruct the posting time.
                touchActive(a, postedMs);
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
                touchActive(a, saleMs);
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
                lastActiveUtc: a.lastActiveMs > 0 ? new Date(a.lastActiveMs).toISOString() : null,
                role: roleFor(a),
            });
        }
        return rows;
    }, [listings]);
}
