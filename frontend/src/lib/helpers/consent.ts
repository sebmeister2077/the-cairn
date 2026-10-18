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

/**
 * Ask the consent banner to reopen so the user can review or change their
 * choice, WITHOUT clearing the current decision (unlike `clearStoredConsent`).
 * The banner leaves the existing choice intact unless the user picks again.
 */
export function openCookieSettings() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("open-cookie-settings"));
}

export function hasAcceptedStorage(): boolean {
    return getStoredConsent() === "accepted";
}

export function hasDeclinedStorage(): boolean {
    return getStoredConsent() === "declined";
}

/**
 * Persist a non-essential value to localStorage only once the user has
 * accepted browser storage. Before then this is a no-op, so features that
 * lean on these prefs keep working in memory for the session but write
 * nothing to disk (we only ever store the API key pre-consent).
 */
export function writeIfConsented(key: string, value: string): void {
    if (typeof window === "undefined") return;
    if (!hasAcceptedStorage()) return;
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // ignore quota / privacy errors
    }
}
