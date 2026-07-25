// User-editable inputs for the Rock rarity & pricing page
// (see [pages/rarity/RockRarityPage.tsx]). Held in the store so the choices
// persist across reloads via the root envelope — same pattern as the market
// preference slices. The pure pricing math lives in
// [lib/rockstrata/pricing.ts]; this slice only owns the four config knobs
// plus the selected rarity curve.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";
import {
    DEFAULT_ROCK_PRICING,
    type RarityCurve,
    type RockPricingConfig,
} from "@/lib/rockstrata/pricing";

export type RockPricingState = RockPricingConfig;

export const DEFAULT_ROCK_PRICING_STATE: RockPricingState = DEFAULT_ROCK_PRICING;

/** Clamp a multiplier/price input to a sane positive range. */
const clampAmount = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100000, Math.max(0, n));
};

const isCurve = (v: unknown): v is RarityCurve =>
    v === "linear" || v === "sqrt" || v === "log";

/** Coerce stored/partial data into the current shape with sane bounds. */
export function normalizeRockPricing(
    raw: Partial<RockPricingState> | undefined,
): RockPricingState {
    const merged = { ...DEFAULT_ROCK_PRICING_STATE, ...(raw ?? {}) };
    return {
        base: clampAmount(merged.base, DEFAULT_ROCK_PRICING_STATE.base),
        boost: clampAmount(merged.boost, DEFAULT_ROCK_PRICING_STATE.boost),
        polished: clampAmount(merged.polished, DEFAULT_ROCK_PRICING_STATE.polished),
        cracked: clampAmount(merged.cracked, DEFAULT_ROCK_PRICING_STATE.cracked),
        curve: isCurve(merged.curve) ? merged.curve : DEFAULT_ROCK_PRICING_STATE.curve,
    };
}

export const rockPricingSlice = createSlice({
    name: "rockPricing",
    initialState: DEFAULT_ROCK_PRICING_STATE,
    reducers: {
        setRockBase(state, action: PayloadAction<number>) {
            state.base = clampAmount(action.payload, DEFAULT_ROCK_PRICING_STATE.base);
        },
        setRockBoost(state, action: PayloadAction<number>) {
            state.boost = clampAmount(action.payload, DEFAULT_ROCK_PRICING_STATE.boost);
        },
        setRockPolished(state, action: PayloadAction<number>) {
            state.polished = clampAmount(action.payload, DEFAULT_ROCK_PRICING_STATE.polished);
        },
        setRockCracked(state, action: PayloadAction<number>) {
            state.cracked = clampAmount(action.payload, DEFAULT_ROCK_PRICING_STATE.cracked);
        },
        setRockCurve(state, action: PayloadAction<RarityCurve>) {
            state.curve = isCurve(action.payload)
                ? action.payload
                : DEFAULT_ROCK_PRICING_STATE.curve;
        },
        resetRockPricing() {
            return { ...DEFAULT_ROCK_PRICING_STATE };
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.rockPricing as Partial<RockPricingState> | undefined;
            return next ? normalizeRockPricing(next) : state;
        });
    },
});

export const {
    setRockBase,
    setRockBoost,
    setRockPolished,
    setRockCracked,
    setRockCurve,
    resetRockPricing,
} = rockPricingSlice.actions;
