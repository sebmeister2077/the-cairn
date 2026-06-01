// Route planner UI state for the TOPS map viewer.
//
// Holds the From/To endpoints, computed routes, selected alternative, and
// configurable cost-model knobs (walk speed, TL penalty). Only the
// cost-model preferences (`walkSpeed`, `tlPenaltySeconds`, `kNeighbors`)
// are persisted across reloads — see `STRIP_BEFORE_WRITE.routePlanner`
// in `rootPersistence.ts`. Everything else (endpoints, computed routes,
// pickMode, focusRequest, isOpen) is ephemeral; on reload From/To are
// re-hydrated only from URL params.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { RendezvousObjective, RendezvousResult, RouteResult, WorldPoint } from "@/lib/tl-routing";
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

/** Top-level planner mode. */
export type RoutePlannerMode = "route" | "rendezvous";

/** Which slot a map-click will write into. `player:N` is rendezvous-mode
 *  only and targets `state.players[N]`. */
export type RoutePickMode = null | "from" | "to" | `player:${number}`;

export interface RoutePlannerState {
    isOpen: boolean;
    mode: RoutePlannerMode;
    from: EndpointPick | null;
    to: EndpointPick | null;
    routes: RouteResult[];
    selectedIndex: number;
    isComputing: boolean;
    error: string | null;
    /** Map pointer mode: "from"/"to"/"player:N" means the next map click
     *  sets that endpoint. */
    pickMode: RoutePickMode;
    /** User-configurable cost model. */
    walkSpeed: number;
    tlPenaltySeconds: number;
    kNeighbors: number;
    /** When true, the planner only routes through TL-to-TL walk
     *  segments the community has confirmed are safely traversable
     *  by an elk. Persisted so a logged-in player's preference
     *  survives reloads. */
    elkFriendlyOnly: boolean;
    /** Rendezvous-mode party. Sparse — `null` entries are empty slots
     *  the user has added but not yet populated. Always length ≥ 2 while
     *  in rendezvous mode (enforced by `setMode`). */
    players: Array<EndpointPick | null>;
    rendezvousObjective: RendezvousObjective;
    rendezvousResult: RendezvousResult | null;
    rendezvousIsComputing: boolean;
    rendezvousError: string | null;
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
    mode: "route",
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
    elkFriendlyOnly: false,
    players: [null, null],
    rendezvousObjective: "minimax",
    rendezvousResult: null,
    rendezvousIsComputing: false,
    rendezvousError: null,
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
            state.players = state.players.map(() => null);
            state.rendezvousResult = null;
            state.rendezvousError = null;
        },
        setPickMode(state, action: PayloadAction<RoutePlannerState["pickMode"]>) {
            state.pickMode = action.payload;
        },
        setMode(state, action: PayloadAction<RoutePlannerMode>) {
            state.mode = action.payload;
            state.pickMode = null;
            // Each mode owns its own result set — clear the other side's
            // stale data so the UI doesn't briefly render results that
            // were computed for a different question.
            if (action.payload === "rendezvous") {
                if (state.players.length < 2) {
                    state.players = [null, null];
                }
            } else {
                state.rendezvousResult = null;
                state.rendezvousError = null;
            }
        },
        setPlayer(
            state,
            action: PayloadAction<{ index: number; pick: EndpointPick | null }>,
        ) {
            const { index, pick } = action.payload;
            if (index < 0 || index >= state.players.length) return;
            state.players[index] = pick;
            state.rendezvousResult = null;
            state.rendezvousError = null;
            if (state.pickMode === `player:${index}`) state.pickMode = null;
        },
        addPlayer(state) {
            // Cap at 8 — beyond that the UX gets cramped AND the
            // per-player Dijkstras start adding up. Tune if needed.
            if (state.players.length >= 8) return;
            state.players.push(null);
            state.rendezvousResult = null;
            state.rendezvousError = null;
        },
        removePlayer(state, action: PayloadAction<number>) {
            const index = action.payload;
            if (index < 0 || index >= state.players.length) return;
            // Always keep at least two slots so the panel stays in a
            // valid rendezvous configuration.
            if (state.players.length <= 2) {
                state.players[index] = null;
            } else {
                state.players.splice(index, 1);
            }
            state.rendezvousResult = null;
            state.rendezvousError = null;
            if (state.pickMode === `player:${index}`) state.pickMode = null;
        },
        setRendezvousObjective(state, action: PayloadAction<RendezvousObjective>) {
            state.rendezvousObjective = action.payload;
            state.rendezvousResult = null;
            state.rendezvousError = null;
        },
        setRendezvousComputing(state, action: PayloadAction<boolean>) {
            state.rendezvousIsComputing = action.payload;
            if (action.payload) state.rendezvousError = null;
        },
        setRendezvousResult(state, action: PayloadAction<RendezvousResult | null>) {
            state.rendezvousResult = action.payload;
            state.rendezvousIsComputing = false;
            state.rendezvousError = null;
        },
        setRendezvousError(state, action: PayloadAction<string | null>) {
            state.rendezvousError = action.payload;
            state.rendezvousIsComputing = false;
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
            state.rendezvousResult = null;
        },
        setTLPenalty(state, action: PayloadAction<number>) {
            state.tlPenaltySeconds = Math.max(0, Math.min(600, action.payload));
            state.routes = [];
            state.rendezvousResult = null;
        },
        setElkFriendlyOnly(state, action: PayloadAction<boolean>) {
            state.elkFriendlyOnly = action.payload;
            // Recompute on next tick — the toggle changes which walk
            // edges the graph allows, so the cached routes may no
            // longer be valid (or may now be discoverable for the first
            // time).
            state.routes = [];
            state.rendezvousResult = null;
        },
        /**
         * Apply a decoded share-link payload. Wipes existing routes /
         * results so the recompute hooks start from a clean slate, and
         * opens the panel so the user actually sees what was loaded.
         */
        hydrateFromShare(
            state,
            action: PayloadAction<{
                mode: RoutePlannerMode;
                from: EndpointPick | null;
                to: EndpointPick | null;
                walkSpeed?: number;
                tlPenaltySeconds?: number;
                kNeighbors?: number;
                players?: Array<EndpointPick | null>;
                rendezvousObjective?: RendezvousObjective;
            }>,
        ) {
            const p = action.payload;
            state.mode = p.mode;
            state.from = p.from;
            state.to = p.to;
            state.routes = [];
            state.selectedIndex = 0;
            state.error = null;
            state.pickMode = null;
            state.rendezvousResult = null;
            state.rendezvousError = null;
            if (p.players !== undefined) {
                const next = p.players.slice();
                while (next.length < 2) next.push(null);
                state.players = next.slice(0, 8);
            }
            if (p.rendezvousObjective !== undefined) {
                state.rendezvousObjective = p.rendezvousObjective;
            }
            if (p.walkSpeed !== undefined) {
                state.walkSpeed = Math.max(0.5, Math.min(20, p.walkSpeed));
            }
            if (p.tlPenaltySeconds !== undefined) {
                state.tlPenaltySeconds = Math.max(0, Math.min(600, p.tlPenaltySeconds));
            }
            if (p.kNeighbors !== undefined) {
                state.kNeighbors = Math.max(1, Math.min(64, Math.trunc(p.kNeighbors)));
            }
            state.isOpen = true;
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
    setMode: setRoutePlannerMode,
    setPlayer: setRoutePlayer,
    addPlayer: addRoutePlayer,
    removePlayer: removeRoutePlayer,
    setRendezvousObjective,
    setRendezvousComputing,
    setRendezvousResult,
    setRendezvousError,
    setSelectedIndex: setRouteSelectedIndex,
    setComputing: setRouteComputing,
    setRoutes: setRoutePlannerRoutes,
    setError: setRoutePlannerError,
    setWalkSpeed: setRouteWalkSpeed,
    setTLPenalty: setRouteTLPenalty,
    setElkFriendlyOnly: setRouteElkFriendlyOnly,
    setFocusRequest: setRouteFocusRequest,
    hydrateFromShare: hydrateRoutePlannerFromShare,
} = routePlannerSlice.actions;
