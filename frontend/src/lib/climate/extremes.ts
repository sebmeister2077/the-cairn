// Momentary in-game temperature extremes vs. the exported *seasonal-mean*
// rasters.
//
// The temperature rasters store the coldest / warmest monthly MEAN at sea
// level (see the export manifest: "seasonal extremes only, excludes
// diurnal swing 5..18 °C and weather noise ~±2 °C"). But crops are damaged
// by the *momentary* temperature, which on the coldest winter nights runs
// well below that seasonal mean once the day-night swing and weather noise
// are added.
//
// The margins below are calibrated against in-game observation: a Y122
// location whose seasonal-min readout showed +2.9 °C dropped to roughly
// -11 °C on the coldest winter nights — killing crops limited to -6 °C
// while rye (limit -12 °C) survived. That implies a cold-snap drop of
// ~14 °C below the seasonal mean (within the documented 18 °C diurnal +
// 2 °C noise envelope). The heat rise is smaller and less critical.

/** How far the coldest winter night drops below the seasonal-mean minimum. */
export const COLD_SNAP_DROP_C = 14;

/** How far the hottest summer day rises above the seasonal-mean maximum. */
export const HEAT_PEAK_RISE_C = 8;

/** Estimated coldest momentary temperature (°C) from a seasonal-mean min. */
export function coldestNight(seasonalMinC: number): number {
    return seasonalMinC - COLD_SNAP_DROP_C;
}

/** Estimated hottest momentary temperature (°C) from a seasonal-mean max. */
export function hottestDay(seasonalMaxC: number): number {
    return seasonalMaxC + HEAT_PEAK_RISE_C;
}
