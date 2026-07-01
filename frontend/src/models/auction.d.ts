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
