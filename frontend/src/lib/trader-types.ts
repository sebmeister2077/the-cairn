/**
 * Trader-related shared types, type-enum, color palette, display labels and
 * a simple keyword-based heuristic for inferring trader type from a
 * waypoint label (the Vintage Story ``/waypoint export`` command emits one
 * line per waypoint with the user-chosen title).
 *
 * Keep this file pure (no React, no I/O) so it can be imported by both
 * the page-level flows and the map overlay layer.
 */

export const TRADER_TYPES = [
    "agriculture",
    "artisan",
    "building_materials",
    "clothing",
    "commodities",
    "furniture",
    "luxuries",
    "survival_goods",
    "treasure_hunter",
] as const;

export type TraderType = (typeof TRADER_TYPES)[number];

export const TRADER_TYPE_LABELS: Record<TraderType, string> = {
    agriculture: "Agriculture",
    artisan: "Artisan",
    building_materials: "Building Materials",
    clothing: "Clothing",
    commodities: "Commodities",
    furniture: "Furniture",
    luxuries: "Luxuries",
    survival_goods: "Survival Goods",
    treasure_hunter: "Treasure Hunter",
};

/**
 * Per-type marker color, chosen to be distinguishable on the brown / green
 * TOPS rock tiles. Loosely keyed to the trader's wares.
 */
export const TRADER_TYPE_COLORS: Record<TraderType, string> = {
    agriculture: "#65a30d", // lime-600
    artisan: "#c2410c", // orange-700
    building_materials: "#78716c", // stone-500
    clothing: "#db2777", // pink-600
    commodities: "#0891b2", // cyan-600
    furniture: "#a16207", // yellow-700
    luxuries: "#7c3aed", // violet-600
    survival_goods: "#16a34a", // green-600
    treasure_hunter: "#eab308", // yellow-500
};

export function isTraderType(s: unknown): s is TraderType {
    return typeof s === "string" && (TRADER_TYPES as readonly string[]).includes(s);
}

/**
 * Keyword bank for ``inferTraderType``. Lower-case substring match against
 * the waypoint label. Ordered most-specific → least-specific within each
 * type; the first type with any keyword hit wins.
 *
 * The Vintage Story vanilla trader names follow the pattern
 * ``Trader <Type>`` (e.g. ``Trader Survival Goods``), so the simple
 * substring matcher catches almost every chat-log import without a real
 * NLP pass. Manual entry users pick the type from a dropdown so this
 * heuristic only matters for the chat-log path.
 */
const TYPE_KEYWORDS: Record<TraderType, string[]> = {
    agriculture: ["agriculture", "farmer"],// "farm", "crops", "crop", "seeds", "seed"],
    artisan: ["artisan"],// "tools", "tool", "smith", "blacksmith"],
    building_materials: [
        "building materials",
        "building material",
        "building"],
    //     "stones",
    //     "stone",
    //     "masonry",
    //     "construction",
    // ],
    clothing: ["clothing", "tailor", "clothes"],// "garments", "garment"],
    commodities: ["commodities", "commodity"], // "general goods", "general"],
    furniture: ["furniture"],// "carpenter"],
    luxuries: ["luxuries", "luxury"], // "fine"],
    survival_goods: ["survival goods", "survival good", "survival"],
    treasure_hunter: ["treasure hunter", "treasure", "hunter"],
};

export interface TraderInference {
    type: TraderType | null;
    confidence: number; // 0..1
}

/**
 * Heuristically guess a trader's type from a waypoint label. Returns
 * ``{type: null, confidence: 0}`` when nothing matches.
 *
 * Confidence is currently 1.0 for keyword hits and 0 otherwise — the
 * scoring slot is reserved for a later upgrade (token-frequency, etc.)
 * without touching the type signature of callers.
 */
export function inferTraderType(label: string): TraderInference {
    const hay = label.toLowerCase();
    for (const type of TRADER_TYPES) {
        const keywords = TYPE_KEYWORDS[type];
        for (const kw of keywords) {
            if (hay.includes(kw)) {
                return { type, confidence: 1 };
            }
        }
    }
    return { type: null, confidence: 0 };
}

/** A trader candidate parsed from a chat log or entered manually. */
export interface TraderCandidate {
    /** Stable local id (uuid) for React keys and dedupe within a batch. */
    localId: string;
    x: number;
    y?: number;
    z: number;
    label: string;
    /** Type chosen by the user, or null if not yet decided / unknown. */
    trader_type: TraderType | null;
    /** Optional inferred-type hint from the parser. */
    inferred?: TraderInference;
}
