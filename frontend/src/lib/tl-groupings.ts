import { useCallback, useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setGroupings as setGroupingsAction } from "@/store/slices/tlGroupings";

import type { WorldLineSegment } from "@/components/MapViewer";

/**
 * Local-only "favorite TL groupings" feature.
 *
 * Users curate named groupings of translocators on the TOPS map and can either
 * filter the map down to only the TLs in their selected groupings or highlight
 * those TLs while still rendering everything. All data lives in the browser's
 * localStorage — no backend involvement.
 */

/** Stable identifier for a single translocator segment, derived from coords. */
export type TLId = string;

export interface TLGrouping {
    id: string;
    name: string;
    /** Optional display color (hex like `#a855f7`). UI may use it for swatches. */
    color?: string;
    tlIds: TLId[];
    createdAt: number;
    updatedAt: number;
}

interface PersistedShape {
    version: 1;
    groupings: TLGrouping[];
}

const STORAGE_KEY = "tops-map-tl-groupings";
const STORAGE_VERSION = 1 as const;
/**
 * Marker so the built-in default grouping is only seeded once. After the
 * initial seed the user can rename, edit, or delete it freely without us
 * silently re-adding it on the next page load.
 */
const SEEDED_DEFAULTS_KEY = "tops-map-tl-groupings-seeded-defaults";

/**
 * Built-in starter groupings that are seeded into a user's local storage on
 * first visit. Each entry uses a fixed `id` so we can detect whether the user
 * still has it and avoid duplicating it across reloads. Once seeded, these
 * groupings behave like any other user-created grouping.
 */
const DEFAULT_GROUPINGS: readonly TLGrouping[] = [
    {
        "id": "d9989b4e-07a9-4212-93bd-560bf96b0a8e",
        "name": "N/S line",
        "tlIds": [
            "366,1314,-4615,8049",
            "-710,4596,-4466,8047",
            "-188,4666,2215,12518",
            "1374,-2067,-245,4615",
            "2463,12320,5328,14803",
            "5383,14771,10944,18470",
            "10947,18516,3070,22984",
            "3219,23060,-763,26695",
            "-907,26626,239,28698",
            "53,28501,1851,36273",
            "1632,36595,-3944,40974",
            "-3913,41016,-9641,45347",
            "-9779,45087,-3043,51384",
            "770,57555,-2913,51370",
            "890,57847,-881,65192"
        ],
        "createdAt": 1777623796429,
        "updatedAt": 1777912704136
    }
];

/**
 * Build the canonical TLId for a segment. Coordinates come straight from the
 * page's `WorldLineSegment` (after the geojson-load z-negation), so the same
 * key is stable round-trip from "user clicks TL" -> "stored in grouping" ->
 * "rendered as highlighted".
 */
export function tlIdFor(seg: WorldLineSegment): TLId {
    return `${seg.x1},${seg.z1},${seg.x2},${seg.z2}`;
}

function isFiniteNumber(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
}

function isTLGrouping(value: unknown): value is TLGrouping {
    if (!value || typeof value !== "object") return false;
    const g = value as Record<string, unknown>;
    return (
        typeof g.id === "string" &&
        typeof g.name === "string" &&
        Array.isArray(g.tlIds) &&
        g.tlIds.every((id) => typeof id === "string") &&
        isFiniteNumber(g.createdAt) &&
        isFiniteNumber(g.updatedAt) &&
        (g.color === undefined || typeof g.color === "string")
    );
}

function parsePersisted(raw: string | null): TLGrouping[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { version?: unknown }).version === STORAGE_VERSION &&
            Array.isArray((parsed as { groupings?: unknown }).groupings)
        ) {
            return (parsed as PersistedShape).groupings.filter(isTLGrouping);
        }
    } catch {
        // Corrupt storage — drop silently rather than wedging the page.
    }
    return [];
}

/**
 * Seed the built-in default groupings on first run. Idempotent: relies on
 * `SEEDED_DEFAULTS_KEY` so a user who deletes a default isn't re-served it on
 * the next load. Returns the list with any newly-seeded defaults appended.
 */
function seedDefaultsIfNeeded(existing: TLGrouping[]): TLGrouping[] {
    if (typeof window === "undefined") return existing;
    if (window.localStorage.getItem(SEEDED_DEFAULTS_KEY) === "1") return existing;
    const existingIds = new Set(existing.map((g) => g.id));
    const toSeed = DEFAULT_GROUPINGS.filter((g) => !existingIds.has(g.id));
    const next = toSeed.length === 0 ? existing : [...existing, ...toSeed];
    if (toSeed.length > 0) {
        const payload: PersistedShape = { version: STORAGE_VERSION, groupings: next };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
    window.localStorage.setItem(SEEDED_DEFAULTS_KEY, "1");
    return next;
}

/** Read all groupings from localStorage. Safe in non-browser environments. */
export function loadGroupings(): TLGrouping[] {
    if (typeof window === "undefined") return [];
    const stored = parsePersisted(window.localStorage.getItem(STORAGE_KEY));
    return seedDefaultsIfNeeded(stored);
}

/** Persist the full grouping list. Wraps in the versioned envelope. */
export function saveGroupings(list: TLGrouping[]): void {
    if (typeof window === "undefined") return;
    const payload: PersistedShape = { version: STORAGE_VERSION, groupings: list };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** Build the JSON string the UI hands to the user as a downloadable file. */
export function serializeForExport(list: TLGrouping[]): string {
    const payload: PersistedShape = { version: STORAGE_VERSION, groupings: list };
    return JSON.stringify(payload, null, 2);
}

/**
 * Parse user-supplied JSON. Returns the validated grouping list on success,
 * or `null` if the file is malformed / wrong shape. Does not mutate storage.
 */
export function parseImport(json: string): TLGrouping[] | null {
    try {
        const parsed: unknown = JSON.parse(json);
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { version?: unknown }).version === STORAGE_VERSION &&
            Array.isArray((parsed as { groupings?: unknown }).groupings)
        ) {
            const groupings = (parsed as PersistedShape).groupings.filter(isTLGrouping);
            return groupings;
        }
    } catch {
        // fall through
    }
    return null;
}

function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    // Fallback: not cryptographically strong but local-only data, this is fine.
    return `tlg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueIds(ids: TLId[]): TLId[] {
    return Array.from(new Set(ids));
}

export interface UseTLGroupingsResult {
    groupings: TLGrouping[];
    createGrouping: (name: string, opts?: { color?: string; tlIds?: TLId[] }) => TLGrouping;
    renameGrouping: (id: string, name: string) => void;
    deleteGrouping: (id: string) => void;
    setColor: (id: string, color: string | undefined) => void;
    addTLs: (groupingId: string, tlIds: TLId[]) => void;
    removeTLs: (groupingId: string, tlIds: TLId[]) => void;
    /** Toggle a single TL in a grouping (add if absent, remove if present). */
    toggleTL: (groupingId: string, tlId: TLId) => void;
    /** Replace the entire stored list with the supplied groupings. */
    importJSON: (json: string, mode: "replace" | "merge") => { ok: true; count: number } | { ok: false; error: string };
    /** Returns the JSON string for the user to download. */
    exportJSON: () => string;
}

/**
 * React hook wrapping the Redux-backed grouping list. Reads come from the
 * `tlGroupings` slice, mutations dispatch `setGroupings(next)` and the
 * slice's persistence subscriber writes to localStorage. Cross-tab sync is
 * handled centrally by the store's storage-event reconciler, so this hook
 * no longer needs a `storage` listener of its own.
 */
export function useTLGroupings(): UseTLGroupingsResult {
    const dispatch = useAppDispatch();
    const groupings = useAppSelector((s) => s.tlGroupings.items);

    // Helper that takes a producer, applies it against the latest slice
    // value, and dispatches the new array. We deliberately do NOT pass the
    // current `groupings` reference into deps so the returned callbacks
    // remain stable across renders — every invocation reads the most
    // recent state by closing over the dispatched action's reducer logic.
    const update = useCallback(
        (producer: (prev: TLGrouping[]) => TLGrouping[]) => {
            // We need the freshest array, so route through the slice using a
            // dispatched updater. The slice action sets state directly, so
            // we compute against the value we currently see and rely on
            // React-Redux's batched dispatch ordering to converge.
            dispatch((dispatchInner, getState) => {
                const prev = (getState as unknown as () => { tlGroupings: { items: TLGrouping[] } })()
                    .tlGroupings.items;
                const next = producer(prev);
                if (next !== prev) dispatchInner(setGroupingsAction(next));
            });
        },
        [dispatch],
    );

    // Keep the hook signature unchanged for callers, even though state now
    // lives in the slice. `useEffect` import retained to avoid touching
    // existing call sites — strip it once we're sure nothing else here uses it.
    useEffect(() => {
        // No-op: cross-tab sync handled by the store reconciler.
    }, []);

    const createGrouping = useCallback<UseTLGroupingsResult["createGrouping"]>(
        (name, opts) => {
            const now = Date.now();
            const grouping: TLGrouping = {
                id: generateId(),
                name: name.trim() || "Untitled grouping",
                color: opts?.color,
                tlIds: uniqueIds(opts?.tlIds ?? []),
                createdAt: now,
                updatedAt: now,
            };
            update((prev) => [...prev, grouping]);
            return grouping;
        },
        [update],
    );

    const renameGrouping = useCallback<UseTLGroupingsResult["renameGrouping"]>(
        (id, name) => {
            const trimmed = name.trim();
            if (!trimmed) return;
            update((prev) =>
                prev.map((g) => (g.id === id ? { ...g, name: trimmed, updatedAt: Date.now() } : g)),
            );
        },
        [update],
    );

    const deleteGrouping = useCallback<UseTLGroupingsResult["deleteGrouping"]>(
        (id) => {
            update((prev) => prev.filter((g) => g.id !== id));
        },
        [update],
    );

    const setColor = useCallback<UseTLGroupingsResult["setColor"]>(
        (id, color) => {
            update((prev) =>
                prev.map((g) => (g.id === id ? { ...g, color, updatedAt: Date.now() } : g)),
            );
        },
        [update],
    );

    const addTLs = useCallback<UseTLGroupingsResult["addTLs"]>(
        (groupingId, tlIds) => {
            if (tlIds.length === 0) return;
            update((prev) =>
                prev.map((g) =>
                    g.id === groupingId
                        ? { ...g, tlIds: uniqueIds([...g.tlIds, ...tlIds]), updatedAt: Date.now() }
                        : g,
                ),
            );
        },
        [update],
    );

    const removeTLs = useCallback<UseTLGroupingsResult["removeTLs"]>(
        (groupingId, tlIds) => {
            if (tlIds.length === 0) return;
            const removeSet = new Set(tlIds);
            update((prev) =>
                prev.map((g) =>
                    g.id === groupingId
                        ? { ...g, tlIds: g.tlIds.filter((id) => !removeSet.has(id)), updatedAt: Date.now() }
                        : g,
                ),
            );
        },
        [update],
    );

    const toggleTL = useCallback<UseTLGroupingsResult["toggleTL"]>(
        (groupingId, tlId) => {
            update((prev) =>
                prev.map((g) => {
                    if (g.id !== groupingId) return g;
                    const idx = g.tlIds.indexOf(tlId);
                    const tlIds =
                        idx >= 0
                            ? [...g.tlIds.slice(0, idx), ...g.tlIds.slice(idx + 1)]
                            : [...g.tlIds, tlId];
                    return { ...g, tlIds, updatedAt: Date.now() };
                }),
            );
        },
        [update],
    );

    const importJSON = useCallback<UseTLGroupingsResult["importJSON"]>(
        (json, mode) => {
            const parsed = parseImport(json);
            if (!parsed) {
                return { ok: false, error: "File is not a valid TL groupings export." };
            }
            if (mode === "replace") {
                update(() => parsed);
                return { ok: true, count: parsed.length };
            }
            // Merge: append all imported groupings with new ids so existing ids
            // never collide; everything keeps its name/contents.
            const now = Date.now();
            const reIded = parsed.map((g) => ({
                ...g,
                id: generateId(),
                tlIds: uniqueIds(g.tlIds),
                updatedAt: now,
            }));
            update((prev) => [...prev, ...reIded]);
            return { ok: true, count: reIded.length };
        },
        [update],
    );

    const exportJSON = useCallback<UseTLGroupingsResult["exportJSON"]>(() => {
        return serializeForExport(groupings);
    }, [groupings]);

    return {
        groupings,
        createGrouping,
        renameGrouping,
        deleteGrouping,
        setColor,
        addTLs,
        removeTLs,
        toggleTL,
        importJSON,
        exportJSON,
    };
}
