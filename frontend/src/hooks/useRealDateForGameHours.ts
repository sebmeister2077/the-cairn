import { useMemo } from "react";
import { useAuctionSummary, getCurrentGameHours, getLatestObservedUtc } from "@/lib/auction";
import { GAME_HOURS_PER_REAL_DAY } from "@/hooks/useMarketInsights";
import { makeGameHoursToRealIso } from "@/components/market/DualDateAxisTick";

/**
 * Reusable mapping from an in-game total-hours value to its real-world date.
 * Anchors on the live app clock (exact sweep time ↔ game clock) when available,
 * falling back to the summary's generation time mapped to the end of the last
 * bucket. The returned function yields null when no usable anchor exists.
 */
export function useRealDateForGameHours(): (gameHours: number | null | undefined) => string | null {
    const { data } = useAuctionSummary();
    return useMemo(() => {
        const clockHours = getCurrentGameHours();
        const clockUtc = getLatestObservedUtc();
        const haveClock = clockHours > 0 && clockUtc !== "";
        const maxSeriesHours = (data?.timeSeries ?? []).reduce((m, p) => Math.max(m, p.gameHours), 0);
        const anchorGameHours = haveClock
            ? clockHours
            : maxSeriesHours + (data?.timeSeriesBucketHours ?? 0);
        const anchorRealMs = haveClock
            ? Date.parse(clockUtc)
            : data
                ? Date.parse(data.generatedUtc)
                : NaN;
        const toIso = makeGameHoursToRealIso(anchorGameHours, anchorRealMs, GAME_HOURS_PER_REAL_DAY);
        return (gameHours: number | null | undefined) =>
            gameHours == null ? null : toIso(gameHours);
    }, [data]);
}
