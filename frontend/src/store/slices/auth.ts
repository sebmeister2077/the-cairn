// Auth slice — runtime source of truth for the API key, cached admin /
// contributor flags, and the admin passkey session token.
//
// Persistence: writes back to the same `localStorage` keys the legacy
// helpers in [lib/api.ts] read/write so a downgrade or rollback is
// lossless. The `rejectedApiKey` field is intentionally NOT persisted —
// it's an in-memory back-pressure marker per browser tab.
//
// The custom `api-key-change` / `admin-session-changed` / `auth-rejected`
// DOM events that the rest of the app currently listens to are still
// dispatched by the wrapper functions in [lib/api.ts] (Phase 4 cleanup
// will remove them once every consumer has switched to selectors).

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsRemove, lsWrite } from "../persistence";
import { hydrateRoot } from "../rootActions";

const API_KEY_LS = "api_key";
const IS_ADMIN_LS = "is_admin";
const CAN_CONTRIBUTE_LS = "can_contribute";
const ADMIN_SESSION_LS = "admin_session";
const ADMIN_SESSION_EXPIRES_LS = "admin_session_expires";

export interface AuthState {
    apiKey: string;
    isAdmin: boolean;
    canContribute: boolean;
    /** Opaque WebAuthn-bound session token returned by the backend. */
    adminSessionToken: string | null;
    /** Epoch milliseconds at which `adminSessionToken` becomes invalid. */
    adminSessionExpiresAt: number | null;
    /**
     * In-memory marker: set to the value of `apiKey` at the moment the backend
     * returned 401. While it equals the current `apiKey`, we short-circuit
     * `authHeaders()`-driven requests so a react-query refetch storm doesn't
     * busy-loop after `queryClient.clear()`. The empty string is a meaningful
     * value (= "no key was stored when we got rejected") and must not collapse
     * to `null`. Reset whenever `apiKey` changes.
     */
    rejectedApiKey: string | null;
}

export function loadInitialAuthState(): AuthState {
    const tokenRaw = lsRead(ADMIN_SESSION_LS);
    const expRaw = Number(lsRead(ADMIN_SESSION_EXPIRES_LS) ?? "0");
    // Drop expired session tokens during preload so the first render doesn't
    // briefly show "logged in as admin" with a stale token.
    const expired = expRaw > 0 && Date.now() > expRaw;
    return {
        apiKey: lsRead(API_KEY_LS) ?? "",
        isAdmin: lsRead(IS_ADMIN_LS) === "true",
        canContribute:
            lsRead(CAN_CONTRIBUTE_LS) === "true" || lsRead(IS_ADMIN_LS) === "true",
        adminSessionToken: !tokenRaw || expired ? null : tokenRaw,
        adminSessionExpiresAt: !tokenRaw || expired ? null : expRaw || null,
        rejectedApiKey: null,
    };
}

const initialState: AuthState = loadInitialAuthState();

export const authSlice = createSlice({
    name: "auth",
    initialState,
    reducers: {
        setApiKey(state, action: PayloadAction<string>) {
            const next = action.payload;
            if (state.apiKey === next) return;
            state.apiKey = next;
            // A different key — give it a fresh chance even if the previous
            // one had been rejected.
            state.rejectedApiKey = null;
        },
        setIsAdmin(state, action: PayloadAction<boolean>) {
            state.isAdmin = action.payload;
        },
        setCanContribute(state, action: PayloadAction<boolean>) {
            state.canContribute = action.payload;
        },
        clearAuthFlags(state) {
            state.isAdmin = false;
            state.canContribute = false;
        },
        setAdminSession(
            state,
            action: PayloadAction<{ token: string; expiresAt: number }>,
        ) {
            state.adminSessionToken = action.payload.token;
            state.adminSessionExpiresAt = action.payload.expiresAt;
        },
        clearAdminSession(state) {
            state.adminSessionToken = null;
            state.adminSessionExpiresAt = null;
        },
        markCurrentKeyRejected(state) {
            state.rejectedApiKey = state.apiKey;
        },
        clearRejectedMarker(state) {
            state.rejectedApiKey = null;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.auth as AuthState | undefined;
            if (next) return { ...next, rejectedApiKey: null };
            return state;
        });
    },
});

export const {
    setApiKey,
    setIsAdmin,
    setCanContribute,
    clearAuthFlags,
    setAdminSession,
    clearAdminSession,
    markCurrentKeyRejected,
    clearRejectedMarker,
} = authSlice.actions;

/** Wire up the persistence sink. Call once after the store exists. */
export function persistAuth(getSlice: () => AuthState, prev: AuthState) {
    const s = getSlice();
    if (s.apiKey !== prev.apiKey) lsWrite(API_KEY_LS, s.apiKey);
    if (s.isAdmin !== prev.isAdmin)
        lsWrite(IS_ADMIN_LS, s.isAdmin ? "true" : "false");
    if (s.canContribute !== prev.canContribute)
        lsWrite(CAN_CONTRIBUTE_LS, s.canContribute ? "true" : "false");
    if (s.adminSessionToken !== prev.adminSessionToken) {
        if (s.adminSessionToken == null) lsRemove(ADMIN_SESSION_LS);
        else lsWrite(ADMIN_SESSION_LS, s.adminSessionToken);
    }
    if (s.adminSessionExpiresAt !== prev.adminSessionExpiresAt) {
        if (s.adminSessionExpiresAt == null) lsRemove(ADMIN_SESSION_EXPIRES_LS);
        else lsWrite(ADMIN_SESSION_EXPIRES_LS, String(s.adminSessionExpiresAt));
    }
}

/** Cross-tab reconciliation: another tab wrote one of our keys. */
export function reconcileAuthFromStorage(
    key: string,
    newValue: string | null,
): { type: string; payload?: unknown } | null {
    switch (key) {
        case API_KEY_LS:
            return setApiKey(newValue ?? "");
        case IS_ADMIN_LS:
            return setIsAdmin(newValue === "true");
        case CAN_CONTRIBUTE_LS:
            return setCanContribute(newValue === "true");
        case ADMIN_SESSION_LS:
            return newValue ? null /* needs both token+exp */ : clearAdminSession();
        case ADMIN_SESSION_EXPIRES_LS:
            return null;
        default:
            return null;
    }
}
