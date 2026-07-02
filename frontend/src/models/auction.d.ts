// Shared types for the Auction House explorer. These mirror the artifacts
// produced by `backend/process_auction_data.py` and served from
// `frontend/public/auction/{listings,summary,items}.json`.

/** One deduplicated auction (latest observed state). */
export interface AuctionListing {
    auctionId: number;
    itemId: number;
    name: string;
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
