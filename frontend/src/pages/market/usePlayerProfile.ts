// Client-side player-profile analytics for the Auction House explorer.
//
// Mirrors the approach of `useMarketInsights`: the full `listings.json` is
// already loaded, so rather than precompute per-player/per-window metrics in the
// backend we aggregate on demand here. Everything is scoped to the player's own
// (separate) time window and excludes spam. The one thing we DON'T recompute is
// the market reference price a listing was posted against — that's the
// time-consistent `refPricePerUnit` baked into each row by the backend.
//
// Framing note: the behaviour labels are intentionally neutral. "Eager buyer"
// (not "FOMO"), "price discoverer" (not "erratic"), "bargain seller" (not
// "underseller"). We describe habits, we don't judge them.

import { useMemo } from "react";
import { percentileSorted, listingHasText, specializationGroupFor } from "@/lib/auction";
import { filterListingsByWindow } from "./useMarketInsights";
import type {
    AuctionListing,
    BuyerStyle,
    DominanceTier,
    PlayerActivityPoint,
    PlayerArchetype,
    PlayerDominanceRow,
    PlayerFlipRow,
    PlayerNotableTrade,
    PlayerPricingHistoryPoint,
    PlayerProfile,
    SellerPricingStyle,
    SpecializationTier,
} from "@/models/auction";

/** Minimum total activity (listings + purchases) before we assign a headline
 * archetype — below this the player has too little history to characterise. */
export const PLAYER_MIN_TRADES = 15;
/** Per-sub-metric minimum sample before a behaviour card commits to a verdict. */
const MIN_STYLE_SAMPLE = 5;
/** A listing's reference must be backed by at least this many comparable sales
 * before its premium counts toward a median (keeps sparse refs from skewing). */
const MIN_REF_SAMPLE = 3;
/** In-game hours per in-game month — the activity-cadence bucket size. */
const GAME_HOURS_PER_MONTH = 720;
/** A player needs at least this share of an item's volume to be flagged as
 * concentrating it, and enough absolute volume for the share to be meaningful. */
const DOMINANCE_MIN_SHARE = 0.4;
const DOMINANCE_MIN_UNITS = 5;
/** Minimum listings/purchases the player must have of an item (on a side)
 * before we'll call it concentration — one lucky trade in a thin market is not
 * a monopoly. */
const DOMINANCE_MIN_TRADES = 3;

function median(vals: number[]): number | null {
    if (!vals.length) return null;
    const s = [...vals].sort((a, b) => a - b);
    return percentileSorted(s, 0.5);
}

/** Robust coefficient of variation: (p75 − p25) / median. Needs ≥3 points. */
function robustCV(ppu: number[]): number | null {
    if (ppu.length < 3) return null;
    const s = [...ppu].sort((a, b) => a - b);
    const med = percentileSorted(s, 0.5);
    if (med <= 0) return null;
    return (percentileSorted(s, 0.75) - percentileSorted(s, 0.25)) / med;
}

function sellerStyleFor(cv: number | null, sample: number): SellerPricingStyle {
    if (cv == null || sample < MIN_STYLE_SAMPLE) return "insufficient";
    if (cv < 0.15) return "stable";
    if (cv < 0.4) return "adjusting";
    return "discoverer";
}

function buyerStyleFor(medianPremium: number | null, sample: number): BuyerStyle {
    if (medianPremium == null || sample < MIN_STYLE_SAMPLE) return "insufficient";
    if (medianPremium < -5) return "value";
    if (medianPremium > 8) return "eager";
    return "market";
}

function specializationFor(hhi: number | null): SpecializationTier {
    if (hhi == null) return "generalist";
    if (hhi > 0.5) return "specialist";
    if (hhi > 0.3) return "focused";
    return "generalist";
}

function dominanceTierFor(share: number, otherTraders: number): DominanceTier {
    if (otherTraders === 0) return "monopoly";
    if (share >= 0.6) return "dominant";
    return "leading";
}

/** Whether a listing carries a usable market reference for premium comparisons. */
function hasUsableRef(l: AuctionListing): boolean {
    return (
        l.refPricePerUnit != null &&
        l.pricePremiumPct != null &&
        l.refSampleSize >= MIN_REF_SAMPLE &&
        !listingHasText(l)
    );
}

/**
 * Compute a full player profile for `uid` within `windowDays` (null = all time)
 * from the shared listings dataset. Memoised on its inputs.
 */
export function usePlayerProfile(
    listings: AuctionListing[] | undefined,
    uid: string,
    windowDays: number | null,
): PlayerProfile {
    return useMemo(() => {
        const clean = (listings ?? []).filter((l) => !l.spam && !l.externalTrade);
        const windowed = filterListingsByWindow(clean, windowDays);

        const asSeller = windowed.filter((l) => l.sellerUid === uid);
        const asSellerSold = asSeller.filter((l) => l.sold);
        const asBuyer = windowed.filter((l) => l.buyerUid === uid && l.sold);

        const sellerCount = asSeller.length;
        const buyerCount = asBuyer.length;
        const totalTrades = sellerCount + buyerCount;

        // --- Seller pricing style: dispersion of the player's own prices ----- #
        const sellerByItem = new Map<number, number[]>();
        for (const l of asSeller) {
            if (listingHasText(l)) continue;
            const arr = sellerByItem.get(l.itemId);
            if (arr) arr.push(l.pricePerUnit);
            else sellerByItem.set(l.itemId, [l.pricePerUnit]);
        }
        let cvNum = 0;
        let cvDen = 0;
        for (const ppu of sellerByItem.values()) {
            const cv = robustCV(ppu);
            if (cv != null) {
                cvNum += cv * ppu.length;
                cvDen += ppu.length;
            }
        }
        const sellerPriceCV = cvDen ? cvNum / cvDen : null;
        const sellerStyle = sellerStyleFor(sellerPriceCV, cvDen);

        // --- Premium vs market (buyer + seller) ------------------------------ #
        const buyerPremiums = asBuyer
            .filter(hasUsableRef)
            .map((l) => l.pricePremiumPct as number);
        const buyerMedianPremiumPct = median(buyerPremiums);
        const buyerStyle = buyerStyleFor(buyerMedianPremiumPct, buyerPremiums.length);

        const sellerPremiums = asSellerSold
            .filter(hasUsableRef)
            .map((l) => l.pricePremiumPct as number);
        const sellerMedianPremiumPct = median(sellerPremiums);

        // --- Specialization: HHI over the player's category mix -------------- #
        // Measured across *grouped* categories (see `specializationGroupFor`)
        // rather than individual items: a smith who sells 50 distinct tools, or
        // a tailor moving dozens of different clothes, is concentrated on one
        // thing — even though every item is unique. Grouping folds tool/metal
        // forms together so those traders read as specialists, not generalists.
        const byCategory = new Map<string, number>();
        for (const l of [...asSeller, ...asBuyer]) {
            const group = specializationGroupFor(l.category);
            byCategory.set(group, (byCategory.get(group) ?? 0) + 1);
        }
        const mixTotal = [...byCategory.values()].reduce((s, c) => s + c, 0);
        let categoryHhi: number | null = null;
        if (mixTotal > 0) {
            categoryHhi = 0;
            for (const c of byCategory.values()) {
                const share = c / mixTotal;
                categoryHhi += share * share;
            }
        }
        const specialization = specializationFor(categoryHhi);
        let topCategory: string | null = null;
        let topCategoryShare: number | null = null;
        if (mixTotal > 0) {
            let best = -1;
            for (const [cat, c] of byCategory) {
                if (c > best) {
                    best = c;
                    topCategory = cat;
                }
            }
            topCategoryShare = best / mixTotal;
        }

        // --- Dominance / monopolies (sell + buy side) ------------------------ #
        // Per item: total units sold by everyone, plus the player's own units /
        // trade count on each side and the distinct set of OTHER traders they
        // compete with. We only aggregate items the player actually trades (a
        // handful, not the whole ~1.7k catalogue) — both for correctness and to
        // keep the profile snappy on heavy traders.
        interface ItemAgg {
            name: string;
            marketUnits: number;
            playerSellUnits: number;
            playerBuyUnits: number;
            playerSellCount: number;
            playerBuyCount: number;
            otherSellers: Set<string>;
            otherBuyers: Set<string>;
        }
        const playerItems = new Set<number>();
        for (const l of asSellerSold) playerItems.add(l.itemId);
        for (const l of asBuyer) playerItems.add(l.itemId);

        const itemAgg = new Map<number, ItemAgg>();
        const ensure = (id: number, name: string): ItemAgg => {
            let a = itemAgg.get(id);
            if (!a) {
                a = {
                    name,
                    marketUnits: 0,
                    playerSellUnits: 0,
                    playerBuyUnits: 0,
                    playerSellCount: 0,
                    playerBuyCount: 0,
                    otherSellers: new Set(),
                    otherBuyers: new Set(),
                };
                itemAgg.set(id, a);
            }
            return a;
        };
        for (const l of windowed) {
            if (!l.sold || !playerItems.has(l.itemId)) continue;
            const a = ensure(l.itemId, l.name);
            a.marketUnits += l.qty;
            if (l.sellerUid === uid) {
                a.playerSellUnits += l.qty;
                a.playerSellCount += 1;
            } else if (l.sellerUid) a.otherSellers.add(l.sellerUid);
            if (l.buyerUid === uid) {
                a.playerBuyUnits += l.qty;
                a.playerBuyCount += 1;
            } else if (l.buyerUid) a.otherBuyers.add(l.buyerUid);
        }
        const dominance: PlayerDominanceRow[] = [];
        for (const [itemId, a] of itemAgg) {
            if (a.marketUnits < DOMINANCE_MIN_UNITS) continue;
            if (a.playerSellCount >= DOMINANCE_MIN_TRADES && a.playerSellUnits > 0) {
                const share = a.playerSellUnits / a.marketUnits;
                if (share >= DOMINANCE_MIN_SHARE) {
                    dominance.push({
                        itemId,
                        name: a.name,
                        side: "sell",
                        share,
                        playerUnits: a.playerSellUnits,
                        playerTrades: a.playerSellCount,
                        marketUnits: a.marketUnits,
                        otherTraders: a.otherSellers.size,
                        tier: dominanceTierFor(share, a.otherSellers.size),
                    });
                }
            }
            if (a.playerBuyCount >= DOMINANCE_MIN_TRADES && a.playerBuyUnits > 0) {
                const share = a.playerBuyUnits / a.marketUnits;
                if (share >= DOMINANCE_MIN_SHARE) {
                    dominance.push({
                        itemId,
                        name: a.name,
                        side: "buy",
                        share,
                        playerUnits: a.playerBuyUnits,
                        playerTrades: a.playerBuyCount,
                        marketUnits: a.marketUnits,
                        otherTraders: a.otherBuyers.size,
                        tier: dominanceTierFor(share, a.otherBuyers.size),
                    });
                }
            }
        }
        // Rank by grip strength then absolute footprint.
        dominance.sort((x, y) => y.share - x.share || y.playerUnits - x.playerUnits);

        // --- Flips: items the player both buys and sells --------------------- #
        const buyByItem = new Map<number, { name: string; ppu: number[] }>();
        for (const l of asBuyer) {
            if (listingHasText(l)) continue;
            const e = buyByItem.get(l.itemId);
            if (e) e.ppu.push(l.pricePerUnit);
            else buyByItem.set(l.itemId, { name: l.name, ppu: [l.pricePerUnit] });
        }
        const sellByItem = new Map<number, number[]>();
        for (const l of asSellerSold) {
            if (listingHasText(l)) continue;
            const arr = sellByItem.get(l.itemId);
            if (arr) arr.push(l.pricePerUnit);
            else sellByItem.set(l.itemId, [l.pricePerUnit]);
        }
        const flips: PlayerFlipRow[] = [];
        for (const [itemId, buy] of buyByItem) {
            const sellPpu = sellByItem.get(itemId);
            if (!sellPpu) continue;
            const buyMed = median(buy.ppu);
            const sellMed = median(sellPpu);
            if (buyMed == null || sellMed == null || buyMed <= 0) continue;
            flips.push({
                itemId,
                name: buy.name,
                buyMedianPpu: Math.round(buyMed * 100) / 100,
                sellMedianPpu: Math.round(sellMed * 100) / 100,
                marginPct: Math.round(((sellMed - buyMed) / buyMed) * 1000) / 10,
                bought: buy.ppu.length,
                sold: sellPpu.length,
            });
        }
        flips.sort((a, b) => b.marginPct - a.marginPct);

        // --- Best / worst trades vs market (their sales) --------------------- #
        const notable = (l: AuctionListing): PlayerNotableTrade => ({
            auctionId: l.auctionId,
            itemId: l.itemId,
            name: l.name,
            variant: l.variant,
            pricePerUnit: l.pricePerUnit,
            refPricePerUnit: l.refPricePerUnit as number,
            premiumPct: l.pricePremiumPct as number,
            qty: l.qty,
            postedTotalHours: l.postedTotalHours,
        });
        const refSales = asSellerSold.filter(hasUsableRef);
        const overpriced = [...refSales]
            .sort((a, b) => (b.pricePremiumPct as number) - (a.pricePremiumPct as number))
            .slice(0, 5)
            .filter((l) => (l.pricePremiumPct as number) > 0)
            .map(notable);
        const underpriced = [...refSales]
            .sort((a, b) => (a.pricePremiumPct as number) - (b.pricePremiumPct as number))
            .slice(0, 5)
            .filter((l) => (l.pricePremiumPct as number) < 0)
            .map(notable);

        // --- Pricing history (chart): player price vs market ref over time --- #
        const pricingHistory: PlayerPricingHistoryPoint[] = asSeller
            .filter((l) => l.postedTotalHours != null && !listingHasText(l))
            .map((l) => ({
                gameHours: l.postedTotalHours as number,
                pricePerUnit: l.pricePerUnit,
                refPricePerUnit: l.refPricePerUnit,
                premiumPct: l.pricePremiumPct,
                sold: l.sold,
                name: l.name,
            }))
            .sort((a, b) => a.gameHours - b.gameHours);

        // --- Activity cadence (per in-game month) ---------------------------- #
        const activityMap = new Map<number, PlayerActivityPoint>();
        const bucket = (hours: number | null): PlayerActivityPoint | null => {
            if (hours == null) return null;
            const monthIndex = Math.floor(hours / GAME_HOURS_PER_MONTH);
            let p = activityMap.get(monthIndex);
            if (!p) {
                p = {
                    monthIndex,
                    gameHours: monthIndex * GAME_HOURS_PER_MONTH,
                    listed: 0,
                    sold: 0,
                    bought: 0,
                };
                activityMap.set(monthIndex, p);
            }
            return p;
        };
        for (const l of asSeller) {
            const p = bucket(l.postedTotalHours);
            if (!p) continue;
            p.listed += 1;
            if (l.sold) p.sold += 1;
        }
        for (const l of asBuyer) {
            const p = bucket(l.postedTotalHours);
            if (p) p.bought += 1;
        }
        const activity = [...activityMap.values()].sort(
            (a, b) => a.monthIndex - b.monthIndex,
        );

        // --- Easter-egg signals (rare, whimsical bonus labels) --------------- #
        // Time-of-day of every trade the player posted (game hours wrap every 24).
        const postHours = [...asSeller, ...asBuyer]
            .map((l) => l.postedTotalHours)
            .filter((h): h is number => h != null);
        let nightCount = 0;
        for (const h of postHours) {
            const hod = (((h % 24) + 24) % 24) | 0;
            if (hod >= 20 || hod < 5) nightCount += 1; // dusk-to-dawn, when drifters roam
        }
        const nightSample = postHours.length;
        const nightShare = nightSample ? nightCount / nightSample : null;

        // Fraction of the player's own priced listings that end in a tidy round number.
        const roundPrices = asSeller
            .filter((l) => !listingHasText(l))
            .map((l) => l.pricePerUnit)
            .filter((p) => Number.isFinite(p) && p >= 10);
        const roundSample = roundPrices.length;
        const roundShare = roundSample
            ? roundPrices.filter((p) => p % 10 === 0).length / roundSample
            : null;

        // Hand-chiseled art blocks the player put up for sale.
        const chiselCount = asSeller.filter((l) => l.chisel != null).length;

        // Pickup habit across their purchases. Delivery is the norm, so buying
        // in volume yet collecting in person is the notable behaviour.
        const pickupSample = asBuyer.length;
        const pickupCount = asBuyer.filter((l) => !l.delivered).length;
        const pickupShare = pickupSample ? pickupCount / pickupSample : null;

        // How quickly their sold listings moved.
        const sellTimes = asSellerSold
            .map((l) => l.timeToSellHours)
            .filter((h): h is number => h != null);
        const sellTimeSample = sellTimes.length;
        const medianSellHours = median(sellTimes);

        // How often they pull listings before a verdict lands (needs a known one).
        const resolved = asSeller.filter((l) => l.verdictObserved);
        const cancelSample = resolved.length;
        const cancelShare = cancelSample
            ? resolved.filter((l) => l.cancelled).length / cancelSample
            : null;

        // --- Headline archetype ---------------------------------------------- #
        const archetypes = deriveArchetypes({
            totalTrades,
            sellerCount,
            buyerCount,
            sellerStyle,
            buyerStyle,
            sellerMedianPremiumPct,
            dominance,
            flips,
            asSellerSold,
            specialization,
            nightShare,
            nightSample,
            roundShare,
            roundSample,
            chiselCount,
            pickupShare,
            pickupSample,
            pickupCount,
            medianSellHours,
            sellTimeSample,
            cancelShare,
            cancelSample,
        });

        return {
            windowDays,
            sellerCount,
            buyerCount,
            sellerStyle,
            sellerPriceCV,
            buyerStyle,
            buyerMedianPremiumPct,
            sellerMedianPremiumPct,
            archetypes,
            specialization,
            categoryHhi,
            topCategory,
            topCategoryShare,
            dominance,
            flips,
            overpriced,
            underpriced,
            pricingHistory,
            activity,
        } satisfies PlayerProfile;
    }, [listings, uid, windowDays]);
}

interface ArchetypeInput {
    totalTrades: number;
    sellerCount: number;
    buyerCount: number;
    sellerStyle: SellerPricingStyle;
    buyerStyle: BuyerStyle;
    sellerMedianPremiumPct: number | null;
    dominance: PlayerDominanceRow[];
    flips: PlayerFlipRow[];
    asSellerSold: AuctionListing[];
    specialization: SpecializationTier;
    /** Share (0–1) of trades posted at night, and the sample behind it. */
    nightShare: number | null;
    nightSample: number;
    /** Share (0–1) of priced listings ending in a round number, and its sample. */
    roundShare: number | null;
    roundSample: number;
    /** Count of hand-chiseled art blocks the player listed. */
    chiselCount: number;
    /** Share (0–1) of purchases the player picked up in person, plus counts. */
    pickupShare: number | null;
    pickupSample: number;
    pickupCount: number;
    /** Median in-game hours their sold listings took to sell, and its sample. */
    medianSellHours: number | null;
    sellTimeSample: number;
    /** Share (0–1) of resolved listings the player cancelled early, and its sample. */
    cancelShare: number | null;
    cancelSample: number;
}

/** Pick every headline label that applies, in display-priority order. A trader
 * can be several things at once (e.g. Market Maker + Wholesaler + Specialist),
 * so labels stack across independent dimensions: structural role(s), a single
 * seller-pricing style, a single buyer style, and focus. All neutral. */
function deriveArchetypes(i: ArchetypeInput): PlayerArchetype[] {
    if (i.totalTrades < PLAYER_MIN_TRADES) return ["newcomer"];

    const labels: PlayerArchetype[] = [];

    // --- Structural roles (can co-occur) --------------------------------- #
    // A monopoly / dominant grip on an item they sell.
    if (i.dominance.some((d) => d.side === "sell" && d.tier !== "leading")) {
        labels.push("monopolist");
    }
    // Substantial two-sided activity.
    if (i.sellerCount >= 10 && i.buyerCount >= 10) labels.push("market-maker");
    // Buys and resells the same items at a positive margin.
    if (i.buyerCount >= 5 && i.flips.some((f) => f.marginPct > 10)) labels.push("flipper");
    // Bulk seller: consistently large lot sizes.
    if (i.asSellerSold.length >= 5) {
        const medQty = median(i.asSellerSold.map((l) => l.qty)) ?? 0;
        if (medQty >= 20) labels.push("wholesaler");
    }

    // --- Seller pricing style (at most one) ------------------------------ #
    if (i.sellerCount >= 5) {
        if (i.sellerStyle === "discoverer") labels.push("price-discoverer");
        else if (i.sellerMedianPremiumPct != null && i.sellerMedianPremiumPct <= -12) {
            labels.push("bargain-seller");
        } else if (i.sellerStyle === "stable") labels.push("stable-seller");
    }

    // --- Buyer style (at most one) --------------------------------------- #
    if (i.buyerCount >= 5) {
        if (i.buyerStyle === "eager") labels.push("eager-buyer");
        else if (i.buyerStyle === "value") labels.push("value-buyer");
    }

    // --- Focus ----------------------------------------------------------- #
    if (i.specialization === "specialist") labels.push("specialist");

    // Nothing notable stood out — fall back to a plain focus descriptor.
    if (labels.length === 0) labels.push("generalist");

    // --- Easter eggs (rare, whimsical bonuses that stack on the above) ---- #
    // 🦉 Night Owl: trades overwhelmingly after dark.
    if (i.nightSample >= 12 && i.nightShare != null && i.nightShare >= 0.66) {
        labels.push("night-owl");
    }
    // 🪙 Round-Number Merchant: can't resist a tidy price.
    if (i.roundSample >= 12 && i.roundShare != null && i.roundShare >= 0.8) {
        labels.push("round-number-merchant");
    }
    // 🐉 Dragon's Hoard: the extreme tier above Monopolist — a near-total grip.
    const monopolies = i.dominance.filter((d) => d.tier === "monopoly");
    if (monopolies.length >= 2) {
        labels.push("dragons-hoard");
    }
    // 🎨 Master Chiseler: sells a pile of hand-chiseled art blocks.
    if (i.chiselCount >= 12) labels.push("master-chiseler");
    // 🥾 Legwork: buys plenty but skips delivery — collects the goods in person.
    if (i.pickupSample >= 10 && i.pickupCount >= 8 && i.pickupShare != null && i.pickupShare >= 0.5) {
        labels.push("legwork");
    }
    // ⚡ Hot Hands: their listings sell almost immediately.
    if (i.sellTimeSample >= 10 && i.medianSellHours != null && i.medianSellHours <= 4) {
        labels.push("hot-hands");
    }
    // 🧊 Cold Feet: often pulls listings before they resolve.
    if (i.cancelSample >= 10 && i.cancelShare != null && i.cancelShare >= 0.4) {
        labels.push("cold-feet");
    }
    // ✨ The Answer: exactly 42 trades.
    if (i.totalTrades === 42) labels.push("the-answer");
    // 🎰 Lucky Sevens: exactly 777 trades.
    if (i.totalTrades === 777) labels.push("lucky-sevens");

    return labels;
}
