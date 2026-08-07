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
 * Per-type *default* marker color, chosen to be distinguishable on the brown /
 * green TOPS rock tiles. Loosely keyed to the trader's wares. Users can
 * override any of these from Preferences → Appearance (see
 * {@link resolveTraderColors}); this record is the fallback palette.
 *
 * `survival_goods` used to be green-600 (`#16a34a`) which sat too close to
 * `agriculture` (lime-600) on the map — it's now blue-600 for a clear hue gap.
 */
export const TRADER_TYPE_COLORS: Record<TraderType, string> = {
    agriculture: "#65a30d", // lime-600
    artisan: "#c2410c", // orange-700
    building_materials: "#78716c", // stone-500
    clothing: "#db2777", // pink-600
    commodities: "#0891b2", // cyan-600
    furniture: "#a16207", // yellow-700
    luxuries: "#7c3aed", // violet-600
    survival_goods: "#2563eb", // blue-600
    treasure_hunter: "#eab308", // yellow-500
};

export function isTraderType(s: unknown): s is TraderType {
    return typeof s === "string" && (TRADER_TYPES as readonly string[]).includes(s);
}

/** User overrides for {@link TRADER_TYPE_COLORS}. Partial — any missing type
 *  falls back to its default. Persisted in the `mapView` Redux slice. */
export type TraderColorOverrides = Partial<Record<TraderType, string>>;

/** Matches a 3- or 6-digit CSS hex color (`#rgb` / `#rrggbb`). */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(s: unknown): s is string {
    return typeof s === "string" && HEX_COLOR_RE.test(s);
}

/**
 * Keep only well-formed `{ traderType: hexColor }` pairs from an untrusted
 * source (e.g. a persisted envelope written by an older/newer build). Unknown
 * keys and non-hex values are dropped so downstream code always deals with a
 * clean override map.
 */
export function sanitizeTraderColors(raw: unknown): TraderColorOverrides {
    if (typeof raw !== "object" || raw === null) return {};
    const out: TraderColorOverrides = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (isTraderType(key) && isHexColor(value)) out[key] = value;
    }
    return out;
}

/**
 * Merge the user's overrides over the default palette, returning a full
 * color for every trader type. Pass the (sanitized) overrides from the
 * `mapView.traderColors` slice; omit them to get the defaults.
 */
export function resolveTraderColors(
    overrides?: TraderColorOverrides | null,
): Record<TraderType, string> {
    if (!overrides) return { ...TRADER_TYPE_COLORS };
    return { ...TRADER_TYPE_COLORS, ...sanitizeTraderColors(overrides) };
}

/**
 * Fill colour for a trader *claim* box that has no type assigned yet. Neutral
 * off-white so classified claims (which use {@link TRADER_TYPE_COLORS}) stand
 * out against it.
 */
export const CLAIM_UNCLASSIFIED_COLOR = "#e5e7eb"; // gray-200

/**
 * Canonical id for a trader claim: its quantised absolute centre ``"x:y:z"``.
 * Both the static claim asset and the proxy compute this from the same
 * absolute centre, so overlay type assignments merge by lookup. Rounds to the
 * nearest integer to absorb the ``.5`` centres in the export.
 */
export function claimIdFromCenter(center: { x: number; y: number; z: number }): string {
    return `${Math.round(center.x)}:${Math.round(center.y)}:${Math.round(center.z)}`;
}

/**
 * Map the compact trader `type` codes emitted by the in-game session
 * exporter (e.g. ``"treasurehunter"``, ``"survivalgoods"``,
 * ``"buildmaterials"``) to the app's canonical {@link TraderType} union.
 * Returns ``null`` for unrecognised codes so callers can skip / fall back.
 */
const EXPORT_TRADER_TYPE_MAP: Record<string, TraderType> = {
    agriculture: "agriculture",
    artisan: "artisan",
    buildmaterials: "building_materials",
    clothing: "clothing",
    commodities: "commodities",
    furniture: "furniture",
    luxuries: "luxuries",
    survivalgoods: "survival_goods",
    treasurehunter: "treasure_hunter",
};

export function mapExportTraderType(code: unknown): TraderType | null {
    if (typeof code !== "string") return null;
    return EXPORT_TRADER_TYPE_MAP[code.toLowerCase()] ?? null;
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
    agriculture: ["agriculture", "farmer", "agricultural"],// "farm", "crops", "crop", "seeds", "seed"],
    artisan: ["artisan"],// "tools", "tool", "smith", "blacksmith"],
    building_materials: [
        "building materials",
        "building material",
        "building", "build", 'builder'],
    //     "stones",
    //     "stone",
    //     "masonry",
    //     "construction",
    // ],
    clothing: ["clothing", "tailor", "clothes", "cloth"],// "garments", "garment"],
    commodities: ["commodities", "commodity", "comodity", "general goods", "general", "common"],
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
