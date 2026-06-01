// Elk-walkable draft + remote-state slice.
//
// Two pieces of state coexist here:
//
//  1. `edges` — server-authoritative set of confirmed elk-walkable edges,
//     fetched from `/api/elk-walkable/url`. Keyed by `canonicalEdgeKey`
//     for O(1) membership tests from the routing graph.
//
//  2. `pendingAttest` / `pendingUnattest` — local draft the user
//     accumulates by right-clicking walk segments in the planner. Nothing
//     is sent until they click Submit, which is the only call that
//     burns a daily-cap slot.
//
// Persistence: server `edges` are NOT persisted (always re-fetched on
// load); draft lists ARE persisted via the root envelope so an
// accidental reload doesn't lose the user's in-progress contributions.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {
    canonicalEdgeKey,
    type EdgeEndpointRef,
    type ElkWalkableEdge,
    type PendingEdgeChange,
} from "@/lib/elk-walkable";

export type SubmitStatus =
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success"; changeId: string; appliedCount: number; at: number }
    | { kind: "error"; message: string; at: number };

export interface ElkWalkableState {
    loaded: boolean;
    loading: boolean;
    loadError: string | null;
    /** Server-confirmed edges, keyed by canonical key. */
    edges: Record<string, ElkWalkableEdge>;
    /** Fingerprint of the current server snapshot (R2 etag). Used as the
     *  cache key by the routing graph builder so a freshly-fetched set
     *  invalidates the cached graph. Empty string for the initial /
     *  empty state. */
    etag: string;
    /** Walk segments the user wants to mark as elk-friendly on next Submit. */
    pendingAttest: PendingEdgeChange[];
    /** Walk segments the user wants to *unmark* (remove their attestation). */
    pendingUnattest: PendingEdgeChange[];
    submit: SubmitStatus;
}

export const initialElkWalkableState: ElkWalkableState = {
    loaded: false,
    loading: false,
    loadError: null,
    edges: {},
    etag: "",
    pendingAttest: [],
    pendingUnattest: [],
    submit: { kind: "idle" },
};

interface ToggleDraftPayload {
    a: EdgeEndpointRef;
    b: EdgeEndpointRef;
}

function makePending(a: EdgeEndpointRef, b: EdgeEndpointRef): PendingEdgeChange {
    return { a, b, key: canonicalEdgeKey(a, b) };
}

function removeByKey(list: PendingEdgeChange[], key: string): PendingEdgeChange[] {
    return list.filter((p) => p.key !== key);
}

export const elkWalkableSlice = createSlice({
    name: "elkWalkable",
    initialState: initialElkWalkableState,
    reducers: {
        setLoading(state, action: PayloadAction<boolean>) {
            state.loading = action.payload;
            if (action.payload) state.loadError = null;
        },
        setLoadError(state, action: PayloadAction<string | null>) {
            state.loadError = action.payload;
            state.loading = false;
        },
        /** Replace the entire server-confirmed edge set. */
        setEdges(
            state,
            action: PayloadAction<{ edges: ElkWalkableEdge[]; etag: string }>,
        ) {
            const next: Record<string, ElkWalkableEdge> = {};
            for (const e of action.payload.edges) {
                if (e && typeof e.key === "string") {
                    next[e.key] = e;
                }
            }
            state.edges = next;
            state.etag = action.payload.etag;
            state.loaded = true;
            state.loading = false;
            state.loadError = null;
        },
        /** Toggle an attest draft. Removing from attest cancels an in-progress
         *  add; if the edge is currently confirmed, falls through to unattest. */
        togglePendingAttest(state, action: PayloadAction<ToggleDraftPayload>) {
            const pending = makePending(action.payload.a, action.payload.b);
            const hadAttest = state.pendingAttest.some((p) => p.key === pending.key);
            // Always strip from unattest so a single toggle never leaves an
            // edge in conflicting draft states.
            state.pendingUnattest = removeByKey(state.pendingUnattest, pending.key);
            if (hadAttest) {
                state.pendingAttest = removeByKey(state.pendingAttest, pending.key);
            } else {
                state.pendingAttest.push(pending);
            }
        },
        togglePendingUnattest(state, action: PayloadAction<ToggleDraftPayload>) {
            const pending = makePending(action.payload.a, action.payload.b);
            const hadUnattest = state.pendingUnattest.some((p) => p.key === pending.key);
            state.pendingAttest = removeByKey(state.pendingAttest, pending.key);
            if (hadUnattest) {
                state.pendingUnattest = removeByKey(state.pendingUnattest, pending.key);
            } else {
                state.pendingUnattest.push(pending);
            }
        },
        removePending(state, action: PayloadAction<string>) {
            state.pendingAttest = removeByKey(state.pendingAttest, action.payload);
            state.pendingUnattest = removeByKey(state.pendingUnattest, action.payload);
        },
        clearDraft(state) {
            state.pendingAttest = [];
            state.pendingUnattest = [];
        },
        setSubmitStatus(state, action: PayloadAction<SubmitStatus>) {
            state.submit = action.payload;
        },
    },
});

export const {
    setLoading: setElkWalkableLoading,
    setLoadError: setElkWalkableLoadError,
    setEdges: setElkWalkableEdges,
    togglePendingAttest: toggleElkPendingAttest,
    togglePendingUnattest: toggleElkPendingUnattest,
    removePending: removeElkPending,
    clearDraft: clearElkDraft,
    setSubmitStatus: setElkSubmitStatus,
} = elkWalkableSlice.actions;
