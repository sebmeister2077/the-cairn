// Single-envelope persistence for the Redux store.
//
// All persisted slices live under one localStorage key (`PERSIST_KEY`) as
// a versioned envelope `{ version, slices: { ... } }`. Compared to the
// previous "one localStorage key per slice" approach this:
//
//   * Makes it obvious in DevTools what the app actually stores
//     (one row instead of ~12).
//   * Lets us blacklist slices declaratively — anything in
//     `PERSIST_BLACKLIST` is never written, so on the next page load the
//     slice falls back to its `initialState` ("clean on reload").
//   * Keeps cross-tab sync to a single `storage` event listener that
//     dispatches `hydrateRoot` once per envelope change.
//
// Migration from the legacy per-slice keys is handled in [./index.ts]:
// each slice's `loadInitial*State()` still reads its old keys, so the
// first run after upgrade picks up existing values; the next dispatch
// writes the envelope and from then on the envelope wins.

import type { Store } from "@reduxjs/toolkit";
import { lsRead, lsRemove, lsWrite } from "./persistence";
import { hydrateRoot } from "./rootActions";
import type { RootState } from "./index";

export const PERSIST_KEY = "vsw:state:v1";
const ENVELOPE_VERSION = 1;

/**
 * Slices that are intentionally NOT persisted. Add a slice key here to
 * make it reset to its `initialState` on every page reload. A blacklisted
 * slice is also ignored in cross-tab `hydrateRoot` dispatches.
 *
 * Examples:
 *   ["resourcesOverlay"]     // forget overlay toggles between sessions
 *   ["adminUsersFilters"]    // always start with the default filters
 */
export const PERSIST_BLACKLIST: ReadonlyArray<keyof RootState> = [];

/**
 * Per-slice cleaner applied **before** writing the envelope. Use it to
 * scrub transient or sensitive fields that should never hit disk even
 * when the parent slice is persisted.
 */
const STRIP_BEFORE_WRITE: {
    [K in keyof RootState]?: (s: RootState[K]) => RootState[K];
} = {
    // `rejectedApiKey` is an in-memory back-pressure marker, not user data.
    auth: (s) => ({ ...s, rejectedApiKey: null }),
};

/**
 * Per-slice normaliser applied **after** reading the envelope (and after
 * cross-tab hydration). Use it to invalidate stored data that has
 * expired or otherwise become unsafe to apply verbatim.
 */
const NORMALIZE_ON_READ: {
    [K in keyof RootState]?: (s: RootState[K]) => RootState[K];
} = {
    auth: (s) => {
        // Drop expired admin session tokens during preload so the first
        // render doesn't briefly show "logged in as admin" with a stale
        // token. Same logic the legacy `loadInitialAuthState` had.
        if (
            s.adminSessionExpiresAt != null &&
            Date.now() > s.adminSessionExpiresAt
        ) {
            return {
                ...s,
                adminSessionToken: null,
                adminSessionExpiresAt: null,
                rejectedApiKey: null,
            };
        }
        return { ...s, rejectedApiKey: null };
    },
};

interface Envelope {
    version: number;
    slices: Partial<Record<keyof RootState, unknown>>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEnvelope(raw: string | null): Envelope | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isPlainObject(parsed)) return null;
        if (parsed.version !== ENVELOPE_VERSION) return null;
        if (!isPlainObject(parsed.slices)) return null;
        return { version: ENVELOPE_VERSION, slices: parsed.slices as Envelope["slices"] };
    } catch {
        return null;
    }
}

/**
 * Read the envelope from localStorage and return its slice payload, with
 * blacklisted slices and stale fields filtered out. Returns `null` when
 * no envelope is stored — callers should fall back to slice defaults.
 */
export function loadPersistedRoot(): Partial<RootState> | null {
    const env = parseEnvelope(lsRead(PERSIST_KEY));
    if (!env) return null;
    // The loop body is too dynamic for TS to track per-key type
    // narrowing, so we work in `unknown` and assemble a loose record.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(env.slices) as Array<keyof RootState>) {
        if (PERSIST_BLACKLIST.includes(key)) continue;
        const raw = env.slices[key];
        if (raw === undefined) continue;
        const normalize = NORMALIZE_ON_READ[key] as
            | ((s: unknown) => unknown)
            | undefined;
        out[key as string] = normalize ? normalize(raw) : raw;
    }
    return out as Partial<RootState>;
}

/**
 * Build the envelope payload from current state, omitting blacklisted
 * slices and applying per-slice transient strippers.
 */
function buildEnvelopeForState(state: RootState): Envelope {
    const slices: Envelope["slices"] = {};
    for (const key of Object.keys(state) as Array<keyof RootState>) {
        if (PERSIST_BLACKLIST.includes(key)) continue;
        const strip = STRIP_BEFORE_WRITE[key] as
            | ((s: RootState[typeof key]) => RootState[typeof key])
            | undefined;
        slices[key] = (strip ? strip(state[key]) : state[key]) as unknown;
    }
    return { version: ENVELOPE_VERSION, slices };
}

function writeEnvelope(state: RootState) {
    try {
        const env = buildEnvelopeForState(state);
        lsWrite(PERSIST_KEY, JSON.stringify(env));
    } catch {
        // ignore quota / serialization errors — runtime state is still
        // correct, only the next reload would be off.
    }
}

/**
 * Set up the persistence subscriber + cross-tab listener. Call once,
 * after the store is constructed.
 *
 * The subscriber coalesces back-to-back dispatches into a single write
 * via `queueMicrotask`, so a burst of N actions only triggers one
 * envelope serialization.
 */
export function installRootPersistence(store: Store<RootState>) {
    let scheduled = false;
    let lastWrittenState: RootState | null = null;

    const flush = () => {
        scheduled = false;
        const s = store.getState();
        if (s === lastWrittenState) return;
        lastWrittenState = s;
        writeEnvelope(s);
    };

    store.subscribe(() => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
    });

    if (typeof window === "undefined") return;
    window.addEventListener("storage", (e) => {
        if (e.key !== PERSIST_KEY) return;
        const env = parseEnvelope(e.newValue);
        if (!env) return;
        const payload: Record<string, unknown> = {};
        for (const key of Object.keys(env.slices) as Array<keyof RootState>) {
            if (PERSIST_BLACKLIST.includes(key)) continue;
            const raw = env.slices[key];
            const normalize = NORMALIZE_ON_READ[key] as
                | ((s: unknown) => unknown)
                | undefined;
            payload[key as string] = normalize ? normalize(raw) : raw;
        }
        // Mark this state as "already written" so our own subscriber
        // doesn't immediately echo the same envelope back to storage.
        lastWrittenState = null;
        store.dispatch(hydrateRoot(payload));
        lastWrittenState = store.getState();
    });
}

/** Test/debug helper: wipe the envelope. State stays in memory until reload. */
export function clearPersistedRoot() {
    lsRemove(PERSIST_KEY);
}
