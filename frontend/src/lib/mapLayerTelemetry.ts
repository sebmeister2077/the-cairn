/**
 * TOPS map "Advanced Layers" usage telemetry.
 *
 * The user's advanced-overlay toggles + settings are already persisted in the
 * `mapView` slice. This module records how those layers are *used* over time
 * and coalesces everything into a single upload roughly **once per 24h**:
 *
 *  - a daily `snapshot` capturing the whole advanced-layer config, and
 *  - per-layer `enable` / `disable` / `adjust` change-events, where the
 *    closing event carries the `duration_ms` the previous state was active
 *    (so the admin dashboard can report per-layer dwell time).
 *
 * Events are buffered in localStorage so they survive across sessions until
 * the daily flush fires. Everything is gated behind storage consent AND a
 * signed-in API key (per the product's privacy posture) — anonymous visitors
 * send nothing.
 */

import { API_BASE, getStoredApiKey } from "@/lib/api";
import { hasAcceptedStorage } from "@/lib/consent";

export type LayerId =
    | "oceans"
    | "broken_tls"
    | "rapids"
    | "trader_claims"
    | "player_claims"
    | "rock_strata"
    | "climate"
    | "temporal_stability"
    | "auction_heatmap";

export const LAYER_IDS: LayerId[] = [
    "oceans",
    "broken_tls",
    "rapids",
    "trader_claims",
    "player_claims",
    "rock_strata",
    "climate",
    "temporal_stability",
    "auction_heatmap",
];

type SettingValue = string | number | boolean;
export type LayerSettings = Record<string, SettingValue>;

export interface LayerState {
    enabled: boolean;
    settings: LayerSettings;
}

export type AdvancedLayersState = Record<LayerId, LayerState>;

type LayerAction = "snapshot" | "enable" | "disable" | "adjust";

interface QueuedEvent {
    layer?: LayerId;
    action: LayerAction;
    settings?: LayerSettings;
    duration_ms?: number;
}

const QUEUE_KEY = "vsw:layer-telemetry-queue";
const FLUSH_TS_KEY = "vsw:layer-telemetry-flush";
// Stores the UTC day (YYYY-MM-DD) of the last snapshot so cadence aligns to
// calendar days instead of a drifting rolling-24h window.
const SNAPSHOT_DAY_KEY = "vsw:layer-telemetry-snapshot-day";
const DAY_MS = 24 * 60 * 60 * 1000;
// Safety valve: if the queue somehow grows past this without a daily flush
// (e.g. a very active user across many short sessions), flush early.
const MAX_QUEUE = 200;
// Reject implausible dwell samples (clock skew, tab left open for days) so a
// single outlier can't dominate the average/percentiles server-side.
const MAX_DWELL_MS = 6 * 60 * 60 * 1000;

/** Clamp a raw dwell duration; returns undefined for non-positive/absurd values. */
function cleanDuration(ms: number): number | undefined {
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return Math.min(ms, MAX_DWELL_MS);
}

// In-memory diff baseline + per-layer dwell start timestamps. Reset per page
// load; the first `syncState` establishes the baseline without emitting.
let lastState: AdvancedLayersState | null = null;
const dwellStart: Partial<Record<LayerId, number>> = {};

function gated(): boolean {
    return hasAcceptedStorage() && Boolean(getStoredApiKey());
}

function readQueue(): QueuedEvent[] {
    try {
        const raw = window.localStorage.getItem(QUEUE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
    } catch {
        return [];
    }
}

function writeQueue(events: QueuedEvent[]): void {
    try {
        window.localStorage.setItem(QUEUE_KEY, JSON.stringify(events));
    } catch {
        /* ignore quota / privacy errors */
    }
}

function readTs(key: string): number {
    try {
        const raw = window.localStorage.getItem(key);
        const n = raw ? Number(raw) : 0;
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

function writeTs(key: string, value: number): void {
    try {
        window.localStorage.setItem(key, String(value));
    } catch {
        /* ignore */
    }
}

function readStr(key: string): string {
    try {
        return window.localStorage.getItem(key) ?? "";
    } catch {
        return "";
    }
}

function writeStr(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* ignore */
    }
}

function utcDayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function settingsEqual(a: LayerSettings, b: LayerSettings): boolean {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (a[k] !== b[k]) return false;
    return true;
}

function enqueue(event: QueuedEvent): void {
    if (!gated()) return;
    const queue = readQueue();
    queue.push(event);
    writeQueue(queue);
    // Opportunistic flush: daily cadence, or early if the buffer is large.
    const due = Date.now() - readTs(FLUSH_TS_KEY) >= DAY_MS;
    if (due || queue.length >= MAX_QUEUE) void flush();
}

/**
 * Diff the current advanced-layer state against the last observed one and
 * queue any change-events (with dwell time on the closing event). Also emits
 * a daily config snapshot when one is due. The first call after a page load
 * only establishes the baseline — it emits nothing.
 */
export function syncLayerState(next: AdvancedLayersState): void {
    if (!gated()) {
        // Keep the baseline current so consent/sign-in mid-session doesn't
        // replay a burst of synthetic events for pre-existing toggles.
        lastState = next;
        return;
    }
    maybeSnapshot(next);

    const prev = lastState;
    if (prev == null) {
        lastState = next;
        for (const id of LAYER_IDS) if (next[id].enabled) dwellStart[id] = Date.now();
        return;
    }

    const now = Date.now();
    for (const id of LAYER_IDS) {
        const p = prev[id];
        const n = next[id];
        if (p.enabled !== n.enabled) {
            if (n.enabled) {
                dwellStart[id] = now;
                enqueue({ layer: id, action: "enable", settings: n.settings });
            } else {
                const started = dwellStart[id];
                const duration = started != null ? cleanDuration(now - started) : undefined;
                dwellStart[id] = undefined;
                enqueue({
                    layer: id,
                    action: "disable",
                    settings: n.settings,
                    ...(duration != null ? { duration_ms: duration } : {}),
                });
            }
        } else if (n.enabled && !settingsEqual(p.settings, n.settings)) {
            enqueue({ layer: id, action: "adjust", settings: n.settings });
        }
    }
    lastState = next;
}

/** Emit a full-config snapshot once per UTC calendar day. */
function maybeSnapshot(state: AdvancedLayersState): void {
    const today = utcDayKey(Date.now());
    if (readStr(SNAPSHOT_DAY_KEY) === today) return;
    writeStr(SNAPSHOT_DAY_KEY, today);
    enqueue({ action: "snapshot", settings: buildSnapshotSettings(state) });
}

/**
 * Flatten the advanced-layer state into a single settings object: each layer
 * id maps to its on/off boolean, and enabled layers additionally contribute
 * their settings under `${layerId}_${settingKey}` keys.
 */
function buildSnapshotSettings(state: AdvancedLayersState): LayerSettings {
    const out: LayerSettings = {};
    for (const id of LAYER_IDS) {
        const s = state[id];
        out[id] = s.enabled;
        if (s.enabled) {
            for (const [k, v] of Object.entries(s.settings)) {
                out[`${id}_${k}`] = v;
            }
        }
    }
    return out;
}

/**
 * Close out any open dwell intervals (e.g. the user navigates away with a
 * layer still on) so their active time is captured. Records a `disable`
 * event carrying the elapsed duration; the layer's on/off preference is
 * unchanged — this only contributes dwell, not an enable/disable toggle in
 * the aggregate (enable_count counts `enable` rows only).
 */
export function closeOpenDwell(): void {
    if (!gated() || lastState == null) return;
    const now = Date.now();
    for (const id of LAYER_IDS) {
        const started = dwellStart[id];
        if (started == null) continue;
        dwellStart[id] = undefined;
        const duration = cleanDuration(now - started);
        if (duration == null) continue;
        enqueue({
            layer: id,
            action: "disable",
            settings: lastState[id].settings,
            duration_ms: duration,
        });
    }
}

/**
 * Re-open dwell timers for currently-enabled layers after the tab becomes
 * visible again. `closeOpenDwell` clears them on hide; without this, all time
 * spent after a tab-away/return would be dropped.
 */
export function resumeOpenDwell(): void {
    if (!gated() || lastState == null) return;
    const now = Date.now();
    for (const id of LAYER_IDS) {
        if (lastState[id].enabled && dwellStart[id] == null) dwellStart[id] = now;
    }
}

/** POST the buffered events, clearing the queue on success. Best-effort. */
export async function flush(useBeacon = false): Promise<void> {
    if (!gated()) return;
    const queue = readQueue();
    if (queue.length === 0) return;
    // Mark the flush time up front so concurrent enqueues don't re-trigger.
    writeTs(FLUSH_TS_KEY, Date.now());
    writeQueue([]);

    const url = `${API_BASE}/usage/map-layer-events`;
    const body = JSON.stringify({ events: queue });
    const apiKey = getStoredApiKey();

    if (useBeacon && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        try {
            const blob = new Blob([body], { type: "application/json" });
            if (navigator.sendBeacon(url, blob)) return;
        } catch {
            /* fall through to fetch */
        }
    }

    try {
        await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "X-API-Key": apiKey } : {}),
            },
            body,
            keepalive: true,
            credentials: "same-origin",
        });
    } catch {
        // Re-buffer on failure so the batch isn't lost; keep the flush-ts so we
        // don't hammer a failing endpoint (retry on the next daily window).
        const current = readQueue();
        writeQueue([...queue, ...current]);
    }
}
