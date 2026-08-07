// Resolves the effective per-trader-type marker colors: the default palette
// (`TRADER_TYPE_COLORS`) with the user's Preferences overrides applied. Every
// map/legend surface that shows trader-type colors should read from here so a
// user's custom colors stay consistent across the app.

import { useMemo } from "react";
import { useReduxState } from "@/store/hooks";
import { resolveTraderColors, type TraderType } from "@/lib/trader-types";

export function useTraderColors(): Record<TraderType, string> {
    const overrides = useReduxState("mapView.traderColors");
    return useMemo(() => resolveTraderColors(overrides), [overrides]);
}
