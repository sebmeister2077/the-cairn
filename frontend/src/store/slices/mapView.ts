// TOPS map view UI state shared between TOPSMapViewPage and the drawers.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsReadJson, lsWrite, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";
import {
    DEFAULT_TERMINUS_STYLE,
    DEFAULT_TL_STYLE,
    DEFAULT_TRADER_STYLE,
    type TerminusStyle,
    type TLStyle,
    type TraderStyle,
} from "@/lib/markerStyles";

const SELECTED_LEVEL_LS = "tops-map-selected-level";
const VIEW_MODE_LS = "tops-map-tl-groupings-view-mode";
const ACTIVE_LS = "tops-map-tl-groupings-active";
const SHOW_LANDMARKS_LS = "tops-map-show-landmarks";
const SHOW_TRANSLOCATORS_LS = "tops-map-show-translocators";
const STARFIELD_ENABLED_LS = "tops-map-starfield-enabled";
const MAP_SOURCE_LS = "tops-map-source";
const WC_URL_LS = "tops-map-webcartographer-url";

export type TLGroupingsViewMode = "all" | "highlight" | "filter";

/**
 * Which tile source backs the TOPS map viewer.
 *  - "cairn":            our own pre-rendered TOPS chunks (default).
 *  - "webcartographer":  an external WebCartographer-style XYZ tile host
 *                        (e.g. https://tops-map.translocator.moe). Tile
 *                        imagery only; all overlays (TLs/landmarks/traders/
 *                        oceans) still come from our database.
 */
export type MapSource = "cairn" | "webcartographer";

/** Default WebCartographer host used when the user has not entered a URL. */
export const DEFAULT_WEBCARTOGRAPHER_URL = "https://tops-map.translocator.moe";

/** Built-in preset hosts shown in the source selector dropdown. */
export const WEBCARTOGRAPHER_PRESETS: Array<{ label: string; url: string }> = [
    { label: "Translocator.moe (Th3Dilli)", url: "https://tops-map.translocator.moe" },
    { label: "Old TOPS (vintagestory.at)", url: "https://map.oldtops.vintagestory.at" },
];

export interface MapViewState {
    selectedLevel: number | null;
    groupingsViewMode: TLGroupingsViewMode;
    activeGroupingIds: string[];
    showLandmarks: boolean;
    /**
     * Independent toggle for Terminus (one-way death-return teleporter)
     * markers. Decoupled from `showLandmarks` so users can surface
     * Terminus points without the rest of the landmark overlay (and vice
     * versa). Persisted via the root envelope.
     */
    showTerminus: boolean;
    showTranslocators: boolean;
    showTraders: boolean;
    /** When non-empty, restrict trader markers to these trader_type values. */
    traderTypeFilter: string[];
    showRecentlyAdded: boolean;
    /**
     * When true, render a translucent "oceans" raster background behind
     * the Tops map tiles so users can see roughly where oceans exist in
     * still-unexplored regions. Asset is shipped from the frontend bundle
     * (see `frontend/src/assets/Oceans/`). Default OFF — opt-in.
     */
    showOceans: boolean;
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
    /**
     * User-picked icon styles for the three special marker kinds on the
     * map. Picked from the Account → Appearance panel. Persisted via the
     * root envelope so they survive reloads + cross-tab sync.
     */
    traderStyle: TraderStyle;
    tlStyle: TLStyle;
    terminusStyle: TerminusStyle;
    /** Active map tile source. See {@link MapSource}. */
    mapSource: MapSource;
    /** Configured WebCartographer host URL (used when mapSource === "webcartographer"). */
    webCartographerUrl: string;
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

function readMapSource(): MapSource {
    const raw = lsRead(MAP_SOURCE_LS);
    return raw === "webcartographer" ? "webcartographer" : "cairn";
}

function readWebCartographerUrl(): string {
    const raw = lsRead(WC_URL_LS);
    return raw && raw.trim().length > 0 ? raw : DEFAULT_WEBCARTOGRAPHER_URL;
}


export function loadInitialMapViewState(): MapViewState {
    return {
        selectedLevel: readSelectedLevel(),
        groupingsViewMode: readViewMode(),
        activeGroupingIds: readActive(),
        showLandmarks: true,
        showTerminus: false,
        showTranslocators: false,
        showTraders: false,
        traderTypeFilter: [],
        showRecentlyAdded: false,
        showOceans: false,
        isFullscreen: false,
        starfieldEnabled: true,
        favoriteStartingPosition: null,
        traderStyle: DEFAULT_TRADER_STYLE,
        tlStyle: DEFAULT_TL_STYLE,
        terminusStyle: DEFAULT_TERMINUS_STYLE,
        mapSource: readMapSource(),
        webCartographerUrl: readWebCartographerUrl(),
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
        setShowTerminus(state, action: PayloadAction<boolean>) {
            state.showTerminus = action.payload;
        },
        setShowTranslocators(state, action: PayloadAction<boolean>) {
            state.showTranslocators = action.payload;
            if (!state.showTranslocators) {
                state.showRecentlyAdded = false;
            }
        },
        setShowTraders(state, action: PayloadAction<boolean>) {
            state.showTraders = action.payload;
        },
        setTraderTypeFilter(state, action: PayloadAction<string[]>) {
            state.traderTypeFilter = Array.from(new Set(action.payload));
        },
        toggleTraderTypeFilter(state, action: PayloadAction<string>) {
            const t = action.payload;
            const i = state.traderTypeFilter.indexOf(t);
            if (i >= 0) state.traderTypeFilter.splice(i, 1);
            else state.traderTypeFilter.push(t);
        },
        toggleShowRecentlyAdded(state, action: PayloadAction<boolean | undefined>) {
            if (action.payload !== undefined) {
                state.showRecentlyAdded = action.payload;
            } else {
                state.showRecentlyAdded = !state.showRecentlyAdded;
            }
        },
        setShowOceans(state, action: PayloadAction<boolean>) {
            state.showOceans = action.payload;
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
        setTraderStyle(state, action: PayloadAction<TraderStyle>) {
            state.traderStyle = action.payload;
        },
        setTLStyle(state, action: PayloadAction<TLStyle>) {
            state.tlStyle = action.payload;
        },
        setTerminusStyle(state, action: PayloadAction<TerminusStyle>) {
            state.terminusStyle = action.payload;
        },
        setMapSource(state, action: PayloadAction<MapSource>) {
            state.mapSource = action.payload;
        },
        setWebCartographerUrl(state, action: PayloadAction<string>) {
            const trimmed = action.payload.trim();
            state.webCartographerUrl = trimmed.length > 0 ? trimmed : DEFAULT_WEBCARTOGRAPHER_URL;
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
    setShowTerminus,
    setShowTranslocators,
    setShowTraders,
    setTraderTypeFilter,
    toggleTraderTypeFilter,
    toggleShowRecentlyAdded,
    setShowOceans,
    setShowFullscreen,
    setStarfieldEnabled,
    setFavoriteStartingPosition,
    clearFavoriteStartingPosition,
    setTraderStyle,
    setTLStyle,
    setTerminusStyle,
    setMapSource,
    setWebCartographerUrl,
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
    if (s.mapSource !== prev.mapSource) {
        lsWrite(MAP_SOURCE_LS, s.mapSource);
    }
    if (s.webCartographerUrl !== prev.webCartographerUrl) {
        lsWrite(WC_URL_LS, s.webCartographerUrl);
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
        case MAP_SOURCE_LS:
            return setMapSource(readMapSource());
        case WC_URL_LS:
            return setWebCartographerUrl(readWebCartographerUrl());
        default:
            return null;
    }
}
