// Sailboat route planner UI state for the TOPS map viewer.
//
// Holds the From/To endpoints, the computed water route, compute status, and
// the admin "mark boat-friendly TLs" edit toggle. Nothing here is persisted —
// endpoints and routes are ephemeral, and the boat-friendly TL list itself
// lives on the server (fetched via `useBoatFriendlyTLs`).

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { EndpointPick } from "./routePlanner";
import {
    DEFAULT_SAILBOAT_OPTIONS,
    type SailboatRouteResult,
} from "@/lib/sailboat/sailboat-routing";

/** Which slot a map-click writes into while the sailboat planner is open. */
export type SailboatPickMode = null | "from" | "to";

/** Search resolution preference. `auto` picks a coarser pyramid level for long
 *  open-water crossings (far fewer tiles/nodes) and the finest for short
 *  routes; the explicit levels force a fixed detail. */
export type SailboatSearchDetail = "auto" | "high" | "medium" | "low";

export interface SailboatRouteState {
    isOpen: boolean;
    from: EndpointPick | null;
    to: EndpointPick | null;
    route: SailboatRouteResult | null;
    isComputing: boolean;
    /** Settled pixel count streamed from the worker while computing. */
    progressVisited: number;
    /** Estimated completion in [0, 1] streamed while computing — drives the
     *  progress bar. 1 once the result lands. */
    progressFraction: number;
    error: string | null;
    pickMode: SailboatPickMode;
    /** Admin-only: when true, clicking a TL on the map toggles its
     *  boat-friendly state (instead of normal TL selection). */
    boatTLEditMode: boolean;
    /** Outline WebCartographer tiles in the viewer so you can see the tile
     *  grid the water detection samples (available to everyone). */
    debugTiles: boolean;
    /** Finest-level tile keys (`"cx_cy"`) the search has loaded so far.
     *  Streamed from the worker; highlighted by the debug overlay so you can
     *  watch which chunks are being scanned. */
    scannedTiles: string[];
    /** Pyramid level the scanned tiles were loaded at — lets the debug overlay
     *  size each tile rect correctly (a coarser tile covers more blocks). */
    scannedTilesZoom: number;
    /** User-configurable cost model. Cost multiplier for crossing a non-water
     *  (terrain) block relative to water (×1). Higher = avoid land harder. */
    landPenalty: number;
    /** User-configurable cost model. Extra cost (in block-equivalents) added
     *  for taking a boat-friendly translocator hop. */
    tlHopCost: number;
    /** User-configurable search budget. Max distinct map tiles the search may
     *  load before giving up — bounds how far the planner reaches. */
    maxTiles: number;
    /** User-configurable search budget. Max settled blocks the search may
     *  expand before giving up — bounds runtime/memory. */
    maxVisited: number;
    /** Search resolution preference (see {@link SailboatSearchDetail}). */
    searchDetail: SailboatSearchDetail;
}

export const initialSailboatRouteState: SailboatRouteState = {
    isOpen: false,
    from: null,
    to: null,
    route: null,
    isComputing: false,
    progressVisited: 0,
    progressFraction: 0,
    error: null,
    pickMode: null,
    boatTLEditMode: false,
    debugTiles: false,
    scannedTiles: [],
    scannedTilesZoom: DEFAULT_SAILBOAT_OPTIONS.zoom,
    landPenalty: DEFAULT_SAILBOAT_OPTIONS.landPenalty,
    tlHopCost: DEFAULT_SAILBOAT_OPTIONS.tlHopCost,
    maxTiles: DEFAULT_SAILBOAT_OPTIONS.maxTiles,
    maxVisited: DEFAULT_SAILBOAT_OPTIONS.maxVisited,
    searchDetail: "auto",
};

export const sailboatRouteSlice = createSlice({
    name: "sailboatRoute",
    initialState: initialSailboatRouteState,
    reducers: {
        setOpen(state, action: PayloadAction<boolean>) {
            state.isOpen = action.payload;
            if (!state.isOpen) state.pickMode = null;
        },
        setFrom(state, action: PayloadAction<EndpointPick | null>) {
            state.from = action.payload;
            state.route = null;
            state.error = null;
            if (state.pickMode === "from") state.pickMode = null;
        },
        setTo(state, action: PayloadAction<EndpointPick | null>) {
            state.to = action.payload;
            state.route = null;
            state.error = null;
            if (state.pickMode === "to") state.pickMode = null;
        },
        swapEndpoints(state) {
            const tmp = state.from;
            state.from = state.to;
            state.to = tmp;
            state.route = null;
        },
        setPickMode(state, action: PayloadAction<SailboatPickMode>) {
            state.pickMode = action.payload;
        },
        setComputing(state, action: PayloadAction<boolean>) {
            state.isComputing = action.payload;
            if (action.payload) {
                state.error = null;
                state.progressVisited = 0;
                state.progressFraction = 0;
                state.scannedTiles = [];
            }
        },
        setProgress(state, action: PayloadAction<{ visited: number; fraction: number; zoom: number }>) {
            state.progressVisited = action.payload.visited;
            state.progressFraction = action.payload.fraction;
            state.scannedTilesZoom = action.payload.zoom;
        },
        setScannedTiles(state, action: PayloadAction<string[]>) {
            state.scannedTiles = action.payload;
        },
        setRoute(state, action: PayloadAction<SailboatRouteResult | null>) {
            state.route = action.payload;
            state.isComputing = false;
            state.progressFraction = 1;
        },
        setError(state, action: PayloadAction<string | null>) {
            state.error = action.payload;
            state.isComputing = false;
        },
        setBoatTLEditMode(state, action: PayloadAction<boolean>) {
            state.boatTLEditMode = action.payload;
        },
        setDebugTiles(state, action: PayloadAction<boolean>) {
            state.debugTiles = action.payload;
        },
        setLandPenalty(state, action: PayloadAction<number>) {
            // Clamp so a fat-fingered slider can't break the cost model; land
            // must always cost at least as much as water (×1). Changing the
            // cost model invalidates the cached route.
            state.landPenalty = Math.max(1, Math.min(50, action.payload));
            state.route = null;
            state.error = null;
        },
        setTlHopCost(state, action: PayloadAction<number>) {
            state.tlHopCost = Math.max(0, Math.min(500, action.payload));
            state.route = null;
            state.error = null;
        },
        setMaxTiles(state, action: PayloadAction<number>) {
            // One tile = 256×256 blocks; bound the budget to a sane range.
            state.maxTiles = Math.max(50, Math.min(2000, Math.round(action.payload)));
            state.route = null;
            state.error = null;
        },
        setMaxVisited(state, action: PayloadAction<number>) {
            state.maxVisited = Math.max(
                250_000,
                Math.min(20_000_000, Math.round(action.payload)),
            );
            state.route = null;
            state.error = null;
        },
        setSearchDetail(state, action: PayloadAction<SailboatSearchDetail>) {
            state.searchDetail = action.payload;
            state.route = null;
            state.error = null;
        },
        clearSailboatRoute(state) {
            state.from = null;
            state.to = null;
            state.route = null;
            state.error = null;
            state.pickMode = null;
            state.isComputing = false;
            state.progressVisited = 0;
            state.progressFraction = 0;
            state.scannedTiles = [];
        },
    },
});

export const {
    setOpen: setSailboatOpen,
    setFrom: setSailboatFrom,
    setTo: setSailboatTo,
    swapEndpoints: swapSailboatEndpoints,
    setPickMode: setSailboatPickMode,
    setComputing: setSailboatComputing,
    setProgress: setSailboatProgress,
    setScannedTiles: setSailboatScannedTiles,
    setRoute: setSailboatRoute,
    setError: setSailboatError,
    setBoatTLEditMode: setSailboatBoatTLEditMode,
    setDebugTiles: setSailboatDebugTiles,
    setLandPenalty: setSailboatLandPenalty,
    setTlHopCost: setSailboatTlHopCost,
    setMaxTiles: setSailboatMaxTiles,
    setMaxVisited: setSailboatMaxVisited,
    setSearchDetail: setSailboatSearchDetail,
    clearSailboatRoute,
} = sailboatRouteSlice.actions;
