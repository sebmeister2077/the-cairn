/**
 * Slice for the "Contribute TLs" page. Holds the in-progress user
 * translocator list along with UI toggles for the preview map.
 *
 * NOT persisted (intentionally — the page is a one-shot upload flow). Add
 * to `PERSIST_BLACKLIST` in `rootPersistence.ts` if persistence becomes
 * an accidental regression.
 */

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";
import type { UserTL } from "@/models/contributeTLs";

export type DragMode = "none" | "link" | "move";

export interface ContributeTLsState {
    userTLs: UserTL[];
    /** Local id of the TL currently highlighted in the side panel / map. */
    selectedTLId: string | null;
    /** Monotonic counter bumped whenever the user explicitly *navigates*
     * to a TL (e.g. clicked a row, or clicked an endpoint on the map).
     * Consumed by the map to fly to the TL and by the list to scroll the
     * row into view + flash it. Distinct from selection so re-selecting
     * the same TL still fires the navigation. */
    navTick: number;
    /** Local id of the TL currently being edited in a dialog (null = no dialog open). */
    editingTLId: string | null;
    dragMode: DragMode;
    /** When true, panning/zooming the map is disabled (so drag operations are unambiguous). */
    mapLocked: boolean;
    /** Optional contributor name (sent with the submission). */
    contributor: string;
    /** When true, faint dashed lines from a selected `new-unconfirmed` TL
     * are drawn to all other unpaired user TLs within the approx radius,
     * so the user can click one to merge instead of using the link tool. */
    showCandidates: boolean;
    /** Set on successful submit; cleared on `reset`. */
    submittedCount: number | null;
}

const initialState: ContributeTLsState = {
    userTLs: [],
    selectedTLId: null,
    navTick: 0,
    editingTLId: null,
    dragMode: "none",
    mapLocked: false,
    contributor: "",
    showCandidates: false,
    submittedCount: null,
};

export const contributeTLsSlice = createSlice({
    name: "contributeTLs",
    initialState,
    reducers: {
        setUserTLs(state, action: PayloadAction<UserTL[]>) {
            state.userTLs = action.payload;
            state.selectedTLId = null;
            state.editingTLId = null;
            state.submittedCount = null;
        },
        updateUserTL(state, action: PayloadAction<UserTL>) {
            const i = state.userTLs.findIndex((t) => t.localId === action.payload.localId);
            if (i >= 0) state.userTLs[i] = action.payload;
        },
        removeUserTL(state, action: PayloadAction<string>) {
            state.userTLs = state.userTLs.filter((t) => t.localId !== action.payload);
            if (state.selectedTLId === action.payload) state.selectedTLId = null;
            if (state.editingTLId === action.payload) state.editingTLId = null;
        },
        addUserTL(state, action: PayloadAction<UserTL>) {
            state.userTLs.push(action.payload);
        },
        setSelectedTLId(state, action: PayloadAction<string | null>) {
            state.selectedTLId = action.payload;
        },
        /** Select + bump the navigation tick (triggers map fly-to + list scroll/flash). */
        navigateToTL(state, action: PayloadAction<string>) {
            state.selectedTLId = action.payload;
            state.navTick += 1;
        },
        setEditingTLId(state, action: PayloadAction<string | null>) {
            state.editingTLId = action.payload;
        },
        setDragMode(state, action: PayloadAction<DragMode>) {
            state.dragMode = action.payload;
            // Drag modes implicitly lock the map so the user doesn't pan
            // while trying to drag a point.
            state.mapLocked = action.payload !== "none" || state.mapLocked;
        },
        setMapLocked(state, action: PayloadAction<boolean>) {
            state.mapLocked = action.payload;
            // Releasing the lock also exits any drag mode (so the toggles
            // don't go out of sync).
            if (!action.payload) state.dragMode = "none";
        },
        setContributor(state, action: PayloadAction<string>) {
            state.contributor = action.payload;
        },
        setShowCandidates(state, action: PayloadAction<boolean>) {
            state.showCandidates = action.payload;
        },
        setSubmittedCount(state, action: PayloadAction<number | null>) {
            state.submittedCount = action.payload;
        },
        reset() {
            return initialState;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            // Slice is intentionally not persisted; ignore hydrate payloads.
            void state;
            void action;
        });
    },
});

export const {
    setUserTLs,
    updateUserTL,
    removeUserTL,
    addUserTL,
    setSelectedTLId,
    navigateToTL,
    setEditingTLId,
    setDragMode,
    setMapLocked,
    setContributor,
    setShowCandidates,
    setSubmittedCount,
    reset: resetContributeTLs,
} = contributeTLsSlice.actions;
