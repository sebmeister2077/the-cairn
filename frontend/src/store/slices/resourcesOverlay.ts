// Resources overlay UI prefs. Manifest fetching + viewport-debounced
// deposit fetching stay in [hooks/useResourcesOverlay.ts] because they're
// side-effects keyed on `enabled`; only the persisted user preferences
// move into the store.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsReadJson, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";

const ACTIVE_LAYERS_LS = "tops-map-resources-active-layers";
const DEPOSIT_FILTERS_LS = "tops-map-resources-deposit-filters";
const OPACITY_LS = "tops-map-resources-opacity";
const SHOW_DEPOSITS_LS = "tops-map-resources-show-deposits";

export interface ResourcesOverlayState {
    activeLayers: Record<string, boolean>;
    opacity: number;
    depositsVisible: boolean;
    depositTypeVisibility: Record<string, boolean>;
}

function clamp01(v: number) {
    return Math.min(1, Math.max(0, v));
}

export function loadInitialResourcesOverlayState(): ResourcesOverlayState {
    return {
        activeLayers: lsReadJson<Record<string, boolean>>(ACTIVE_LAYERS_LS, {}),
        opacity: clamp01(lsReadJson<number>(OPACITY_LS, 0.55)),
        depositsVisible: lsReadJson<boolean>(SHOW_DEPOSITS_LS, true),
        depositTypeVisibility: lsReadJson<Record<string, boolean>>(
            DEPOSIT_FILTERS_LS,
            {},
        ),
    };
}

export const resourcesOverlaySlice = createSlice({
    name: "resourcesOverlay",
    initialState: loadInitialResourcesOverlayState(),
    reducers: {
        setActiveLayers(state, action: PayloadAction<Record<string, boolean>>) {
            state.activeLayers = action.payload;
        },
        toggleLayer(state, action: PayloadAction<string>) {
            const id = action.payload;
            state.activeLayers[id] = !state.activeLayers[id];
        },
        setOpacity(state, action: PayloadAction<number>) {
            state.opacity = clamp01(action.payload);
        },
        setDepositsVisible(state, action: PayloadAction<boolean>) {
            state.depositsVisible = action.payload;
        },
        setDepositTypeVisibility(
            state,
            action: PayloadAction<Record<string, boolean>>,
        ) {
            state.depositTypeVisibility = action.payload;
        },
        toggleDepositType(state, action: PayloadAction<string>) {
            const id = action.payload;
            state.depositTypeVisibility[id] = !state.depositTypeVisibility[id];
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.resourcesOverlay as
                | ResourcesOverlayState
                | undefined;
            return next ?? state;
        });
    },
});

export const {
    setActiveLayers,
    toggleLayer,
    setOpacity,
    setDepositsVisible,
    setDepositTypeVisibility,
    toggleDepositType,
} = resourcesOverlaySlice.actions;

export function persistResourcesOverlay(
    getSlice: () => ResourcesOverlayState,
    prev: ResourcesOverlayState,
) {
    const s = getSlice();
    if (s.activeLayers !== prev.activeLayers)
        lsWriteJson(ACTIVE_LAYERS_LS, s.activeLayers);
    if (s.opacity !== prev.opacity) lsWriteJson(OPACITY_LS, s.opacity);
    if (s.depositsVisible !== prev.depositsVisible)
        lsWriteJson(SHOW_DEPOSITS_LS, s.depositsVisible);
    if (s.depositTypeVisibility !== prev.depositTypeVisibility)
        lsWriteJson(DEPOSIT_FILTERS_LS, s.depositTypeVisibility);
}
