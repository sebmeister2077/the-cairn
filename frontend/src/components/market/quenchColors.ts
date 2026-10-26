// A "quench power" (temper boost) heat scale shared by the market tool charts.
// Quenching a hot tool head during smithing rolls a permanent stat boost; the
// higher the boost the "hotter" the colour, so a glance separates weakly- from
// strongly-quenched tools on both the price-history dots and the quench chart.

export interface QuenchTier {
    /** Inclusive lower bound of the boost fraction (0.2 = +20%). */
    min: number;
    /** Human label for the legend (e.g. "20–30%"). */
    label: string;
    /** Colour for this tier's dots/bars. */
    color: string;
}

// Ordered low→high. A tool's tier is the last one whose `min` it reaches.
export const QUENCH_TIERS: QuenchTier[] = [
    { min: 0, label: "<10%", color: "#64748b" }, // slate
    { min: 0.1, label: "10–20%", color: "#38bdf8" }, // sky
    { min: 0.2, label: "20–30%", color: "#22c55e" }, // green
    { min: 0.3, label: "30–40%", color: "#eab308" }, // amber
    { min: 0.4, label: "40–50%", color: "#f97316" }, // orange
    { min: 0.5, label: "50%+", color: "#ef4444" }, // red
];

/** The tier a quench-power fraction falls into (never null; clamps to the ends). */
export function quenchTier(fraction: number): QuenchTier {
    let tier = QUENCH_TIERS[0];
    for (const t of QUENCH_TIERS) {
        if (fraction >= t.min) tier = t;
        else break;
    }
    return tier;
}

/** Representative colour for a quench-power fraction (0.25 = +25%). */
export function quenchColor(fraction: number): string {
    return quenchTier(fraction).color;
}

/** Format a quench-power fraction as a signed percentage (0.254 → "+25%"). */
export function formatQuenchPercent(fraction: number): string {
    return `+${Math.round(fraction * 100)}%`;
}
