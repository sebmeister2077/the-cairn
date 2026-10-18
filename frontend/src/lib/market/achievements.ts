// Player achievements for the Auction House explorer.
//
// Achievements are permanent, all-time accolades derived client-side from the
// shared listings dataset — deliberately NOT scoped to the profile's selected
// time window, so narrowing the range never revokes a badge a player earned.
//
// Adding a new achievement is a one-object append to `ACHIEVEMENTS`: give it an
// id/icon/title, point it at a metric computed in `computePlayerMetrics`, and
// list its tier thresholds. Everything else (progress, earned tier, locked
// state) is derived generically.

import {
    Banknote,
    Boxes,
    Coins,
    Footprints,
    Gem,
    Hammer,
    Handshake,
    Package,
    Shirt,
    ShoppingBag,
    ShoppingCart,
    Tag,
    type LucideIcon,
} from "lucide-react";
import { formatGears, isToolCategory } from "./auction";
import type { AuctionListing } from "@/models/auction";

/** Per-player, all-time tallies every achievement is scored against. */
export interface PlayerMetrics {
    /** Gears earned from sales, net of the trader's cut. */
    netRevenue: number;
    /** Gears spent as a buyer. */
    totalSpent: number;
    /** Clothing units sold. */
    clothingSold: number;
    /** Clothing units bought. */
    clothingBought: number;
    /** Total item units sold across everything. */
    itemsSoldUnits: number;
    /** Number of sold listings (completed sales). */
    salesCount: number;
    /** Number of completed purchases. */
    purchaseCount: number;
    /** Total listings posted as a seller. */
    listingsPosted: number;
    /** Distinct item ids the player has sold. */
    distinctItemsSold: number;
    /** Tool/weapon units sold. */
    toolsSold: number;
    /** Purchases the buyer collected in person (no delivery). */
    pickupsCollected: number;
    /** Largest single sale total (gears). */
    biggestSale: number;
}

type MetricKey = keyof PlayerMetrics;

export interface AchievementDef {
    id: string;
    /** Lucide icon shown as the medallion. */
    icon: LucideIcon;
    title: string;
    /** One-line flavour describing the feat. */
    desc: string;
    metric: MetricKey;
    /** Ascending thresholds; a single-element list is an untiered achievement. */
    tiers: number[];
    /** How the metric/thresholds are rendered (defaults to a plain count). */
    format?: (n: number) => string;
}

/** An achievement scored for one player. */
export interface AchievementProgress {
    def: AchievementDef;
    /** Raw metric value. */
    value: number;
    /** Highest tier index reached, or -1 when none. */
    tierIndex: number;
    /** True once the first tier is reached. */
    earned: boolean;
    /** Next threshold to reach, or null when every tier is maxed. */
    nextTarget: number | null;
    /** Progress toward `nextTarget` (0–1); 1 when fully maxed. */
    progress: number;
}

const formatCount = (n: number) => Math.round(n).toLocaleString();

/**
 * The achievement registry. Order here is the display order. Append to extend.
 */
export const ACHIEVEMENTS: AchievementDef[] = [
    {
        id: "wealth",
        icon: Coins,
        title: "Wealth",
        desc: "Earn gears from sales, net of the trader's cut.",
        metric: "netRevenue",
        tiers: [1000, 5000, 10000, 25000],
        format: formatGears,
    },
    {
        id: "big-spender",
        icon: Banknote,
        title: "Big Spender",
        desc: "Spend gears buying from other players.",
        metric: "totalSpent",
        tiers: [1000, 10000, 50000, 100000],
        format: formatGears,
    },
    {
        id: "dealer",
        icon: Handshake,
        title: "Dealer",
        desc: "Close sales on the auction house.",
        metric: "salesCount",
        tiers: [10, 50, 250, 1000],
        format: formatCount,
    },
    {
        id: "shopper",
        icon: ShoppingCart,
        title: "Shopper",
        desc: "Buy items from other players.",
        metric: "purchaseCount",
        tiers: [10, 50, 250, 1000],
        format: formatCount,
    },
    {
        id: "lister",
        icon: Tag,
        title: "Lister",
        desc: "Post listings on the auction house.",
        metric: "listingsPosted",
        tiers: [25, 100, 500, 2000, 5000],
        format: formatCount,
    },
    {
        id: "merchant",
        icon: Package,
        title: "Merchant",
        desc: "Move item units across your sold listings.",
        metric: "itemsSoldUnits",
        tiers: [250, 1500, 7500, 20000, 50000],
        format: formatCount,
    },
    {
        id: "tailor",
        icon: Shirt,
        title: "Tailor",
        desc: "Sell clothing to fellow players.",
        metric: "clothingSold",
        tiers: [10, 50, 100, 250],
        format: formatCount,
    },
    {
        id: "wardrobe",
        icon: ShoppingBag,
        title: "Wardrobe",
        desc: "Buy clothing from the auction house.",
        metric: "clothingBought",
        tiers: [10, 50, 100, 250],
        format: formatCount,
    },
    {
        id: "blacksmith",
        icon: Hammer,
        title: "Blacksmith",
        desc: "Sell tools and weapons.",
        metric: "toolsSold",
        tiers: [10, 50, 200, 1000],
        format: formatCount,
    },
    {
        id: "diversifier",
        icon: Boxes,
        title: "Diversifier",
        desc: "Sell a wide variety of different items.",
        metric: "distinctItemsSold",
        tiers: [10, 50, 150, 500],
        format: formatCount,
    },
    {
        id: "courier",
        icon: Footprints,
        title: "Legwork",
        desc: "Collect your purchases in person instead of paying for delivery.",
        metric: "pickupsCollected",
        tiers: [5, 25, 100, 300],
        format: formatCount,
    },
    {
        id: "big-deal",
        icon: Gem,
        title: "Big Deal",
        desc: "Land a large single sale (the price ceiling is 10,000⚙).",
        metric: "biggestSale",
        tiers: [500, 2000, 5000, 10000],
        format: formatGears,
    },
];

/** Whether a listing's item counts as clothing (VS `game:clothes-*` codes). */
export function isClothing(category: string): boolean {
    return category === "clothes";
}

/**
 * Tally a player's all-time metrics from the shared listings. Spam and external
 * (off-platform barter) trades are excluded, matching the rest of the profile.
 */
export function computePlayerMetrics(
    listings: AuctionListing[] | undefined,
    uid: string,
): PlayerMetrics {
    const m: PlayerMetrics = {
        netRevenue: 0,
        totalSpent: 0,
        clothingSold: 0,
        clothingBought: 0,
        itemsSoldUnits: 0,
        salesCount: 0,
        purchaseCount: 0,
        listingsPosted: 0,
        distinctItemsSold: 0,
        toolsSold: 0,
        pickupsCollected: 0,
        biggestSale: 0,
    };
    if (!uid) return m;
    const soldItemIds = new Set<number>();
    for (const l of listings ?? []) {
        if (l.spam || l.externalTrade) continue;
        const clothing = isClothing(l.category);
        const tool = isToolCategory(l.category);
        if (l.sellerUid === uid) {
            m.listingsPosted += 1;
            if (l.sold) {
                m.netRevenue += l.price - (l.traderCut || 0);
                m.itemsSoldUnits += l.qty;
                m.salesCount += 1;
                soldItemIds.add(l.itemId);
                if (clothing) m.clothingSold += l.qty;
                if (tool) m.toolsSold += l.qty;
                if (l.price > m.biggestSale) m.biggestSale = l.price;
            }
        }
        if (l.buyerUid === uid && l.sold) {
            m.totalSpent += l.price;
            m.purchaseCount += 1;
            if (!l.delivered) m.pickupsCollected += 1;
            if (clothing) m.clothingBought += l.qty;
        }
    }
    m.distinctItemsSold = soldItemIds.size;
    return m;
}

/** Score one achievement against a player's metrics. */
function scoreAchievement(def: AchievementDef, metrics: PlayerMetrics): AchievementProgress {
    const value = metrics[def.metric];
    let tierIndex = -1;
    for (let i = 0; i < def.tiers.length; i++) {
        if (value >= def.tiers[i]) tierIndex = i;
        else break;
    }
    const maxed = tierIndex === def.tiers.length - 1;
    const nextTarget = maxed ? null : def.tiers[tierIndex + 1];
    const progress = nextTarget == null ? 1 : Math.min(1, value / nextTarget);
    return { def, value, tierIndex, earned: tierIndex >= 0, nextTarget, progress };
}

/** Score every achievement in the registry for one player. */
export function evaluateAchievements(metrics: PlayerMetrics): AchievementProgress[] {
    return ACHIEVEMENTS.map((def) => scoreAchievement(def, metrics));
}
