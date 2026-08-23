// CSV export for the Market Insights screener. Emits a flat, spreadsheet-friendly
// row per item using the currently selected volume/price modes, so the exported
// "Volume" and "Price" columns match what's on screen. Values are the raw
// numbers (not the badge labels) so they can be sorted/charted downstream.

import type { InsightsRow } from "@/models/auction";
import type { MarketPriceMode } from "@/hooks/useMarketPriceMode";
import type { InsightsVolumeMode } from "@/hooks/useFilteredInsights";
import { rowPrice } from "@/hooks/useFilteredInsights";

function csvCell(v: string | number | null | undefined): string {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Round to `d` decimals, or empty string when null/undefined. */
function round(v: number | null | undefined, d = 2): number | "" {
    if (v == null || Number.isNaN(v)) return "";
    const f = 10 ** d;
    return Math.round(v * f) / f;
}

export function insightsToCsv(
    rows: InsightsRow[],
    volumeMode: InsightsVolumeMode,
    priceMode: MarketPriceMode,
): string {
    const volumeHeader = volumeMode === "price" ? "Volume (gears)" : "Volume (units)";
    const priceHeader = priceMode === "weighted" ? "Weighted/unit" : "Median/unit";
    const header = [
        "Item ID",
        "Item",
        "Category",
        volumeHeader,
        priceHeader,
        "Sold",
        "Volatility CV %",
        "Trend %",
        "Sell-through %",
        "Median time to sell (real h)",
        "Demand",
        "Liquidity",
        "Deal %",
        "Deals available",
        "HHI %",
        "Sellers",
        "Delivery premium %",
        "Confidence",
        "Days since last sale",
        "Upper bound unknown",
    ];

    const lines = rows.map((r) => {
        const volume = volumeMode === "price" ? r.gearsTraded : r.unitsSold;
        return [
            r.itemId,
            r.name,
            r.category,
            round(volume),
            round(rowPrice(r, priceMode)),
            r.soldCount,
            r.dispersionCV != null ? round(r.dispersionCV * 100, 0) : "",
            r.trend ? r.trend.changePct : "",
            r.sellThrough != null ? round(r.sellThrough * 100, 0) : "",
            round(r.medianTimeToSellHours),
            r.demandScore ?? "",
            r.liquidityScore ?? "",
            r.dealScore != null ? round(r.dealScore * 100, 0) : "",
            r.dealsAvailable,
            r.hhi != null ? round(r.hhi * 100, 0) : "",
            r.sellerCount,
            r.deliveryPremiumPct ?? "",
            r.confidence,
            round(r.daysSinceLastSale, 1),
            r.upperBoundUnknown ? "yes" : "",
        ]
            .map(csvCell)
            .join(",");
    });

    return [header.map(csvCell).join(","), ...lines].join("\r\n");
}

/** Build the CSV and trigger a client-side download. */
export function downloadInsightsCsv(
    rows: InsightsRow[],
    volumeMode: InsightsVolumeMode,
    priceMode: MarketPriceMode,
    windowLabel: string,
): void {
    const csv = insightsToCsv(rows, volumeMode, priceMode);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `market-insights-${windowLabel}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
