// Local-storage based consent flag.
//
// The site stores a small amount of data in the browser (API key, admin flag,
// TanStack Query cache, last-selected map level). None of it is used for
// tracking or advertising, but it is still browser storage and we want an
// explicit opt-in before writing anything user-identifying (especially the
// API key claimed from an invite link).
//
// Bump CONSENT_VERSION if the wording / scope of what we store changes so
// existing users are re-prompted.

export const CONSENT_VERSION = "1";
const CONSENT_KEY = "storage_consent";

export type ConsentValue = "accepted" | "declined";

export function getStoredConsent(): ConsentValue | null {
    try {
        const raw = localStorage.getItem(CONSENT_KEY);
        if (!raw) return null;
        const [version, value] = raw.split(":");
        if (version !== CONSENT_VERSION) return null;
        if (value === "accepted" || value === "declined") return value;
        return null;
    } catch {
        return null;
    }
}

export function setStoredConsent(value: ConsentValue) {
    try {
        localStorage.setItem(CONSENT_KEY, `${CONSENT_VERSION}:${value}`);
    } catch {
        // ignore — storage may be disabled
    }
    // Notify same-tab listeners (storage event only fires across tabs).
    window.dispatchEvent(new CustomEvent("storage-consent-change", { detail: value }));
}

export function hasAcceptedStorage(): boolean {
    return getStoredConsent() === "accepted";
}
