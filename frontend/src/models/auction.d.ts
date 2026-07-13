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
    /** Non-refundable deposit (in gears) the seller paid to list the auction,
     *  set by its duration in weeks. 0 when the duration is unknown. */
    depositFee: number;
    /**
     * How many in-game weeks the seller chose to list the auction for (the
     * listing length that sets the deposit above). Null/undefined when the
     * duration is unknown or the data predates this field.
     */
    durationWeeks?: number | null;
    state: "Active" | "Sold" | "SoldRetrieved" | "Expired";
    sold: boolean;
    /**
     * True when an unsold listing was pulled by the seller before its natural
     * expiry (it became retrievable ahead of its posting time plus the chosen
     * listing duration) rather than running its full, weeks-long term. Optional
     * for older data generated before this field existed.
     */
    cancelled?: boolean;
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
    /**
     * Point-in-time market reference: the median per-unit price the same item
     * sold for (from OTHER sellers) around the moment this listing was posted.
     * Time-consistent — independent of any viewer-selected window. Null when the
     * market never priced the item from anyone else. See
     * `compute_reference_prices` in `backend/process_auction_data.py`.
     */
    refPricePerUnit: number | null;
    /** How many comparable sold listings backed `refPricePerUnit` (confidence). */
    refSampleSize: number;
    /**
     * Signed percentage this listing's per-unit price sits above (+) or below
     * (−) the market reference: (pricePerUnit − ref) / ref × 100. Null when no
     * reference exists.
     */
    pricePremiumPct: number | null;
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
    /**
     * Quantity-weighted median per-unit sold price: each sold listing's per-unit
     * price weighted by the quantity it moved, so bulk trades dominate. `null`
     * when the item has no priced sales. Companion to `priceStats.median`.
     */
    weightedPricePerUnit: number | null;
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
    /** Total listing deposits sellers paid across all listings. */
    depositFeesPaid: number;
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

/**
 * Market activity for one in-game month bucket (keyed by posting time).
 * Every metric attributes an auction to the month it was posted in, including
 * its eventual sale outcome, so cumulative sums align with the market totals.
 */
export interface MarketTimePoint {
    /** Months since world start (bucket key). */
    monthIndex: number;
    /** In-game total hours at the start of the bucket (for date formatting). */
    gameHours: number;
    /** Auctions posted in this month. */
    posted: number;
    /** Of those, how many sold. */
    sold: number;
    /** Of those, how many expired unsold. */
    expired: number;
    unitsSold: number;
    gearsTraded: number;
    feesPaid: number;
    depositFeesPaid: number;
    deliveryFeesPaid: number;
    deliveredCount: number;
    /**
     * Auctions that existed this month but were never captured — inferred from
     * gaps in the sequential auction ids (ids strictly increase with posting
     * time). A measure of how complete the capture was over time.
     */
    missing: number;
    /**
     * Auctions posted this month that we only ever saw as "Active" — capture
     * stopped before a terminal verdict, so it's unknown whether they sold or
     * expired. Distinct from `missing` (never captured at all).
     */
    unrecorded: number;
    /** Sold / (sold + expired) for auctions posted this month; null if none resolved. */
    sellThrough: number | null;
    uniqueSellers: number;
    uniqueBuyers: number;
    uniqueItems: number;
}

export interface AuctionSummary {
    generatedUtc: string;
    totals: MarketTotals;
    itemStats: ItemStat[];
    /** Market activity bucketed by in-game posting month (oldest first). */
    timeSeries: MarketTimePoint[];
    /** In-game hours per time-series bucket (720 = one 30-day month). */
    timeSeriesBucketHours: number;
    /**
     * In-game total hours at the moment auction capture began (the game clock
     * during the initial board dump). Drawn as a "Started recording" marker on
     * the trend chart; null when it can't be estimated.
     */
    recordingStartGameHours: number | null;
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
    /**
     * The item's real in-game maximum stack size (from the game registry,
     * sniffed off the server join handshake). Null when unknown — e.g. synthetic
     * clutter/tapestry variant groups that don't map to a single registry id.
     */
    maxStackSize?: number | null;
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
    /** Quantity-weighted median per-unit sold price (bulk trades dominate). */
    weightedPricePerUnit: number | null;
    /**
     * The market never revealed a price ceiling for this item: no expired
     * listing was ever priced above the highest one that actually sold, so the
     * fair price is really a floor. Drives the "Upper price bound unknown" chip.
     */
    upperBoundUnknown: boolean;

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

// --------------------------------------------------------------------------- //
// Player profile analytics (computed client-side by `usePlayerProfile`)
// --------------------------------------------------------------------------- //

/** How a seller sets prices, from the spread of their own per-unit prices. */
export type SellerPricingStyle =
    | "stable" // holds consistent prices
    | "adjusting" // moderate price movement
    | "discoverer" // wide spread — probing for the right price
    | "insufficient";

/** How a buyer pays relative to the prevailing market reference. */
export type BuyerStyle =
    | "value" // tends to pay below market
    | "market" // pays around market
    | "eager" // tends to pay above market (neutral framing of "FOMO")
    | "insufficient";

/** How focused a player's activity is across items/categories. */
export type SpecializationTier = "specialist" | "focused" | "generalist";

/** Strength of a player's grip on a single item's supply or demand. */
export type DominanceTier = "leading" | "dominant" | "monopoly";

/** A single headline label summarising the player's trading behaviour. */
export type PlayerArchetype =
    | "price-discoverer"
    | "stable-seller"
    | "wholesaler"
    | "bargain-seller"
    | "value-buyer"
    | "eager-buyer"
    | "market-maker"
    | "monopolist"
    | "flipper"
    | "specialist"
    | "generalist"
    | "newcomer";

/** One item where the player holds a large share of the item's market. */
export interface PlayerDominanceRow {
    itemId: number;
    name: string;
    /** "sell" = share of the item's units sold; "buy" = share of units bought. */
    side: "sell" | "buy";
    /** Player's share of the item's market volume in the window (0–1). */
    share: number;
    /** Units the player moved on this side. */
    playerUnits: number;
    /** Listings (sell) or purchases (buy) the player made of this item. */
    playerTrades: number;
    /** Total market units on this side (all traders). */
    marketUnits: number;
    /** Distinct other traders on the same side (0 → sole participant). */
    otherTraders: number;
    tier: DominanceTier;
}

/** An item the player both buys and sells — a flip / arbitrage opportunity. */
export interface PlayerFlipRow {
    itemId: number;
    name: string;
    buyMedianPpu: number;
    sellMedianPpu: number;
    /** (sell − buy) / buy × 100; positive = resells higher. */
    marginPct: number;
    bought: number;
    sold: number;
}

/** A single trade that deviated most from the market reference. */
export interface PlayerNotableTrade {
    auctionId: number;
    itemId: number;
    name: string;
    variant?: string | null;
    pricePerUnit: number;
    refPricePerUnit: number;
    premiumPct: number;
    qty: number;
    postedTotalHours: number | null;
}

/** Per-item price dispersion behind the seller pricing-style verdict. */
export interface PlayerPricingHistoryPoint {
    /** In-game total hours the listing was posted. */
    gameHours: number;
    /** Player's per-unit asking price. */
    pricePerUnit: number;
    /** Market reference per-unit price at that time (null if none). */
    refPricePerUnit: number | null;
    /** Signed premium vs reference (null if no reference). */
    premiumPct: number | null;
    sold: boolean;
    name: string;
}

/** One in-game-month bucket of the player's activity cadence. */
export interface PlayerActivityPoint {
    monthIndex: number;
    gameHours: number;
    listed: number;
    sold: number;
    bought: number;
}

export interface PlayerProfile {
    windowDays: number | null;
    /** Listings posted as a seller (window-scoped, spam excluded). */
    sellerCount: number;
    /** Purchases made as a buyer (window-scoped, spam excluded). */
    buyerCount: number;

    // --- Behaviour classification ---
    sellerStyle: SellerPricingStyle;
    /** Aggregate coefficient of variation of the player's per-unit prices. */
    sellerPriceCV: number | null;
    buyerStyle: BuyerStyle;
    /** Median premium (%) the player paid over market on their purchases. */
    buyerMedianPremiumPct: number | null;
    /** Median premium (%) the player listed at vs market on their sales. */
    sellerMedianPremiumPct: number | null;
    /** Every headline label that applies, in display order (a trader can be
     * several things at once, e.g. Market Maker + Wholesaler). Always non-empty;
     * `["newcomer"]` when there's too little history. */
    archetypes: PlayerArchetype[];

    // --- Specialization ---
    specialization: SpecializationTier;
    /** HHI over the player's item mix (0–1; higher = more focused). */
    itemHhi: number | null;
    /** The category the player is most active in, if any. */
    topCategory: string | null;
    topCategoryShare: number | null;

    // --- Sections ---
    dominance: PlayerDominanceRow[];
    flips: PlayerFlipRow[];
    overpriced: PlayerNotableTrade[];
    underpriced: PlayerNotableTrade[];
    pricingHistory: PlayerPricingHistoryPoint[];
    activity: PlayerActivityPoint[];
}

