// Tops-map "preview mode" coordination slice.
//
// The bulk-attest dialog (MarkGroupingElkDialog) lets the user enter a
// preview mode that hides the rest of the overlay UI on the map and
// displays only the walk edges of the grouping currently being marked.
// Three actors talk through this slice:
//
//   * `MarkGroupingElkDialog` dispatches `enterPreview` with a snapshot of
//     its local state (max-walk slider, ignored set, show-all flag) so the
//     dialog can be rebuilt in the same shape on exit. It also passes the
//     pre-projected walk segments to render, plus an optional focus key.
//   * `TLGroupingsDrawer` watches `groupingId`/`active`: closes the dialog
//     when preview activates and re-opens it for the matching grouping
//     once preview ends.
//   * `TOPSMapViewPage` reads `active` to gate every other overlay layer,
//     reads `segments` to draw the preview-only walks, and reads
//     `focusEdgeKey` to centre the map on a specific walk.
//
// The slice is intentionally not persisted (preview is a transient UI
// state) — see `PERSIST_BLACKLIST` in `rootPersistence.ts`.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface PreviewWalkSegment {
    /** Stable canonical edge key (matches `GroupingElkEdge.key`). */
    key: string;
    fromX: number;
    fromZ: number;
    toX: number;
    toZ: number;
    /** Visual state, mirrors the same vocabulary the route overlay uses
     *  for walk legs so the page can recolour without re-classifying. */
    elkState:
    | "not-attestable"
    | "unconfirmed"
    | "confirmed"
    | "confirmed-by-me"
    | "pending-attest"
    | "pending-unattest";
}

export interface MarkElkDialogSnapshot {
    /** Edge keys the user has marked as "ignore" — kept visible in the
     *  list but excluded from staging. */
    ignoredKeys: string[];
    maxWalkBlocks: number;
    showAllRows: boolean;
}

export interface TopsMapPreviewState {
    /** When true, the page hides every other overlay and renders only
     *  `segments`. */
    active: boolean;
    /** Grouping the dialog is currently bulk-attesting. Held while the
     *  dialog is hidden so the drawer can re-open it on exit. */
    groupingId: string | null;
    segments: PreviewWalkSegment[];
    /** When set, the page issues a fresh `setRouteFocusRequest` for that
     *  edge's midpoint so the user lands on it. */
    focusEdgeKey: string | null;
    /** Snapshot of the dialog's local state captured on entry. The
     *  dialog reads this once on remount and dispatches
     *  `consumeDialogStateSnapshot` to clear it. */
    dialogStateSnapshot: MarkElkDialogSnapshot | null;
}

export const initialTopsMapPreviewState: TopsMapPreviewState = {
    active: false,
    groupingId: null,
    segments: [],
    focusEdgeKey: null,
    dialogStateSnapshot: null,
};

interface EnterPreviewPayload {
    groupingId: string;
    segments: PreviewWalkSegment[];
    focusEdgeKey: string | null;
    dialogStateSnapshot: MarkElkDialogSnapshot;
}

export const topsMapPreviewSlice = createSlice({
    name: "topsMapPreview",
    initialState: initialTopsMapPreviewState,
    reducers: {
        enterPreview(state, action: PayloadAction<EnterPreviewPayload>) {
            state.active = true;
            state.groupingId = action.payload.groupingId;
            state.segments = action.payload.segments;
            state.focusEdgeKey = action.payload.focusEdgeKey;
            state.dialogStateSnapshot = action.payload.dialogStateSnapshot;
        },
        /** Stop hiding overlays. The drawer will see `groupingId` is
         *  still set with `active=false` and re-open the dialog; the
         *  dialog then consumes the snapshot. */
        exitPreview(state) {
            state.active = false;
            state.segments = [];
            state.focusEdgeKey = null;
        },
        /** Called by the dialog after it has read its initial state
         *  from the snapshot. Also clears `groupingId` so the drawer
         *  doesn't loop. */
        consumeDialogStateSnapshot(state) {
            state.dialogStateSnapshot = null;
            state.groupingId = null;
        },
        /** Update the focus pointer mid-preview (e.g. the user clicked
         *  another edge from a side panel — currently unused but a
         *  natural extension point). */
        setPreviewFocusEdge(state, action: PayloadAction<string | null>) {
            state.focusEdgeKey = action.payload;
        },
    },
});

export const {
    enterPreview,
    exitPreview,
    consumeDialogStateSnapshot,
    setPreviewFocusEdge,
} = topsMapPreviewSlice.actions;
