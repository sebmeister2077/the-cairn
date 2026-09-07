// All-time player achievements, memoised on the shared listings + uid.
//
// Deliberately window-independent (unlike `usePlayerProfile`): achievements are
// permanent, so they're computed over every listing a player ever made.

import { useMemo } from "react";
import {
    computePlayerMetrics,
    evaluateAchievements,
    type AchievementProgress,
} from "@/lib/achievements";
import type { AuctionListing } from "@/models/auction";

export function usePlayerAchievements(
    listings: AuctionListing[] | undefined,
    uid: string,
): AchievementProgress[] {
    return useMemo(
        () => evaluateAchievements(computePlayerMetrics(listings, uid)),
        [listings, uid],
    );
}
