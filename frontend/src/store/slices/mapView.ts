// TOPS map view UI state shared between TOPSMapViewPage and the drawers.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsReadJson, lsWrite, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";

const SELECTED_LEVEL_LS = "tops-map-selected-level";
const VIEW_MODE_LS = "tops-map-tl-groupings-view-mode";
const ACTIVE_LS = "tops-map-tl-groupings-active";
const SHOW_LANDMARKS_LS = "tops-map-show-landmarks";
const SHOW_TRANSLOCATORS_LS = "tops-map-show-translocators";
const STARFIELD_ENABLED_LS = "tops-map-starfield-enabled";

export type TLGroupingsViewMode = "all" | "highlight" | "filter";

export interface MapViewState {
    selectedLevel: number | null;
    groupingsViewMode: TLGroupingsViewMode;
    activeGroupingIds: string[];
    showLandmarks: boolean;
    showTranslocators: boolean;
    showRecentlyAdded: boolean;
    isFullscreen: boolean;
    /**
     * When true, the TOPS map viewer renders an animated starfield behind
     * the tiles instead of a flat dark background. Pure-CSS; persists
     * across reloads. Default ON.
     */
    starfieldEnabled: boolean;
    /**
     * User's preferred "home" location on the TOPS map. When set, the page
     * uses this as the initial viewport on first paint (instead of spawn
     * 0,0) and exposes a "Jump home" button. Persisted via the root
     * envelope so it survives reloads + cross-tab.
     */
    favoriteStartingPosition: { x: number; z: number; zoom?: number } | null;
}

function readSelectedLevel(): number | null {
    const raw = lsRead(SELECTED_LEVEL_LS);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function readViewMode(): TLGroupingsViewMode {
    const raw = lsRead(VIEW_MODE_LS);
    return raw === "filter" || raw === "highlight" || raw === "all" ? raw : "all";
}

function readActive(): string[] {
    const arr = lsReadJson<unknown>(ACTIVE_LS, []);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === "string");
}


export function loadInitialMapViewState(): MapViewState {
    return {
        selectedLevel: readSelectedLevel(),
        groupingsViewMode: readViewMode(),
        activeGroupingIds: readActive(),
        showLandmarks: true,
        showTranslocators: false,
        showRecentlyAdded: false,
        isFullscreen: false,
        starfieldEnabled: true,
        favoriteStartingPosition: null,
    };
}

export const mapViewSlice = createSlice({
    name: "mapView",
    initialState: loadInitialMapViewState(),
    reducers: {
        setSelectedLevel(state, action: PayloadAction<number | null>) {
            state.selectedLevel = action.payload;
        },
        setGroupingsViewMode(state, action: PayloadAction<TLGroupingsViewMode>) {
            state.groupingsViewMode = action.payload;
        },
        setActiveGroupingIds(state, action: PayloadAction<string[]>) {
            // Deduplicate defensively so callers can pass in the result of
            // toggling without first checking.
            state.activeGroupingIds = Array.from(new Set(action.payload));
        },
        toggleActiveGrouping(state, action: PayloadAction<string>) {
            const id = action.payload;
            const i = state.activeGroupingIds.indexOf(id);
            if (i >= 0) state.activeGroupingIds.splice(i, 1);
            else state.activeGroupingIds.push(id);
        },
        setShowLandmarks(state, action: PayloadAction<boolean>) {
            state.showLandmarks = action.payload;
        },
        setShowTranslocators(state, action: PayloadAction<boolean>) {
            state.showTranslocators = action.payload;
        },
        toggleShowRecentlyAdded(state, action: PayloadAction<boolean | undefined>) {
            if (action.payload !== undefined) {
                state.showRecentlyAdded = action.payload;
            } else {
                state.showRecentlyAdded = !state.showRecentlyAdded;
            }
        },
        setShowFullscreen(state, action: PayloadAction<boolean>) {
            state.isFullscreen = action.payload;
        },
        setStarfieldEnabled(state, action: PayloadAction<boolean>) {
            state.starfieldEnabled = action.payload;
        },
        setFavoriteStartingPosition(
            state,
            action: PayloadAction<{ x: number; z: number; zoom?: number } | null>,
        ) {
            state.favoriteStartingPosition = action.payload;
        },
        clearFavoriteStartingPosition(state) {
            state.favoriteStartingPosition = null;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            // Merge the persisted payload over the current (default-initialised)
            // state so newly-added fields fall back to their defaults for
            // users whose envelope was written before the field existed.
            // Without this, `return next` would leave `starfieldEnabled` (and
            // any future additions) as `undefined` on existing accounts.
            const next = action.payload.mapView as Partial<MapViewState> | undefined;
             if (!next) return state;
            return { ...state, ...next };
        });
    },
});

export const {
    setSelectedLevel,
    setGroupingsViewMode,
    setActiveGroupingIds,
    toggleActiveGrouping,
    setShowLandmarks,
    setShowTranslocators,
    toggleShowRecentlyAdded,
    setShowFullscreen,
    setStarfieldEnabled,
    setFavoriteStartingPosition,
    clearFavoriteStartingPosition,
} = mapViewSlice.actions;

export function persistMapView(getSlice: () => MapViewState, prev: MapViewState) {
    const s = getSlice();
    if (s.selectedLevel !== prev.selectedLevel && s.selectedLevel != null) {
        lsWrite(SELECTED_LEVEL_LS, String(s.selectedLevel));
    }
    if (s.groupingsViewMode !== prev.groupingsViewMode) {
        lsWrite(VIEW_MODE_LS, s.groupingsViewMode);
    }
    if (s.activeGroupingIds !== prev.activeGroupingIds) {
        lsWriteJson(ACTIVE_LS, s.activeGroupingIds);
    }
}

export function reconcileMapViewFromStorage(key: string) {
    switch (key) {
        case SELECTED_LEVEL_LS:
            return setSelectedLevel(readSelectedLevel());
        case VIEW_MODE_LS:
            return setGroupingsViewMode(readViewMode());
        case ACTIVE_LS:
            return setActiveGroupingIds(readActive());
        default:
            return null;
    }
}
