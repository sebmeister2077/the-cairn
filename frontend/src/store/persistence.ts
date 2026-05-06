// Generic localStorage helpers shared by slice persistence.
//
// Each slice owns the shape it reads/writes; this module just provides
// safe-in-non-browser primitives so we don't sprinkle `typeof window`
// checks everywhere.

export function lsRead(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function lsWrite(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // ignore quota / privacy errors
    }
}

export function lsRemove(key: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(key);
    } catch {
        // ignore
    }
}

export function lsReadJson<T>(key: string, fallback: T): T {
    const raw = lsRead(key);
    if (raw == null) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function lsWriteJson(key: string, value: unknown): void {
    lsWrite(key, JSON.stringify(value));
}
