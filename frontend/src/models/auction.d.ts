// Shared types for the Auction House explorer. These mirror the artifacts
// produced by `backend/process_auction_data.py` and served from
// `frontend/public/auction/{listings,summary,items}.json`.

/** One deduplicated auction (latest observed state). */
export interface AuctionListing {
    auctionId: number;
    itemId: number;
    name: string;
    /**
     * The exact clutter object for this listing (e.g. "toy7"). Clutter is one
     * block id hiding dozens of distinct objects; the backend groups them under
     * a base item (e.g. "Toy") but each listing keeps its precise variant here.
     * Null for non-clutter items and generic clutter without a `type` attr.
     */
    variant?: string | null;
    category: string;
    classType: "Item" | "Block";
    attrs: Record<string, unknown> | null;
    price: number;
    qty: number;
    pricePerUnit: number;
    traderCut: number;
    state: "Active" | "Sold" | "SoldRetrieved" | "Expired";
    sold: boolean;
    /**
     * True once a terminal verdict (sold / retrieved / expired) was actually
     * observed. False means the listing is only known as "Active" because it
     * stopped being observed before it resolved — a last-known state, not a
     * confirmed live listing.
     */
    verdictObserved: boolean;
    delivered: boolean;
    /** Delivery fee (in gears) the buyer paid for a delivered listing; 0 for
     *  pickup listings. */
    deliveryFee: number;
    spam: boolean;
    sellerName: string | null;
    sellerUid: string | null;
    buyerName: string | null;
    buyerUid: string | null;
    srcX: number;
    srcZ: number;
    dstX: number;
    dstZ: number;
    tradeDistance: number | null;
    timeToSellHours: number | null;
    postedTotalHours: number | null;
    /**
     * In-game total hours at which the auction lapses. Together with the
     * current in-game clock (estimated from the newest posting) this tells
     * whether an unconfirmed "Active" listing has since expired.
     */
    expireTotalHours: number | null;
    observedUtc: string | null;
    lastObservedUtc: string | null;
}

export interface PriceStats {
    count: number;
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
    mean: number;
}

/**
 * Recent-vs-older price movement for an item's per-unit sold price. `null`
 * when there aren't enough dated sales to judge a trend.
 */
export interface PriceTrend {
    /** "up" / "down" past an ±8% dead-band, else "flat". */
    direction: "up" | "down" | "flat";
    /** Signed percentage change of recent median vs older median. */
    changePct: number;
    recentMedian: number;
    olderMedian: number;
    recentCount: number;
    olderCount: number;
}

export interface ItemStat {
    itemId: number;
    name: string;
    category: string;
    listings: number;
    soldCount: number;
    sellThrough: number | null;
    medianTimeToSell: number | null;
    unitsSold: number;
    gearsTraded: number;
    priceStats: PriceStats | null;
    trend: PriceTrend | null;
}

export interface SellerLeader {
    uid: string;
    name: string | null;
    revenue: number;
    sold: number;
    listed: number;
}

export interface BuyerLeader {
    uid: string;
    name: string | null;
    spent: number;
    bought: number;
}

export interface BiggestSale {
    auctionId: number;
    name: string;
    /** Exact clutter variant (e.g. "toy7"), when the sale was a clutter object. */
    variant?: string | null;
    itemId: number;
    price: number;
    qty: number;
    sellerName: string | null;
    buyerName: string | null;
}

export interface HeatmapBin {
    x: number;
    z: number;
    count: number;
}

export interface AuctioneerLocation {
    x: number;
    z: number;
    listings: number;
}

export interface MarketTotals {
    totalAuctions: number;
    activeListings: number;
    soldCount: number;
    expiredCount: number;
    gearsTraded: number;
    feesPaid: number;
    /** Total delivery fees buyers paid across all delivered sales. */
    deliveryFeesPaid: number;
    /** Number of sold listings that were delivered. */
    deliveredCount: number;
    /** Share of sold listings that used delivery (0–1). */
    deliveryRate: number;
    uniqueSellers: number;
    uniqueBuyers: number;
    uniqueItems: number;
    sellThrough: number;
    spamFiltered: number;
}

export interface AuctionSummary {
    generatedUtc: string;
    totals: MarketTotals;
    itemStats: ItemStat[];
    topSellers: SellerLeader[];
    topBuyers: BuyerLeader[];
    biggestSales: BiggestSale[];
    sellHeatmap: HeatmapBin[];
    buyHeatmap: HeatmapBin[];
    auctioneers: AuctioneerLocation[];
    heatmapBin: number;
}

export interface ItemCatalogEntry {
    name: string;
    category: string;
    code: string | null;
    classType: "Item" | "Block";
}

export type ItemCatalog = Record<string, ItemCatalogEntry>;

// --------------------------------------------------------------------------- //
// Market Insights (computed client-side by `useMarketInsights`)
// --------------------------------------------------------------------------- //

export type VolatilityTier = "stable" | "moderate" | "volatile";
export type DemandTier = "hot" | "high" | "normal" | "low";
export type LiquidityTier = "high" | "medium" | "low";
export type ConfidenceTier = "high" | "medium" | "low";
export type RecencyTier = "active" | "cooling" | "stale";
export type ConcentrationTier = "competitive" | "moderate" | "concentrated" | "monopoly";

/** All per-item indicators for the Market Insights screener, within a window. */
export interface InsightsRow {
    itemId: number;
    name: string;
    category: string;

    // --- Volume ---
    /** Sum of sale price over sold listings in the window (price volume). */
    gearsTraded: number;
    /** Sum of quantity over sold listings in the window (unit volume). */
    unitsSold: number;
    soldCount: number;
    /** All non-spam listings for the item observed in the window. */
    listings: number;
    /** Current listings still on the board (snapshot, window-independent). */
    activeListings: number;

    // --- Price ---
    priceStats: PriceStats | null;
    medianPricePerUnit: number | null;

    // --- Volatility ---
    /** Robust coefficient of variation: (p75 − p25) / median. */
    dispersionCV: number | null;
    volatilityTier: VolatilityTier | null;
    /** Recent-vs-older per-unit price movement. */
    trend: PriceTrend | null;

    // --- Liquidity / demand ---
    sellThrough: number | null;
    /** Median in-game hours from posting to sale. */
    medianTimeToSellHours: number | null;
    /** Sold listings per real day across the window. */
    salesVelocity: number;
    /** 0–100 composite of volume + speed + sell-through. */
    demandScore: number | null;
    demandTier: DemandTier | null;
    /** Demand outpaces the supply currently on the board. */
    shortage: boolean;
    /** 0–100 composite of sell-through + speed + listing frequency. */
    liquidityScore: number | null;
    liquidityTier: LiquidityTier | null;

    // --- Deals / arbitrage ---
    /** (median − p10) / median: how far cheap listings undercut the median. */
    dealScore: number | null;
    /** Count of active listings priced below the p25 fair-price band. */
    dealsAvailable: number;

    // --- Confidence ---
    confidence: ConfidenceTier;

    // --- Recency ---
    /** In-game total hours of the most recent sale (for in-game date display). */
    lastSaleGameHours: number | null;
    /** Real-world days since the most recent sale (anchored to latest sweep). */
    daysSinceLastSale: number | null;
    recencyTier: RecencyTier | null;

    // --- Seller concentration ---
    /** Herfindahl–Hirschman index over seller listing shares (0–1). */
    hhi: number | null;
    concentrationTier: ConcentrationTier | null;
    sellerCount: number;

    // --- Delivery ---
    /** Median delivered vs non-delivered per-unit price premium, in %. */
    deliveryPremiumPct: number | null;
}

export interface InsightsTotals {
    gearsTraded: number;
    unitsSold: number;
    soldCount: number;
    activeListings: number;
    sellThrough: number | null;
    uniqueItemsTraded: number;
    medianTimeToSellHours: number | null;
    /** Total delivery fees buyers paid across delivered sales in the window. */
    deliveryFeesPaid: number;
    /** Number of delivered sold listings in the window. */
    deliveredCount: number;
    /** Share of sold listings in the window that used delivery (0–1). */
    deliveryRate: number | null;
}

export interface MarketInsights {
    /** Chosen window in real days, or `null` for all-time. */
    windowDays: number | null;
    /** In-game "now" (total hours) the window is measured back from. */
    anchorGameHours: number;
    rows: InsightsRow[];
    totals: InsightsTotals;
}
