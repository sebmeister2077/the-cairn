// Cookie / browser-storage consent slice. Mirrors [lib/consent.ts].

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsRemove, lsWrite } from "../persistence";
import { hydrateRoot } from "../rootActions";

export const CONSENT_VERSION = "1";
const CONSENT_LS = "storage_consent";

export type ConsentValue = "accepted" | "declined";

export interface ConsentState {
    value: ConsentValue | null;
}

function readConsentFromStorage(): ConsentValue | null {
    const raw = lsRead(CONSENT_LS);
    if (!raw) return null;
    const [version, value] = raw.split(":");
    if (version !== CONSENT_VERSION) return null;
    if (value === "accepted" || value === "declined") return value;
    return null;
}

export function loadInitialConsentState(): ConsentState {
    return { value: readConsentFromStorage() };
}

export const consentSlice = createSlice({
    name: "consent",
    initialState: loadInitialConsentState(),
    reducers: {
        setConsent(state, action: PayloadAction<ConsentValue>) {
            state.value = action.payload;
        },
        clearConsent(state) {
            state.value = null;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.consent as ConsentState | undefined;
            return next ?? state;
        });
    },
});

export const { setConsent, clearConsent } = consentSlice.actions;

export function persistConsent(
    getSlice: () => ConsentState,
    prev: ConsentState,
) {
    const s = getSlice();
    if (s.value === prev.value) return;
    if (s.value == null) lsRemove(CONSENT_LS);
    else lsWrite(CONSENT_LS, `${CONSENT_VERSION}:${s.value}`);
}

export function reconcileConsentFromStorage(key: string) {
    if (key !== CONSENT_LS) return null;
    const v = readConsentFromStorage();
    return v == null ? clearConsent() : setConsent(v);
}
