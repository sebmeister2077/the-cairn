// Route planner UI state for the TOPS map viewer.
//
// Holds the From/To endpoints, computed routes, selected alternative, and
// configurable cost-model knobs (walk speed, TL penalty). Intentionally NOT
// persisted (added to `PERSIST_BLACKLIST`) — the planner is an ephemeral
// "what-if" surface; on reload we re-hydrate ONLY from URL params.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { RouteResult, WorldPoint } from "@/lib/tl-routing";
import {
    DEFAULT_K_NEIGHBORS,
    DEFAULT_TL_PENALTY_S,
    DEFAULT_WALK_SPEED,
} from "@/lib/tl-routing";

/** A picked endpoint, plus a human-readable label (e.g. landmark name). */
export interface EndpointPick {
    point: WorldPoint;
    /** Optional source label, shown in the panel. */
    label?: string;
    /** Where the user picked from (for UX hinting / analytics). */
    source: "map-click" | "landmark" | "paste" | "favorite" | "url";
}

export interface RoutePlannerState {
    isOpen: boolean;
    from: EndpointPick | null;
    to: EndpointPick | null;
    routes: RouteResult[];
    selectedIndex: number;
    isComputing: boolean;
    error: string | null;
    /** Map pointer mode: "from"/"to" means the next map click sets that endpoint. */
    pickMode: null | "from" | "to";
    /** User-configurable cost model. */
    walkSpeed: number;
    tlPenaltySeconds: number;
    kNeighbors: number;
    /**
     * One-shot "fly the map here" request. The map subscribes and pans/zooms
     * whenever this object reference changes (each dispatch creates a fresh
     * object even for the same coordinates, so clicking the same leg twice
     * re-triggers the navigation).
     *
     * `spanBlocks` is the world-space diameter the viewport should fit around
     * the focus point — used by the route planner so long TL pairs zoom out
     * enough that both endpoints stay in frame, rather than fully zooming in
     * on the midpoint. Omitted = use the viewer's default focus zoom.
     */
    focusRequest: (WorldPoint & { spanBlocks?: number }) | null;
}

export const initialRoutePlannerState: RoutePlannerState = {
    isOpen: false,
    from: null,
    to: null,
    routes: [],
    selectedIndex: 0,
    isComputing: false,
    error: null,
    pickMode: null,
    walkSpeed: DEFAULT_WALK_SPEED,
    tlPenaltySeconds: DEFAULT_TL_PENALTY_S,
    kNeighbors: DEFAULT_K_NEIGHBORS,
    focusRequest: null,
};

export const routePlannerSlice = createSlice({
    name: "routePlanner",
    initialState: initialRoutePlannerState,
    reducers: {
        setOpen(state, action: PayloadAction<boolean>) {
            state.isOpen = action.payload;
            if (!state.isOpen) state.pickMode = null;
        },
        setFrom(state, action: PayloadAction<EndpointPick | null>) {
            state.from = action.payload;
            // A new endpoint invalidates the existing results until recompute fires.
            state.routes = [];
            state.selectedIndex = 0;
            state.error = null;
            if (state.pickMode === "from") state.pickMode = null;
        },
        setTo(state, action: PayloadAction<EndpointPick | null>) {
            state.to = action.payload;
            state.routes = [];
            state.selectedIndex = 0;
            state.error = null;
            if (state.pickMode === "to") state.pickMode = null;
        },
        swap(state) {
            const tmp = state.from;
            state.from = state.to;
            state.to = tmp;
            state.routes = [];
            state.selectedIndex = 0;
            state.error = null;
        },
        clear(state) {
            state.from = null;
            state.to = null;
            state.routes = [];
            state.selectedIndex = 0;
            state.error = null;
            state.pickMode = null;
        },
        setPickMode(state, action: PayloadAction<RoutePlannerState["pickMode"]>) {
            state.pickMode = action.payload;
        },
        setSelectedIndex(state, action: PayloadAction<number>) {
            const max = Math.max(0, state.routes.length - 1);
            state.selectedIndex = Math.min(Math.max(0, action.payload), max);
        },
        setComputing(state, action: PayloadAction<boolean>) {
            state.isComputing = action.payload;
            if (action.payload) state.error = null;
        },
        setRoutes(state, action: PayloadAction<RouteResult[]>) {
            state.routes = action.payload;
            state.selectedIndex = 0;
            state.isComputing = false;
            state.error = null;
        },
        setError(state, action: PayloadAction<string | null>) {
            state.error = action.payload;
            state.isComputing = false;
        },
        setWalkSpeed(state, action: PayloadAction<number>) {
            // Clamp to sane sprint/walk range so a fat-fingered slider can't blow up cost math.
            state.walkSpeed = Math.max(0.5, Math.min(20, action.payload));
            state.routes = [];
        },
        setTLPenalty(state, action: PayloadAction<number>) {
            state.tlPenaltySeconds = Math.max(0, Math.min(600, action.payload));
            state.routes = [];
        },
        setFocusRequest(
            state,
            action: PayloadAction<(WorldPoint & { spanBlocks?: number }) | null>,
        ) {
            // Always re-wrap so consecutive dispatches with the same
            // coordinates still produce a fresh object identity.
            state.focusRequest = action.payload
                ? {
                    x: action.payload.x,
                    z: action.payload.z,
                    spanBlocks: action.payload.spanBlocks,
                }
                : null;
        },
    },
});

export const {
    setOpen: setRoutePlannerOpen,
    setFrom: setRouteFrom,
    setTo: setRouteTo,
    swap: swapRouteEndpoints,
    clear: clearRoutePlanner,
    setPickMode: setRoutePickMode,
    setSelectedIndex: setRouteSelectedIndex,
    setComputing: setRouteComputing,
    setRoutes: setRoutePlannerRoutes,
    setError: setRoutePlannerError,
    setWalkSpeed: setRouteWalkSpeed,
    setTLPenalty: setRouteTLPenalty,
    setFocusRequest: setRouteFocusRequest,
} = routePlannerSlice.actions;
