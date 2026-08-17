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
import { apiKeyOnlyAuthState } from "./slices/auth";
import { loadInitialMapViewState } from "./slices/mapView";
import { DEFAULT_ADMIN_USAGE_FILTERS, DEFAULT_PAGES_FILTERS } from "./slices/adminUsageFilters";
import { initialRoutePlannerState } from "./slices/routePlanner";
import { initialElkWalkableState } from "./slices/elkWalkable";
import { normalizeInsightsFilters } from "./slices/insightsFilters";
import { normalizeMarketConcentration } from "./slices/marketConcentration";
import { normalizeMarketFavorites } from "./slices/marketFavorites";
import {
    DEFAULT_TERMINUS_STYLE,
    DEFAULT_TL_STYLE,
    DEFAULT_TRADER_STYLE,
    isTerminusStyle,
    isTLStyle,
    isTraderStyle,
} from "@/lib/markerStyles";
import { sanitizeTraderColors } from "@/lib/trader-types";

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
export const PERSIST_BLACKLIST: ReadonlyArray<keyof RootState> = [
    // The contribute-TLs page is a one-shot upload flow and stores parsed
    // chat-log data plus transient UI state — both should reset on reload.
    "contributeTLs",
    // Preview mode is a purely transient UI state.
    "topsMapPreview",
    // NOTE: `routePlanner` is intentionally NOT blacklisted — we want to
    // persist the user's cost-model preferences (walk speed, TL penalty,
    // kNeighbors) across reloads. Transient fields (endpoints, computed
    // routes, pickMode, focusRequest, isOpen) are stripped on write by
    // `STRIP_BEFORE_WRITE.routePlanner` so only the prefs hit disk.
];

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
    // Only persist the user's cost-model preferences. Endpoints,
    // computed routes, and other transient UI state should reset on
    // reload (From/To are re-hydrated from URL params if present).
    routePlanner: (s) => ({
        ...initialRoutePlannerState,
        walkSpeed: s.walkSpeed,
        tlPenaltySeconds: s.tlPenaltySeconds,
        kNeighbors: s.kNeighbors,
        elkFriendlyOnly: s.elkFriendlyOnly,
    }),
    // Only persist the draft attest/unattest lists. Server `edges` are
    // always re-fetched on load; transient `loading` / `submit` flags
    // would be confusing if restored from a prior session.
    elkWalkable: (s) => ({
        ...initialElkWalkableState,
        pendingAttest: s.pendingAttest,
        pendingUnattest: s.pendingUnattest,
    }),
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
    // Merge stored mapView fields over a fresh default state so newly-added
    // fields (e.g. `starfieldEnabled`) fall back to their slice defaults
    // for users whose envelope was written before the field existed. Without
    // this, `preloadedState` replaces the slice's `initialState` verbatim
    // and missing fields end up `undefined` at runtime.
    mapView: (s) => {
        const merged = { ...loadInitialMapViewState(), ...s };
        // Defensively snap any unrecognised persisted style to the default
        // so a typo or rolled-back schema can't crash the canvas draw.
        return {
            ...merged,
            // Advanced map options are always on now; never let a stale
            // persisted `false` disable them.
            showAdvancedMapOptions: true,
            traderStyle: isTraderStyle(merged.traderStyle)
                ? merged.traderStyle
                : DEFAULT_TRADER_STYLE,
            tlStyle: isTLStyle(merged.tlStyle) ? merged.tlStyle : DEFAULT_TL_STYLE,
            terminusStyle: isTerminusStyle(merged.terminusStyle)
                ? merged.terminusStyle
                : DEFAULT_TERMINUS_STYLE,
            // Drop malformed/unknown trader-color overrides.
            traderColors: sanitizeTraderColors(merged.traderColors),
        };
    },
    // Same defensive merge for the admin Usage filters slice: the `pages`
    // sub-object was added after the first release, so older envelopes
    // are missing it and would otherwise destructure to `undefined`.
    adminUsageFilters: (s) => ({
        ...DEFAULT_ADMIN_USAGE_FILTERS,
        ...s,
        pages: { ...DEFAULT_PAGES_FILTERS, ...(s?.pages ?? {}) },
    }),
    // Merge stored prefs over the fresh initial state so transient
    // fields (routes, focusRequest, pickMode, isOpen, endpoints) always
    // reset on reload even if an older envelope happened to persist them.
    routePlanner: (s) => ({ ...initialRoutePlannerState, ...s }),
    // Drafts persist; server state is always re-fetched, so merge over
    // initial state to wipe any stale `edges` / status flags from older
    // envelopes that may have been written before this stripper existed.
    elkWalkable: (s) => ({
        ...initialElkWalkableState,
        pendingAttest: Array.isArray(s?.pendingAttest) ? s.pendingAttest : [],
        pendingUnattest: Array.isArray(s?.pendingUnattest) ? s.pendingUnattest : [],
    }),
    // The Insights screener filters gained multi-select (array) fields plus a
    // new `concentration` field after the first envelope was written; normalise
    // so older stored objects (single-string fields / missing keys) don't
    // destructure to `undefined` at runtime.
    insightsFilters: (s) => normalizeInsightsFilters(s),
    // Two numeric thresholds; merge over defaults + clamp so an older or
    // partial envelope can't yield NaN/undefined at runtime.
    marketConcentration: (s) => normalizeMarketConcentration(s),
    // Dedupe / drop malformed IDs from a stored favorites list.
    marketFavorites: (s) => normalizeMarketFavorites(s),
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
 * slices and applying per-slice transient strippers. Used once the user
 * has accepted browser storage (`consent.value === "accepted"`).
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

/**
 * Build the pre-consent envelope. The only things we're entitled to store
 * before the user accepts are the API key (rate-limiting continuity, see
 * `apiKeyOnlyAuthState`) and the consent decision itself.
 *
 * We must not *destroy* data a returning user stored under the previous
 * (pre-banner) behaviour just because they haven't clicked yet, so while the
 * choice is still undecided we preserve whatever is already on disk and only
 * refresh the essentials on top. An explicit **decline** purges everything
 * non-essential.
 */
function buildMinimalEnvelope(state: RootState, existing: Envelope | null): Envelope {
    const essentials: Envelope["slices"] = {
        auth: apiKeyOnlyAuthState(state.auth.apiKey) as unknown,
        consent: state.consent as unknown,
    };
    const base = state.consent.value === "declined" ? {} : (existing?.slices ?? {});
    return { version: ENVELOPE_VERSION, slices: { ...base, ...essentials } };
}

/**
 * Serialize the state we're allowed to persist given the current consent
 * decision. Shared by the store subscriber and the cross-tab listener so
 * both agree on what "already written" means.
 */
function serializeForStorage(state: RootState): string {
    if (state.consent.value === "accepted") {
        return JSON.stringify(buildEnvelopeForState(state));
    }
    return JSON.stringify(buildMinimalEnvelope(state, parseEnvelope(lsRead(PERSIST_KEY))));
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
    // Dedupe by serialized envelope CONTENT, not object identity. A cross-tab
    // `hydrateRoot` (and the follow-up effects it triggers) re-derives the same
    // logical state with fresh object references, so an identity check would
    // treat it as a change and echo it back to the other tab — an infinite
    // ping-pong whenever two tabs are open. Comparing the serialized bytes lets
    // us skip writes that don't actually change what's stored.
    let lastWrittenJson: string | null = null;

    const flush = () => {
        scheduled = false;
        let json: string;
        try {
            json = serializeForStorage(store.getState());
        } catch {
            // ignore quota / serialization errors — runtime state is still
            // correct, only the next reload would be off.
            return;
        }
        if (json === lastWrittenJson) return;
        lastWrittenJson = json;
        lsWrite(PERSIST_KEY, json);
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
        store.dispatch(hydrateRoot(payload));
        // Record the post-hydrate serialization as "already written" so our own
        // subscriber (and any effects the hydrate re-triggers) don't echo an
        // identical envelope back to storage and bounce it between tabs.
        try {
            lastWrittenJson = serializeForStorage(store.getState());
        } catch {
            lastWrittenJson = null;
        }
    });
}

/** Test/debug helper: wipe the envelope. State stays in memory until reload. */
export function clearPersistedRoot() {
    lsRemove(PERSIST_KEY);
}
