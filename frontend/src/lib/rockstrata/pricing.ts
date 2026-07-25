// Pure rock rarity/pricing model shared by the Rarity page and its Redux
// slice. Ported from the offline generator
// [assets/RockStrata/generate_prices_fods.ts] so the website computes the
// exact same numbers as the "Prices" sheet of `rock-prices.fods`.
//
// Model in one breath: the tops map only reveals the *surface* rock type, so
// each rock's on-map pixel share is a proxy for how common it is. Igneous
// strata are far taller underground than they appear on the surface, so their
// pixel counts are multiplied by a boost. Rarity is then expressed relative to
// granite (the most common rock = ratio 1.0): a rock covering half as much
// boosted area is twice as rare. Prices scale that rarity through one of three
// curves, and each aged variant multiplies the ashlar price.

import type { LegendEntry } from "./types";

/** Rocks whose surface pixel share is boosted to reflect tall igneous strata. */
export const IGNEOUS_ROCKS: ReadonlySet<string> = new Set([
    "rock-granite",
    "rock-andesite",
    "rock-basalt",
    "rock-peridotite",
]);

/** Pricing is expressed relative to this rock (ratio 1.0). */
export const REFERENCE_ROCK = "rock-granite";

export type RarityCurve = "linear" | "sqrt" | "log";

export interface RockPricingConfig {
    /** Base price of the reference rock's aged ashlar (rusty gears). */
    base: number;
    /** Multiplier applied to igneous rocks' raw pixel counts. */
    boost: number;
    /** Aged Polished price = ashlar × this. */
    polished: number;
    /** Aged Cracked/Cobbled price = ashlar × this. */
    cracked: number;
    /** Which rarity → price curve to apply. */
    curve: RarityCurve;
}

/** Defaults mirror the "Prices" sheet of rock-prices.fods (18 / 3 / 3 / 8). */
export const DEFAULT_ROCK_PRICING: RockPricingConfig = {
    base: 18,
    boost: 3,
    polished: 3,
    cracked: 8,
    curve: "sqrt",
};

export interface RockPriceRow {
    code: string;
    /** Human-friendly name, e.g. "rock-granite" → "Granite". */
    label: string;
    /** "#RRGGBB" swatch colour from the legend. */
    hexcolor: string;
    isIgneous: boolean;
    /** True for the reference rock (granite), whose ratio is pinned to 1.0. */
    isReference: boolean;
    rawPx: number;
    /** Share of the total boosted pixel area (0–1). */
    boostedPct: number;
    /** Rarity relative to the reference rock (granite = 1.0, rarer > 1). */
    ratio: number;
    ashlar: number;
    polished: number;
    cracked: number;
}

/** "rock-granite" → "Granite"; also tidies any dashes/underscores. */
export function prettifyRockCode(code: string): string {
    const bare = code
        .replace(/^rock-/, "")
        .replace(/[-_]+/g, " ")
        .trim();
    return bare.replace(/\b\w/g, (c) => c.toUpperCase());
}

function curveValue(curve: RarityCurve, base: number, ratio: number): number {
    switch (curve) {
        case "linear":
            return base * ratio;
        case "log":
            // Clamp the log argument and the result exactly like the generator
            // so very common rocks never price below 1.
            return Math.max(1, base * (1 + Math.log(Math.max(ratio, 1e-7))));
        case "sqrt":
        default:
            return base * Math.sqrt(ratio);
    }
}

/**
 * Compute per-rock rarity and prices for the given config. Returns rows sorted
 * rarest-first (highest ratio), so the reference rock (granite) sits last.
 */
export function computeRockPricing(
    legend: readonly LegendEntry[],
    config: RockPricingConfig,
): RockPriceRow[] {
    const boostFactor = (code: string) => (IGNEOUS_ROCKS.has(code) ? config.boost : 1);
    const boostedTotal = legend.reduce(
        (acc, e) => acc + e.pixelCount * boostFactor(e.code),
        0,
    );
    const reference = legend.find((e) => e.code === REFERENCE_ROCK);
    const referencePct =
        reference && boostedTotal > 0
            ? (reference.pixelCount * boostFactor(reference.code)) / boostedTotal
            : 0;

    const rows: RockPriceRow[] = legend.map((e) => {
        const boostedPx = e.pixelCount * boostFactor(e.code);
        const boostedPct = boostedTotal > 0 ? boostedPx / boostedTotal : 0;
        const ratio =
            boostedPct === 0 || referencePct === 0 ? 0 : referencePct / boostedPct;
        const ashlarRaw = curveValue(config.curve, config.base, ratio);
        return {
            code: e.code,
            label: prettifyRockCode(e.code),
            hexcolor: e.hexcolor,
            isIgneous: IGNEOUS_ROCKS.has(e.code),
            isReference: e.code === REFERENCE_ROCK,
            rawPx: e.pixelCount,
            boostedPct,
            ratio,
            // Round once for the ashlar, but multiply the *un-rounded* ashlar
            // for the variants (matching the generator's rounding order).
            ashlar: Math.round(ashlarRaw),
            polished: Math.round(ashlarRaw * config.polished),
            cracked: Math.round(ashlarRaw * config.cracked),
        };
    });

    rows.sort((a, b) => b.ratio - a.ratio);
    return rows;
}
