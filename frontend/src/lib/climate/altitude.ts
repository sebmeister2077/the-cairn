// Altitude adjustment for the climate rasters.
//
// The exported temperature/rainfall rasters are baked at the world's sea
// level (`anchorY`, distToSealevel = 0) — see the export manifest's
// `assumptions`. In-game, both temperature and rainfall shift with the
// actual build height, so the readout can restate a sampled sea-level
// value as "what you'll feel at your Y". Formulas mirror Vintage Story's
// `Vintagestory.API.Common.Climate` decode (see docs/vs-climate-formulas.md).

import { getClimateRootMeta } from "./loader";

/** World sea level = the Y at which the rasters were baked. */
export const CLIMATE_SEA_LEVEL = getClimateRootMeta().anchorY;

/** °C the game drops per block of elevation above sea level (1 / 6.375). */
const TEMP_LAPSE_PER_BLOCK = 1 / 6.375;

/** Client-side display clamp on real temperature (the gameplay clamp is
 *  [-20, 40], but the on-screen readout floors at -50). */
const TEMP_MIN_C = -50;
const TEMP_MAX_C = 40;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Restate a sea-level-baseline temperature (°C) as the real temperature
 *  at world height `y`. Above sea level it cools by the game's lapse rate;
 *  below it warms.
 *
 *  The exported temp rasters store *unclamped* seasonal extremes (tempmin
 *  reaches ~-52 °C, tempmax ~+42 °C), so we must not clip the baseline to
 *  the display range — doing so would alter the value even at sea level.
 *  We only clamp the altitude-induced overshoot into the client range,
 *  widening the bounds to include the baseline itself. */
export function adjustTemperatureForY(
    seaLevelTempC: number,
    y: number,
    sealevel: number = CLIMATE_SEA_LEVEL,
): number {
    const adjusted = seaLevelTempC - (y - sealevel) * TEMP_LAPSE_PER_BLOCK;
    const lo = Math.min(TEMP_MIN_C, seaLevelTempC);
    const hi = Math.max(TEMP_MAX_C, seaLevelTempC);
    return clamp(adjusted, lo, hi);
}

/** Restate a sea-level-baseline rainfall (0..1) as the real rainfall at
 *  world height `y`. The baked anchor already includes the full +40
 *  near-sea-level humidity bonus, so we recover the base byte before
 *  re-applying the height terms with the game's integer maths. */
export function adjustRainfallNormForY(
    seaLevelRainfallNorm: number,
    y: number,
    sealevel: number = CLIMATE_SEA_LEVEL,
): number {
    // Undo the sea-level bake: byte = base + trunc(0/2) + 5*clamp(8,0,8).
    const bakedByte = seaLevelRainfallNorm * 255;
    const baseByte = clamp(bakedByte - 40, 0, 255);
    const alt = Math.trunc((y - sealevel) / 2);
    const bonus = 5 * clamp(8 + sealevel - y, 0, 8);
    const byte = clamp(baseByte + alt + bonus, 0, 255);
    return byte / 255;
}
