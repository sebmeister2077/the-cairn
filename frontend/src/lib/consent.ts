// Consent helpers — Redux-backed.
//
// The runtime value lives in the slice in [store/slices/consent.ts]; these
// wrappers keep the existing public API for non-React callers.

import { store } from "@/store";
import {
    clearConsent,
    setConsent,
    type ConsentValue,
} from "@/store/slices/consent";

export const CONSENT_VERSION = "1";

export type { ConsentValue } from "@/store/slices/consent";

export function getStoredConsent(): ConsentValue | null {
    return store.getState().consent.value;
}

export function setStoredConsent(value: ConsentValue) {
    store.dispatch(setConsent(value));
    // Phase 4 cleanup: drop once every consumer reads from the store.
    window.dispatchEvent(new CustomEvent("storage-consent-change", { detail: value }));
}

/**
 * Wipe the stored consent decision so the consent prompt is shown again.
 * Used when the user previously declined and now wants to reconsider
 * (e.g. after seeing the "you need an API key" banner).
 */
export function clearStoredConsent() {
    store.dispatch(clearConsent());
    window.dispatchEvent(new CustomEvent("storage-consent-change", { detail: null }));
}

export function hasAcceptedStorage(): boolean {
    return getStoredConsent() === "accepted";
}

export function hasDeclinedStorage(): boolean {
    return getStoredConsent() === "declined";
}
