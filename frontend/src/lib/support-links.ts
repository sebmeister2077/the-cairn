// Voluntary donation link config. Kept extensible so more providers can be added later.
const rawKofiUrl = (import.meta.env.VITE_KOFI_URL ?? "").trim();

// Only accept absolute https URLs so a misconfigured env var can't inject an unsafe href.
function safeExternalUrl(value: string): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.toString() : null;
    } catch {
        return null;
    }
}

export const KOFI_URL = safeExternalUrl(rawKofiUrl);

export const hasSupport = KOFI_URL !== null;
