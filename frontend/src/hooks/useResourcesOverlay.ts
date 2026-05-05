import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    getResourcesManifest,
    getResourcesDeposits,
    type ResourceDeposit,
    type ResourcesManifest,
} from "@/lib/api";

const ACTIVE_LAYERS_KEY = "tops-map-resources-active-layers";
const DEPOSIT_FILTERS_KEY = "tops-map-resources-deposit-filters";
const OPACITY_KEY = "tops-map-resources-opacity";
const SHOW_DEPOSITS_KEY = "tops-map-resources-show-deposits";

const VIEWPORT_DEBOUNCE_MS = 350;
const MAX_DEPOSIT_PAGES = 5; // cap at ~25k deposits per viewport
// Refresh the manifest 2 minutes before its presigned URLs expire.
const URL_REFRESH_BUFFER_MS = 2 * 60 * 1000;

export interface ResourcesOverlayViewport {
    worldMinX: number;
    worldMaxX: number;
    worldMinZ: number;
    worldMaxZ: number;
}

export interface ResourceTile {
    cx: number;
    cy: number;
    url: string;
}

export interface ResourcesOverlayState {
    enabled: boolean;
    loading: boolean;
    error: string | null;
    manifest: ResourcesManifest | null;

    /** All heatmap layer ids known to the active bundle. */
    layerIds: string[];
    /** Per-layer activation. */
    activeLayers: Record<string, boolean>;
    toggleLayer: (id: string) => void;

    /** Single shared opacity slider value (0..1) used for every active heatmap layer. */
    opacity: number;
    setOpacity: (v: number) => void;

    /** Whether deposits are rendered at all. */
    depositsVisible: boolean;
    setDepositsVisible: (v: boolean) => void;

    /** Per-deposit-type visibility (default true for every type in the manifest). */
    depositTypeVisibility: Record<string, boolean>;
    toggleDepositType: (id: string) => void;
    setAllDepositTypes: (visible: boolean) => void;

    /** Reset toggles back to defaults. */
    reset: () => void;

    /** Tiles for a given (layerId, level) — used by the renderer. */
    tilesFor: (layerId: string, level: number) => ResourceTile[];
    /** Highest level present for a layer (we currently use the smallest = best resolution). */
    bestLevelFor: (layerId: string) => number | null;

    /** Deposits in the current viewport, after type filtering. */
    deposits: ResourceDeposit[];
    depositsLoading: boolean;
    /** Notify hook of a new viewport so it can debounce-fetch deposits. */
    reportViewport: (vp: ResourcesOverlayViewport) => void;
}

interface UseResourcesOverlayOptions {
    /**
     * Master gate. When false the hook is inert (no network, no state changes).
     * Used to keep non-admin sessions from issuing requests.
     */
    enabled: boolean;
}

function loadJson<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function saveJson(key: string, value: unknown) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // ignore quota / privacy errors
    }
}

export function useResourcesOverlay(
    opts: UseResourcesOverlayOptions,
): ResourcesOverlayState {
    const { enabled } = opts;

    const [manifest, setManifest] = useState<ResourcesManifest | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [activeLayers, setActiveLayers] = useState<Record<string, boolean>>(() =>
        loadJson<Record<string, boolean>>(ACTIVE_LAYERS_KEY, {}),
    );
    const [opacity, setOpacityState] = useState<number>(() =>
        Math.min(1, Math.max(0, loadJson<number>(OPACITY_KEY, 0.55))),
    );
    const [depositsVisible, setDepositsVisibleState] = useState<boolean>(() =>
        loadJson<boolean>(SHOW_DEPOSITS_KEY, true),
    );
    const [depositTypeVisibility, setDepositTypeVisibility] = useState<
        Record<string, boolean>
    >(() => loadJson<Record<string, boolean>>(DEPOSIT_FILTERS_KEY, {}));

    // Persist user preferences.
    useEffect(() => saveJson(ACTIVE_LAYERS_KEY, activeLayers), [activeLayers]);
    useEffect(() => saveJson(OPACITY_KEY, opacity), [opacity]);
    useEffect(() => saveJson(SHOW_DEPOSITS_KEY, depositsVisible), [depositsVisible]);
    useEffect(
        () => saveJson(DEPOSIT_FILTERS_KEY, depositTypeVisibility),
        [depositTypeVisibility],
    );

    // Manifest fetch + refresh-on-expiry.
    useEffect(() => {
        if (!enabled) {
            setManifest(null);
            setError(null);
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        async function load() {
            setLoading(true);
            setError(null);
            try {
                const m = await getResourcesManifest();
                if (cancelled) return;
                setManifest(m);
                // Schedule refresh ahead of presigned-URL expiry.
                const expiresAtMs = m.presigned_tiles_expires_at
                    ? new Date(m.presigned_tiles_expires_at).getTime()
                    : NaN;
                if (Number.isFinite(expiresAtMs)) {
                    const wait = Math.max(30_000, expiresAtMs - Date.now() - URL_REFRESH_BUFFER_MS);
                    timer = setTimeout(() => {
                        if (!cancelled) void load();
                    }, wait);
                }
            } catch (err) {
                if (cancelled) return;
                // 503 = no bundle uploaded; 404 = feature off; 403 = not admin.
                // Treat all as "no overlay available" — store the message but don't throw.
                const message = err instanceof Error ? err.message : "Failed to load manifest";
                setManifest(null);
                setError(message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void load();
        return () => {
            cancelled = true;
            if (timer != null) clearTimeout(timer);
        };
    }, [enabled]);

    const layerIds = useMemo(() => {
        if (!manifest) return [];
        return manifest.layers.filter((l) => l.kind === "heatmap").map((l) => l.id);
    }, [manifest]);

    // Initialise `activeLayers` and `depositTypeVisibility` once the manifest
    // arrives so first-time users see something useful by default and any
    // stored entries for layers/types that no longer exist are dropped.
    useEffect(() => {
        if (!manifest) return;
        setActiveLayers((prev) => {
            const next: Record<string, boolean> = {};
            let changed = false;
            for (const id of layerIds) {
                if (id in prev) next[id] = prev[id];
                else {
                    // Default: enable nothing so the user opts in explicitly.
                    next[id] = false;
                    changed = true;
                }
            }
            if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
            return changed ? next : prev;
        });
        setDepositTypeVisibility((prev) => {
            const next: Record<string, boolean> = {};
            let changed = false;
            for (const t of manifest.deposit_types) {
                if (t.id in prev) next[t.id] = prev[t.id];
                else {
                    next[t.id] = true;
                    changed = true;
                }
            }
            if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
            return changed ? next : prev;
        });
    }, [manifest, layerIds]);

    const toggleLayer = useCallback((id: string) => {
        setActiveLayers((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const setOpacity = useCallback((v: number) => {
        setOpacityState(Math.min(1, Math.max(0, v)));
    }, []);

    const setDepositsVisible = useCallback((v: boolean) => {
        setDepositsVisibleState(v);
    }, []);

    const toggleDepositType = useCallback((id: string) => {
        setDepositTypeVisibility((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const setAllDepositTypes = useCallback(
        (visible: boolean) => {
            if (!manifest) return;
            const next: Record<string, boolean> = {};
            for (const t of manifest.deposit_types) next[t.id] = visible;
            setDepositTypeVisibility(next);
        },
        [manifest],
    );

    const reset = useCallback(() => {
        if (!manifest) return;
        const layers: Record<string, boolean> = {};
        for (const id of layerIds) layers[id] = false;
        setActiveLayers(layers);
        setOpacityState(0.55);
        const types: Record<string, boolean> = {};
        for (const t of manifest.deposit_types) types[t.id] = true;
        setDepositTypeVisibility(types);
        setDepositsVisibleState(true);
    }, [manifest, layerIds]);

    const tilesFor = useCallback(
        (layerId: string, level: number): ResourceTile[] => {
            if (!manifest) return [];
            const byLevel = manifest.presigned_tiles?.[layerId];
            if (!byLevel) return [];
            const arr = byLevel[String(level)];
            if (!Array.isArray(arr)) return [];
            return arr;
        },
        [manifest],
    );

    const bestLevelFor = useCallback(
        (layerId: string): number | null => {
            if (!manifest) return null;
            const layer = manifest.layers.find((l) => l.id === layerId);
            if (!layer || !layer.levels?.length) return null;
            // Prefer the lowest level number = highest resolution (smaller is "more zoomed in"
            // in TOPS-map terms, but the exporter uses level_0 as the only / canonical level).
            // Use min for parity with what the exporter currently emits.
            return Math.min(...layer.levels);
        },
        [manifest],
    );

    // -------- Deposits (viewport-bound, debounced) --------
    const [deposits, setDeposits] = useState<ResourceDeposit[]>([]);
    const [depositsLoading, setDepositsLoading] = useState(false);
    const viewportRef = useRef<ResourcesOverlayViewport | null>(null);
    const fetchAbortRef = useRef<AbortController | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Type-id list to send as the filter (omit when *all* are visible so the
    // server query is unconstrained and we get a cleaner 'all' code path).
    const visibleTypeIds = useMemo(() => {
        const ids = Object.entries(depositTypeVisibility)
            .filter(([, v]) => v)
            .map(([k]) => k);
        return ids;
    }, [depositTypeVisibility]);

    const allTypesVisible = useMemo(() => {
        if (!manifest) return true;
        return manifest.deposit_types.every((t) => depositTypeVisibility[t.id] !== false);
    }, [manifest, depositTypeVisibility]);

    const fetchDepositsForViewport = useCallback(
        async (vp: ResourcesOverlayViewport) => {
            if (!enabled || !manifest || !depositsVisible) {
                setDeposits([]);
                return;
            }
            if (visibleTypeIds.length === 0) {
                setDeposits([]);
                return;
            }
            fetchAbortRef.current?.abort();
            const abort = new AbortController();
            fetchAbortRef.current = abort;
            setDepositsLoading(true);
            try {
                const collected: ResourceDeposit[] = [];
                let cursor: number | null = null;
                for (let page = 0; page < MAX_DEPOSIT_PAGES; page++) {
                    const res = await getResourcesDeposits({
                        minX: Math.floor(vp.worldMinX),
                        maxX: Math.ceil(vp.worldMaxX),
                        minZ: Math.floor(vp.worldMinZ),
                        maxZ: Math.ceil(vp.worldMaxZ),
                        types: allTypesVisible ? undefined : visibleTypeIds,
                        cursor,
                        signal: abort.signal,
                    });
                    if (abort.signal.aborted) return;
                    collected.push(...res.deposits);
                    if (res.next_cursor == null) break;
                    cursor = res.next_cursor;
                }
                if (abort.signal.aborted) return;
                setDeposits(collected);
            } catch (err) {
                if (abort.signal.aborted) return;
                if (err instanceof Error && err.name === "AbortError") return;
                // Soft-fail: keep previous deposits visible, surface to console.
                // eslint-disable-next-line no-console
                console.warn("Failed to fetch deposits for viewport", err);
            } finally {
                if (!abort.signal.aborted) setDepositsLoading(false);
            }
        },
        [enabled, manifest, depositsVisible, allTypesVisible, visibleTypeIds],
    );

    const reportViewport = useCallback(
        (vp: ResourcesOverlayViewport) => {
            viewportRef.current = vp;
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = setTimeout(() => {
                const current = viewportRef.current;
                if (!current) return;
                void fetchDepositsForViewport(current);
            }, VIEWPORT_DEBOUNCE_MS);
        },
        [fetchDepositsForViewport],
    );

    // Re-fetch whenever filters / visibility / manifest change and we already
    // have a viewport recorded — keeps the overlay in sync with toggle changes
    // without waiting for the next pan.
    useEffect(() => {
        const vp = viewportRef.current;
        if (!vp) return;
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
            void fetchDepositsForViewport(vp);
        }, VIEWPORT_DEBOUNCE_MS);
    }, [fetchDepositsForViewport]);

    useEffect(
        () => () => {
            fetchAbortRef.current?.abort();
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        },
        [],
    );

    return {
        enabled: enabled && manifest != null,
        loading,
        error,
        manifest,
        layerIds,
        activeLayers,
        toggleLayer,
        opacity,
        setOpacity,
        depositsVisible,
        setDepositsVisible,
        depositTypeVisibility,
        toggleDepositType,
        setAllDepositTypes,
        reset,
        tilesFor,
        bestLevelFor,
        deposits,
        depositsLoading,
        reportViewport,
    };
}
