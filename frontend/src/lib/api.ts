import type { QueryFunction } from "@tanstack/react-query";

const configuredApiBase = import.meta.env.VITE_API_BASE?.replace(/\/+$/, "");
export const API_BASE = configuredApiBase || "/api";

// For large uploads, use the same API base. In dev this is usually "/api" via Vite proxy.
const UPLOAD_API_BASE = API_BASE;

function getApiKey(): string {
    return localStorage.getItem("api_key") ?? "";
}

// Tracks the API key value that the backend most recently rejected with a
// 401. While this matches the currently-stored key, requests built via
// ``authHeaders`` short-circuit (see ``handleResponse``) so we don't busy-
// loop hammering the server (e.g. a react-query observer with staleTime: 0
// that refetches as soon as ``queryClient.clear()`` purges its data).
// The empty string is a valid sentinel meaning "no key was stored at the
// time we got rejected"; we MUST NOT collapse that to ``null`` (otherwise
// anonymous 401s would re-fire ``auth-rejected`` forever, since each call
// would look like a fresh rejection). Cleared whenever the stored key
// changes via ``setApiKey``.
let rejectedApiKey: string | null = null;

export function isCurrentApiKeyRejected(): boolean {
    return rejectedApiKey !== null && rejectedApiKey === getApiKey();
}

/**
 * Error thrown by ``handleResponse`` when the backend returns a non-2xx
 * status. Carries the HTTP ``status`` so callers (including the React Query
 * retry logic in App.tsx) can react differently to auth errors vs. transient
 * failures without falling back to brittle string parsing.
 */
export class ApiError extends Error {
    public readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

export function setApiKey(key: string) {
    const previous = localStorage.getItem("api_key");
    if (previous && previous !== key) {
        // The session was bound to the old key — drop it so the new key has
        // to assert its own passkey.
        clearAdminSession();
    }
    localStorage.setItem("api_key", key);
    if (previous !== key) {
        // A different key — give it a fresh chance even if the previous
        // one had been rejected.
        rejectedApiKey = null;
        // Notify in-process listeners (banners, gating UI) that the stored
        // key changed. The browser only fires native ``storage`` events for
        // OTHER tabs, so we dispatch our own for this tab.
        try {
            window.dispatchEvent(new CustomEvent("api-key-change", { detail: { key } }));
        } catch {
            // Older browsers / non-window environments — ignore.
        }
    }
}

export function getStoredApiKey(): string {
    return getApiKey();
}

// --- Admin passkey session (Phase 4c) ---
//
// After a successful WebAuthn assertion the server returns an opaque session
// token. The frontend stores it here and forwards it via X-Admin-Session on
// every admin request. Tokens expire server-side (default 8 h) � the backend
// then returns 401 ``passkey_session_expired`` and the UI re-prompts.

const ADMIN_SESSION_KEY = "admin_session";
const ADMIN_SESSION_EXPIRES_KEY = "admin_session_expires";

export function getAdminSession(): string | null {
    const token = localStorage.getItem(ADMIN_SESSION_KEY);
    if (!token) return null;
    const exp = Number(localStorage.getItem(ADMIN_SESSION_EXPIRES_KEY) ?? "0");
    if (exp && Date.now() > exp) {
        clearAdminSession();
        return null;
    }
    return token;
}

export function setAdminSession(token: string, ttlSeconds: number) {
    localStorage.setItem(ADMIN_SESSION_KEY, token);
    localStorage.setItem(ADMIN_SESSION_EXPIRES_KEY, String(Date.now() + ttlSeconds * 1000));
    window.dispatchEvent(new Event("admin-session-changed"));
}

export function clearAdminSession() {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_SESSION_EXPIRES_KEY);
    window.dispatchEvent(new Event("admin-session-changed"));
}

export function getAdminSessionExpiresAt(): number | null {
    const exp = Number(localStorage.getItem(ADMIN_SESSION_EXPIRES_KEY) ?? "0");
    return exp || null;
}

/**
 * Build the standard auth header bag: always X-API-Key, plus X-Admin-Session
 * when the admin has completed a passkey assertion. Pass ``extra`` to merge
 * in Content-Type or other one-off headers.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "X-API-Key": getApiKey() };
    const session = getAdminSession();
    if (session) h["X-Admin-Session"] = session;
    if (extra) Object.assign(h, extra);
    return h;
}

export function getStoredIsAdmin(): boolean {
    return localStorage.getItem("is_admin") === "true";
}

export function getStoredCanContribute(): boolean {
    return localStorage.getItem("can_contribute") === "true"
        || localStorage.getItem("is_admin") === "true";
}

export function setStoredIsAdmin(value: boolean) {
    localStorage.setItem("is_admin", value ? "true" : "false");
}

export function setStoredCanContribute(value: boolean) {
    localStorage.setItem("can_contribute", value ? "true" : "false");
}

/**
 * Storage key used by the React Query persister (kept in sync with App.tsx).
 * Exposed here so logout / 401 / account-deletion paths can wipe the
 * persisted cache without pulling in a react-query dependency.
 */
export const PERSISTED_QUERY_CACHE_KEY = "vs-waypoints-query-cache";

/** Remove cached admin / contributor flags from localStorage. */
export function clearStoredAuthFlags() {
    localStorage.removeItem("is_admin");
    localStorage.removeItem("can_contribute");
}

/** Wipe the persisted React Query cache from localStorage. */
export function clearPersistedQueryCache() {
    try {
        localStorage.removeItem(PERSISTED_QUERY_CACHE_KEY);
    } catch {
        // ignore — storage may be unavailable
    }
}

export interface AuthStatus {
    is_admin: boolean;
    can_contribute: boolean;
}

export async function checkAuthStatus(): Promise<AuthStatus> {
    try {
        const res = await fetch(`${API_BASE}/me`, {
            headers: authHeaders(),
        });
        if (!res.ok) {
            return { is_admin: false, can_contribute: false };
        }
        const data = await res.json();
        return {
            is_admin: !!data.is_admin,
            can_contribute: !!data.can_contribute,
        };
    } catch {
        return { is_admin: false, can_contribute: false };
    }
}

export async function checkAdminStatus(): Promise<boolean> {
    const status = await checkAuthStatus();
    return status.is_admin;
}

export async function handleResponse(res: Response) {
    if (!res.ok) {
        if (res.status === 401) {
            // The API key is no longer accepted (revoked, expired, or the
            // backing account was deleted/banned). The key itself is left
            // in place — an admin may have only temporarily disabled it —
            // but any admin passkey session is invalidated and listeners
            // are notified so they can purge cached data and redirect.
            // Remember the rejected key so subsequent calls short-circuit
            // instead of busy-looping after ``queryClient.clear()`` causes
            // active observers to refetch (see ``isCurrentApiKeyRejected``).
            // Note: the empty string is a meaningful sentinel for "no key
            // was stored", so we record it as-is rather than coercing to
            // null. That distinction is what stops anonymous-user 401s
            // from re-firing the auth-rejected event in a loop.
            const currentKey = getApiKey();
            const alreadyRejected = rejectedApiKey === currentKey;
            rejectedApiKey = currentKey;
            clearAdminSession();
            if (!alreadyRejected) {
                window.dispatchEvent(new Event("auth-rejected"));
            }
        }
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new ApiError(body.detail ?? `HTTP ${res.status}`, res.status);
    }
    return res;
}

export async function extractWaypoints(formData: FormData) {
    const res = await fetch(`${API_BASE}/extract`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function importWaypoints(formData: FormData) {
    const res = await fetch(`${API_BASE}/import`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    await handleResponse(res);
    const blob = await res.blob();
    return {
        blob,
        existing: Number(res.headers.get("X-Existing-Count") ?? 0),
        imported: Number(res.headers.get("X-Imported-Count") ?? 0),
    };
}

export async function deleteWaypoints(formData: FormData) {
    const res = await fetch(`${API_BASE}/delete`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    await handleResponse(res);

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/octet-stream")) {
        const blob = await res.blob();
        return {
            modified: true,
            blob,
            deleted: Number(res.headers.get("X-Deleted-Count") ?? 0),
            remaining: Number(res.headers.get("X-Remaining-Count") ?? 0),
        };
    }
    return { modified: false, ...(await res.json()) };
}

export async function generateCommands(formData: FormData) {
    const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function getMapStats(formData: FormData) {
    const res = await fetch(`${API_BASE}/map-stats`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function renderMap(
    formData: FormData,
    maxDimension?: number,
    fastPreview?: boolean,
): Promise<Blob> {
    if (maxDimension) {
        formData.set("max_dimension", String(maxDimension));
    }
    if (fastPreview !== undefined) {
        formData.set("fast_preview", fastPreview ? "true" : "false");
    }
    const res = await fetch(`${API_BASE}/map-render`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
    });
    await handleResponse(res);
    return res.blob();
}

export async function getTopsMapStats() {
    const res = await fetch(`${API_BASE}/tops-map-stats`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

/**
 * Fetch an image from a presigned URL (no auth header � the URL is self-contained).
 * Falls back to null on network error or non-200 status so callers can degrade gracefully.
 */
export async function fetchImageFromSignedUrl(signedUrl: string): Promise<Blob | null> {
    try {
        const res = await fetch(signedUrl);
        if (!res.ok) return null;
        return res.blob();
    } catch {
        return null;
    }
}

export async function renderTopsMap(maxDimension?: number): Promise<Blob> {
    const params = new URLSearchParams();
    if (maxDimension) params.set("max_dimension", String(maxDimension));
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/tops-map-render${qs ? `?${qs}` : ""}`, {
        headers: authHeaders(),
    });
    await handleResponse(res);
    return res.blob();
}

export interface TopsMapResolutionMeta {
    level: number;
    max_dimension: number;
    status: "complete" | "generating" | "not_generated" | "failed";
    generated_at?: string | null;
    size_bytes?: number | null;
    progress?: number;
}

export async function getTopsMapLevel(level: number): Promise<TopsMapLevelChunks> {
    const res = await fetch(`${API_BASE}/tops-map-level/${level}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export interface TopsMapChunkRef {
    cx: number;
    cy: number;
    url: string;
}

export interface TopsMapLevelChunks {
    level: number;
    max_dimension: number;
    status: "complete" | "generating" | "not_generated" | "failed";
    progress: number;
    generated_at?: string | null;
    size_bytes?: number | null;
    chunk_grid: number;
    image_w: number;
    image_h: number;
    chunk_w: number;
    chunk_h: number;
    scale: number;
    width_blocks: number;
    height_blocks: number;
    start_x: number;
    start_z: number;
    chunks: TopsMapChunkRef[];
    url_expires_in: number;
    /** Absolute UTC ISO timestamp of the soonest URL expiry in `chunks`. */
    expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Admin � TOPS map multi-resolution generation
// ---------------------------------------------------------------------------

export interface MapGenerationLevelStatus {
    status: "complete" | "generating" | "not_generated" | "failed";
    generated_at: string | null;
    started_at: string | null;
    progress: number;
    current_chunk: string | null;
    total_chunks: number;
    completed_chunks: number;
    size_bytes: number | null;
    error: string | null;
}

export interface MapGenerationStatus {
    levels: Record<string, MapGenerationLevelStatus>;
    configured_levels: { level: number; max_dimension: number }[];
    is_running: boolean;
    /** True if a stop has been requested but the worker hasn't observed it yet. */
    stop_requested?: boolean;
}

export async function getMapGenerationStatus(): Promise<MapGenerationStatus> {
    const res = await fetch(`${API_BASE}/admin/tops-map/generation-status`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function requestMapGeneration(
    levels?: number[],
    affectedBounds?: { min_x: number; max_x: number; min_z: number; max_z: number },
): Promise<MapGenerationStatus> {
    const res = await fetch(`${API_BASE}/admin/tops-map/generate`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            levels: levels ?? null,
            affected_bounds: affectedBounds ?? null,
        }),
    });
    return (await handleResponse(res)).json();
}

export async function deleteMapLevel(level: number): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/tops-map/level/${level}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    if (res.status === 204) return;
    await handleResponse(res);
}

export async function markMapLevelStatus(
    level: number,
    status: "complete" | "failed",
    error?: string,
): Promise<MapGenerationStatus> {
    const res = await fetch(`${API_BASE}/admin/tops-map/level/${level}/mark`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status, error: error ?? null }),
    });
    return (await handleResponse(res)).json();
}

/** Cooperative stop: signal the generation worker to abort after its
 *  current chunk and discard any queued requests. */
export async function stopMapGeneration(): Promise<MapGenerationStatus> {
    const res = await fetch(`${API_BASE}/admin/tops-map/stop`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}
export async function getContributeInfo(signal?: AbortSignal) {
    const res = await fetch(`${API_BASE}/contribute/info`, {
        headers: authHeaders(),
        signal,
    });
    return (await handleResponse(res)).json();
}

interface ContributeUploadSession {
    contribution_id: string;
    upload_method: string;
    upload_url: string;
    upload_headers?: Record<string, string>;
}

// Phase 2 � region-restricted contribution. World-block coordinates,
// inclusive on both ends. Send as part of the /contribute/complete body.
export interface ContributionRegion {
    min_x: number;
    max_x: number;
    min_z: number;
    max_z: number;
}

function uploadFileToUrl(
    session: ContributeUploadSession,
    file: File,
    onProgress?: (percent: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(session.upload_method || "PUT", session.upload_url);

        for (const [headerName, headerValue] of Object.entries(session.upload_headers ?? {})) {
            xhr.setRequestHeader(headerName, headerValue);
        }

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.min(Math.round((e.loaded / e.total) * 95), 95));
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
                return;
            }

            let detail = `Upload failed (${xhr.status})`;
            try {
                const body = JSON.parse(xhr.responseText) as { detail?: string };
                if (body.detail) detail = body.detail;
            } catch {
                if (xhr.responseText) {
                    detail = xhr.responseText;
                }
            }
            reject(new Error(detail));
        };

        xhr.onerror = () => reject(new Error("Network error during direct upload"));
        xhr.send(file);
    });
}

export async function contributeMap(
    file: File,
    contributor: string,
    onProgress?: (percent: number) => void,
    region?: ContributionRegion | null,
): Promise<Record<string, unknown>> {
    // R2/S3 single-PUT is hard-capped at 5 GiB. Switch to multipart well
    // before that to leave headroom and to get parallelisable parts.
    const MULTIPART_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
    if (file.size > MULTIPART_THRESHOLD_BYTES) {
        return contributeMapMultipart(file, contributor, onProgress, region);
    }

    const initRes = await fetch(`${UPLOAD_API_BASE}/contribute/upload-url`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            contributor,
            file_name: file.name,
            size_bytes: file.size,
        }),
    });
    const uploadSession = (await handleResponse(initRes)).json() as Promise<ContributeUploadSession>;
    const session = await uploadSession;

    await uploadFileToUrl(session, file, onProgress);
    onProgress?.(98);

    const completeBody: Record<string, unknown> = {
        contribution_id: session.contribution_id,
        contributor,
    };
    if (region) {
        completeBody.update_region_min_x = region.min_x;
        completeBody.update_region_max_x = region.max_x;
        completeBody.update_region_min_z = region.min_z;
        completeBody.update_region_max_z = region.max_z;
    }

    const completeRes = await fetch(`${UPLOAD_API_BASE}/contribute/complete`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(completeBody),
    });

    onProgress?.(100);
    return (await handleResponse(completeRes)).json();
}

// ---------- Multipart upload path (files >4 GiB) ----------

interface MultipartInitResponse {
    contribution_id: string;
    upload_id: string;
    key: string;
    part_size: number;
    expected_parts: number;
    max_parts: number;
    expires_in_seconds: number;
}

interface MultipartSignPartResponse {
    url: string;
    method: string;
    part_number: number;
    expires_in_seconds: number;
}

/** PUT one slice to its presigned URL and return the part's ETag.
 *
 *  Browser CORS on the R2 bucket MUST include ``ExposeHeaders: ["ETag"]``;
 *  otherwise ``getResponseHeader("ETag")`` returns null and the upload
 *  cannot be completed. */
function uploadOnePart(
    url: string,
    method: string,
    blob: Blob,
    onChunkProgress?: (loaded: number, total: number) => void,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method || "PUT", url);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onChunkProgress) {
                onChunkProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader("ETag");
                if (!etag) {
                    reject(new Error(
                        "Upload succeeded but server did not return an ETag header. " +
                        "The R2 bucket CORS policy must expose the ETag header.",
                    ));
                    return;
                }
                resolve(etag);
                return;
            }
            let detail = `Part upload failed (${xhr.status})`;
            try {
                const body = JSON.parse(xhr.responseText) as { detail?: string };
                if (body.detail) detail = body.detail;
            } catch {
                if (xhr.responseText) detail = xhr.responseText;
            }
            reject(new Error(detail));
        };
        xhr.onerror = () => reject(new Error("Network error during part upload"));
        xhr.send(blob);
    });
}

async function contributeMapMultipart(
    file: File,
    contributor: string,
    onProgress?: (percent: number) => void,
    region?: ContributionRegion | null,
): Promise<Record<string, unknown>> {
    const initRes = await fetch(`${UPLOAD_API_BASE}/contribute/multipart/init`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            contributor,
            file_name: file.name,
            size_bytes: file.size,
        }),
    });
    const session = (await (await handleResponse(initRes)).json()) as MultipartInitResponse;

    const partSize = session.part_size;
    const totalParts = session.expected_parts;
    const partLoaded = new Array<number>(totalParts).fill(0);
    const reportProgress = () => {
        if (!onProgress) return;
        let sum = 0;
        for (const n of partLoaded) sum += n;
        // Cap part-upload progress at 95% so the /complete round-trip
        // accounts for the final 3% (matching the single-PUT path).
        onProgress(Math.min(Math.round((sum / file.size) * 95), 95));
    };

    const parts: { PartNumber: number; ETag: string }[] = [];

    try {
        // Sequential upload keeps memory + bandwidth predictable. (Could
        // be parallelised later with a small worker pool.)
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            const start = (partNumber - 1) * partSize;
            const end = Math.min(start + partSize, file.size);
            const blob = file.slice(start, end);

            const signRes = await fetch(
                `${UPLOAD_API_BASE}/contribute/multipart/sign-part`,
                {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({
                        contribution_id: session.contribution_id,
                        part_number: partNumber,
                    }),
                },
            );
            const signed = (await (await handleResponse(signRes)).json()) as MultipartSignPartResponse;

            const partIndex = partNumber - 1;
            const etag = await uploadOnePart(
                signed.url,
                signed.method,
                blob,
                (loaded) => {
                    partLoaded[partIndex] = loaded;
                    reportProgress();
                },
            );
            // Ensure the part is recorded as fully uploaded even if the
            // final ``progress`` event lagged.
            partLoaded[partIndex] = blob.size;
            reportProgress();

            parts.push({ PartNumber: partNumber, ETag: etag });
        }
    } catch (err) {
        // Best-effort cleanup. Server is also swept by
        // ``abort_stale_multipart_uploads`` periodically.
        try {
            await fetch(`${UPLOAD_API_BASE}/contribute/multipart/abort`, {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ contribution_id: session.contribution_id }),
            });
        } catch {
            /* ignore */
        }
        throw err;
    }

    onProgress?.(96);

    const completeBody: Record<string, unknown> = {
        contribution_id: session.contribution_id,
        contributor,
        parts,
    };
    if (region) {
        completeBody.update_region_min_x = region.min_x;
        completeBody.update_region_max_x = region.max_x;
        completeBody.update_region_min_z = region.min_z;
        completeBody.update_region_max_z = region.max_z;
    }

    const completeRes = await fetch(
        `${UPLOAD_API_BASE}/contribute/multipart/complete`,
        {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(completeBody),
        },
    );

    onProgress?.(100);
    return (await handleResponse(completeRes)).json();
}

export async function getContributePreview(contributionId: string): Promise<Blob> {
    const res = await fetch(`${API_BASE}/contribute/preview/${contributionId}`, {
        headers: authHeaders(),
    });
    await handleResponse(res);
    return res.blob();
}

export async function approveContribution(contributionId: string) {
    const res = await fetch(`${API_BASE}/contribute/${contributionId}/approve`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function rejectContribution(contributionId: string) {
    const res = await fetch(`${API_BASE}/contribute/${contributionId}/reject`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function withdrawContribution(contributionId: string) {
    const res = await fetch(`${API_BASE}/contribute/${contributionId}/withdraw`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

// Phase 4b � admin-only surgical undo of a single approved contribution.
// Backend rejects with HTTP 423 if the global map lock is held by another
// mutation, 409 if the contribution is no longer eligible (out of window,
// not approved, no undo data captured), 410 if the undo blob has been
// pruned, or 404 if the per_contribution_revert flag is off.
export async function revertContribution(contributionId: string) {
    const res = await fetch(
        `${API_BASE}/admin/contributions/${contributionId}/revert`,
        {
            method: "POST",
            headers: authHeaders(),
        },
    );
    return (await handleResponse(res)).json();
}

// Phase 1 � admin re-enqueue of match-score computation when a row is stuck.
export async function recomputeMatchScore(contributionId: string) {
    const res = await fetch(
        `${API_BASE}/contribute/${contributionId}/recompute-match-score`,
        {
            method: "POST",
            headers: authHeaders(),
        },
    );
    return (await handleResponse(res)).json();
}

// Phase 2 � preview the in-region tile counts for a candidate region against
// an already-uploaded pending file. Returns 404 when the
// ``region_overwrite`` feature flag is off.
export interface RegionPreviewResult {
    tiles_in_region: number;
    tiles_total: number;
    region_tile_area: number;
    region_tile_cap: number | null;
}

export async function previewRegionContribution(
    contributionId: string,
    region: ContributionRegion,
): Promise<RegionPreviewResult> {
    const res = await fetch(`${API_BASE}/contribute/region-preview`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            contribution_id: contributionId,
            update_region_min_x: region.min_x,
            update_region_max_x: region.max_x,
            update_region_min_z: region.min_z,
            update_region_max_z: region.max_z,
        }),
    });
    return (await handleResponse(res)).json();
}

// Phase 2 � fetch the cached side-by-side region preview PNG. ``side`` is
// "before" (combined map cropped to region) or "after" (combined merged
// with upload, with green/orange tints on the changed tiles).
export async function getRegionPreviewImage(
    contributionId: string,
    side: "before" | "after",
): Promise<Blob> {
    const res = await fetch(
        `${API_BASE}/contribute/preview-region/${contributionId}?side=${side}`,
        { headers: authHeaders() },
    );
    await handleResponse(res);
    return res.blob();
}

// ---------------------------------------------------------------------------
// Admin � dynamic API key management
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
    key: string;
    name: string;
    permissions: "read" | "contribute";
    consume_once: boolean;
    bound_identity: string | null;
    /** display_name from the linked user account (if one exists). */
    display_name?: string | null;
    /** in_game_name from the linked user account (if one exists). */
    in_game_name?: string | null;
    revoked: boolean;
    usage_count: number;
    created_at: string;
    last_used_at: string | null;
}

export type ApiKeySort =
    | "created_at"
    | "last_used_at"
    | "usage_count"
    | "bound_identity"
    | "name";

export type ApiKeySortOrder = "asc" | "desc";

/** Filter token for the ``bound_identity`` query param.
 *
 * Designed so new filter values can be added without changing the request
 * shape: pass any other string to filter by exact identity match.
 */
export type ApiKeyBoundIdentityFilter = "any" | "bound" | "unbound" | (string & {});

export async function listApiKeys(params: {
    status?: "all" | "active" | "revoked";
    q?: string;
    offset?: number;
    limit?: number;
    sort?: ApiKeySort;
    order?: ApiKeySortOrder;
    bound_identity?: ApiKeyBoundIdentityFilter;
} = {}): Promise<{ items: ApiKeyRecord[]; total: number; next_offset: number | null }> {
    const search = new URLSearchParams();
    search.set("status", params.status ?? "all");
    if (params.q) search.set("q", params.q);
    search.set("offset", String(params.offset ?? 0));
    search.set("limit", String(params.limit ?? 50));
    if (params.sort) search.set("sort", params.sort);
    if (params.order) search.set("order", params.order);
    if (params.bound_identity && params.bound_identity !== "any") {
        search.set("bound_identity", params.bound_identity);
    }
    const res = await fetch(`${API_BASE}/admin/keys?${search.toString()}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function createApiKey(data: {
    name: string;
    permissions: "read" | "contribute";
    consume_once: boolean;
}): Promise<ApiKeyRecord> {
    const res = await fetch(`${API_BASE}/admin/keys`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(data),
    });
    return (await handleResponse(res)).json();
}

export async function revokeApiKey(key: string): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/keys/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    if (res.status === 204) return;
    await handleResponse(res);
}

// ---------------------------------------------------------------------------
// Admin � invite links
// ---------------------------------------------------------------------------

export interface InviteLinkRecord {
    token: string;
    name: string;
    permissions: "read" | "contribute";
    max_uses: number | null;
    use_count: number;
    expires_at: string | null;
    created_at: string;
    revoked: boolean;
    is_default_public: boolean;
}

export async function listInviteLinks(params: {
    status?: "all" | "active" | "revoked";
    q?: string;
    offset?: number;
    limit?: number;
} = {}): Promise<{ items: InviteLinkRecord[]; total: number; next_offset: number | null }> {
    const search = new URLSearchParams();
    search.set("status", params.status ?? "all");
    if (params.q) search.set("q", params.q);
    search.set("offset", String(params.offset ?? 0));
    search.set("limit", String(params.limit ?? 50));
    const res = await fetch(`${API_BASE}/admin/invite-links?${search.toString()}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function createInviteLink(data: {
    name: string;
    permissions: "read" | "contribute";
    max_uses: number | null;
    expires_in_hours: number | null;
}): Promise<InviteLinkRecord> {
    const res = await fetch(`${API_BASE}/admin/invite-links`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(data),
    });
    return (await handleResponse(res)).json();
}

export async function revokeInviteLink(token: string): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/invite-links/${encodeURIComponent(token)}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    if (res.status === 204) return;
    await handleResponse(res);
}

export async function setInviteLinkDefaultPublic(
    token: string,
    isDefaultPublic: boolean,
): Promise<InviteLinkRecord> {
    const res = await fetch(`${API_BASE}/admin/invite-links/${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ is_default_public: isDefaultPublic }),
    });
    return (await handleResponse(res)).json();
}

export interface InviteLinkKeyRecord extends ApiKeyRecord {
    display_name: string | null;
    in_game_name: string | null;
    user_joined_at: string | null;
    user_deleted_at: string | null;
}

export async function listInviteLinkKeys(token: string): Promise<InviteLinkKeyRecord[]> {
    const res = await fetch(
        `${API_BASE}/admin/invite-links/${encodeURIComponent(token)}/keys`,
        { headers: authHeaders() },
    );
    return (await handleResponse(res)).json();
}

export async function claimInvite(token: string): Promise<{ key: string; permissions: string; invite_name: string }> {
    const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(token)}/claim`, {
        method: "POST",
    });
    return (await handleResponse(res)).json();
}

export interface DefaultInviteRecord {
    token: string;
    name: string;
    permissions: "read" | "contribute";
}

/** Returns the active default-public invite, or null if none configured. */
export async function getDefaultPublicInvite(): Promise<DefaultInviteRecord | null> {
    const res = await fetch(`${API_BASE}/invite/default`);
    if (res.status === 404) return null;
    return (await handleResponse(res)).json();
}

// ---------------------------------------------------------------------------
// Account system
// ---------------------------------------------------------------------------

export interface AccountUser {
    display_name: string;
    in_game_name: string | null;
    is_hireable: boolean;
    is_leaderboard_visible: boolean;
    show_contributions: boolean;
    genesis_for_ip: boolean;
    joined_at: string;
    terms_version: string;
    terms_accepted_at: string;
    deleted_at: string | null;
    name_regen_count: number;
    last_name_change_at: string | null;
    last_used_at: string | null;
    is_banned: boolean;
    flag_count: number;
    api_key?: string;
}

export interface AccountMeResponse {
    user: AccountUser | null;
    is_admin: boolean;
    terms_version_current: string;
    terms_accepted_current: boolean;
}

export async function registerAccount(): Promise<{ user: AccountUser; created: boolean }> {
    const res = await fetch(`${API_BASE}/account/register`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ accept_terms: true }),
    });
    return (await handleResponse(res)).json();
}

export async function getMyAccount(): Promise<AccountMeResponse> {
    if (isCurrentApiKeyRejected()) {
        // The backend already rejected this key in this session. Throw
        // synchronously instead of issuing another network request \u2014 the
        // observer would otherwise be re-triggered every ~300ms by the
        // ``auth-rejected`` cache purge in App.tsx.
        throw new Error("auth_rejected");
    }
    const res = await fetch(`${API_BASE}/account/me`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

/**
 * Variant of {@link getMyAccount} that swallows the 403 "No account
 * associated with this API key" response and returns a synthetic
 * unregistered shape (`user: null`). Other errors still throw.
 *
 * Used by both the AccountPage and the header indicator so the
 * react-query cache (keyed on ["account-me"]) is consistent.
 */
export async function getMyAccountSafe(): Promise<AccountMeResponse> {
    try {
        return await getMyAccount();
    } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.toLowerCase().includes("no account")) {
            return {
                user: null,
                is_admin: false,
                terms_version_current: "",
                terms_accepted_current: false,
            };
        }
        throw e;
    }
}

export async function updateMyAccount(payload: {
    in_game_name?: string;
    clear_in_game_name?: boolean;
    is_hireable?: boolean;
    is_leaderboard_visible?: boolean;
    show_contributions?: boolean;
}): Promise<{ user: AccountUser }> {
    const res = await fetch(`${API_BASE}/account/me`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
    });
    return (await handleResponse(res)).json();
}

export async function regenerateMyDisplayName(): Promise<{ user: AccountUser }> {
    const res = await fetch(`${API_BASE}/account/regenerate-name`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function exportMyData(): Promise<unknown> {
    const res = await fetch(`${API_BASE}/account/export`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function deleteMyAccount(): Promise<{ ok: boolean; tombstone: string }> {
    const res = await fetch(`${API_BASE}/account/me`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: users ---

export interface AdminUserStats {
    total: number;
    active: number;
    hireable: number;
    deleted: number;
    banned: number;
    active_last_7_days: number;
    flagged: number;
}

export interface AdminUserListItem extends AccountUser {
    api_key: string;
}

export async function adminListUsers(params: {
    q?: string;
    sort?: string;
    cursor?: number | null;
    limit?: number;
    flagged?: boolean;
    banned?: boolean;
    genesis?: boolean;
    include_deleted?: boolean;
}): Promise<{ users: AdminUserListItem[]; next_cursor: number | null }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.sort) qs.set("sort", params.sort);
    if (params.cursor != null) qs.set("cursor", String(params.cursor));
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.flagged) qs.set("flagged", "true");
    if (params.banned) qs.set("banned", "true");
    if (params.genesis) qs.set("genesis", "true");
    if (params.include_deleted === false) qs.set("include_deleted", "false");
    const res = await fetch(`${API_BASE}/admin/users?${qs.toString()}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetUserStats(refresh: boolean = false): Promise<{ stats: AdminUserStats; cached: boolean }> {
    const qs = refresh ? "?refresh=true" : "";
    const res = await fetch(`${API_BASE}/admin/users/stats${qs}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetUser(apiKey: string): Promise<{ user: AdminUserListItem }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetSiblings(apiKey: string): Promise<{ siblings: AdminUserListItem[] }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/siblings`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminRegenerateName(apiKey: string): Promise<{ user: AdminUserListItem }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/regenerate-name`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminRekeyUser(apiKey: string): Promise<{ new_api_key: string; user: AdminUserListItem }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/rekey`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminReactivateUser(apiKey: string): Promise<{ user: AdminUserListItem }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/reactivate`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminSoftDeleteUser(apiKey: string): Promise<{ ok: boolean; tombstone: string }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminBanPreview(apiKey: string): Promise<{ ip_hash: string | null; affected_users: AdminUserListItem[] }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/ban-preview`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export type BanReasonCode =
    | "spam" | "impersonation" | "abuse" | "harassment"
    | "duplicate_account" | "provocative_name" | "other";

export async function adminBanUser(apiKey: string, payload: {
    reason_code: BanReasonCode;
    reason: string;
    admin_notes?: string;
    duration_days?: number;
}): Promise<{ ban: IpBan; revoked_keys: number; deleted_users: number }> {
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/ban`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: IP bans ---

export interface IpBan {
    ip_hash: string;
    reason_code: string;
    reason: string;
    admin_notes: string | null;
    banned_by: string;
    banned_at: string;
    expires_at: string;
}

export async function adminListIpBans(cursor: number | null = null): Promise<{ bans: IpBan[]; next_cursor: number | null }> {
    const qs = new URLSearchParams();
    if (cursor != null) qs.set("cursor", String(cursor));
    const res = await fetch(`${API_BASE}/admin/ip-bans?${qs.toString()}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminUnbanIp(ipHash: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${API_BASE}/admin/ip-bans/${encodeURIComponent(ipHash)}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: flags ---

export interface UserFlag {
    id: number;
    flagged_user: string;
    related_user: string | null;
    reason: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
    flagged_display_name: string | null;
    related_display_name: string | null;
}

export async function adminListFlags(params: {
    unresolved_only?: boolean;
    reason?: string;
    flagged_user?: string;
    cursor?: number | null;
}): Promise<{ flags: UserFlag[]; next_cursor: number | null }> {
    const qs = new URLSearchParams();
    if (params.unresolved_only !== false) qs.set("unresolved_only", "true");
    else qs.set("unresolved_only", "false");
    if (params.reason) qs.set("reason", params.reason);
    if (params.flagged_user) qs.set("flagged_user", params.flagged_user);
    if (params.cursor != null) qs.set("cursor", String(params.cursor));
    const res = await fetch(`${API_BASE}/admin/flags?${qs.toString()}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminResolveFlag(flagId: number, resolution: "valid" | "abuse" | "dismissed"): Promise<{ flag: UserFlag }> {
    const res = await fetch(`${API_BASE}/admin/flags/${flagId}/resolve`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ resolution }),
    });
    return (await handleResponse(res)).json();
}
// --- Admin: feature flags & map lock (Phase 0) ---

export interface FeatureFlag {
    key: string;
    enabled: boolean;
    updated_at: string;
    updated_by_key: string | null;
}

export async function adminListFeatureFlags(): Promise<{ flags: FeatureFlag[] }> {
    const res = await fetch(`${API_BASE}/admin/feature-flags`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminSetFeatureFlag(
    key: string,
    enabled: boolean,
): Promise<{ flag: FeatureFlag }> {
    const res = await fetch(`${API_BASE}/admin/feature-flags/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled }),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: zstd compression settings (gated by compress_artefacts flag) ---

export type CompressionThreadsPreset = "single" | "half" | "all";

export interface CompressionSettings {
    level: number;
    threads_preset: CompressionThreadsPreset;
    resolved_threads: number;
    cpu_count: number;
}

export interface CompressionEstimate {
    db_size_bytes: number;
    threads: number;
    input_bytes: number;
    output_bytes: number;
    elapsed_seconds: number;
    estimated_compress_seconds: number;
    estimated_compressed_bytes: number;
    estimated_decompress_seconds: number;
    ratio: number;
}

export interface CompressionStatus {
    kind: string | null;
    started_at: number | null;
    finished_at: number | null;
    input_bytes: number;
    output_bytes: number;
    elapsed_seconds: number;
    error: string | null;
}

export interface CompressionMigrationStatus {
    phase: "idle" | "running" | "done" | "error";
    total: number;
    processed: number;
    skipped: number;
    failed: number;
    started_at: number | null;
    finished_at: number | null;
    error: string | null;
}

export interface SystemCpuInfo {
    cpu_count: number;
    presets: { single: number; half: number; all: number };
}

export async function adminGetCompressionSettings(): Promise<CompressionSettings> {
    const res = await fetch(`${API_BASE}/admin/settings/compression`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminSetCompressionSettings(
    level: number,
    threads_preset: CompressionThreadsPreset,
): Promise<CompressionSettings> {
    const res = await fetch(`${API_BASE}/admin/settings/compression`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ level, threads_preset }),
    });
    return (await handleResponse(res)).json();
}

export async function adminEstimateCompression(
    level: number,
    threads_preset: CompressionThreadsPreset,
    input_bytes?: number,
): Promise<CompressionEstimate> {
    const res = await fetch(`${API_BASE}/admin/settings/compression/estimate`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ level, threads_preset, input_bytes }),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetCompressionStatus(): Promise<CompressionStatus> {
    const res = await fetch(`${API_BASE}/admin/settings/compression/status`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetCompressionMigrationStatus(): Promise<CompressionMigrationStatus> {
    const res = await fetch(
        `${API_BASE}/admin/settings/compression/migration-status`,
        { headers: authHeaders() },
    );
    return (await handleResponse(res)).json();
}

export async function adminGetSystemCpuInfo(): Promise<SystemCpuInfo> {
    const res = await fetch(`${API_BASE}/admin/system/cpu-info`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export interface MapLockInfo {
    holder_action: string;
    acquired_at: string;
    expires_at: string;
}

export async function adminGetMapLock(): Promise<{ lock: MapLockInfo | null }> {
    const res = await fetch(`${API_BASE}/admin/map-lock`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminForceReleaseMapLock(): Promise<{ released: boolean }> {
    const res = await fetch(`${API_BASE}/admin/map-lock/force-release`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: heavy-compute bulk-run (gated by heavy_compute_enabled flag) ---

export interface HeavyComputeStatus {
    running: boolean;
    started_at: number | null;
    finished_at: number | null;
    started_by: string | null;
    validations_revived: number;
    validation_worker_started: boolean;
    match_score_worker_started: boolean;
    match_score_skipped_reason: string | null;
    previews_total: number;
    previews_rendered: number;
    previews_already_cached: number;
    previews_failed: number;
    previews_failures: string[];
    current_preview_id: string | null;
    error: string | null;
}

export async function adminRunHeavyComputeNow(): Promise<{
    started: boolean;
    reason?: string;
    status: HeavyComputeStatus;
}> {
    const res = await fetch(`${API_BASE}/admin/heavy-compute/run-now`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminGetHeavyComputeStatus(): Promise<HeavyComputeStatus> {
    const res = await fetch(`${API_BASE}/admin/heavy-compute/status`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

// --- Maintenance notices ---

export interface MaintenanceNotice {
    component: string;
    active: boolean;
    message: string;
    started_at: string;
    eta_at: string | null;
    updated_at: string;
    updated_by_key: string | null;
}

export interface KnownMaintenanceComponent {
    id: string;
    label: string;
}

export async function listActiveMaintenanceNotices(): Promise<{
    notices: MaintenanceNotice[];
}> {
    // Public endpoint — does NOT require auth so we can show the chip even
    // to anonymous viewers. Don't use authHeaders() here so a missing /
    // invalid X-API-Key never trips the global 401 handler.
    const res = await fetch(`${API_BASE}/maintenance/notices`);
    if (!res.ok) return { notices: [] };
    return res.json();
}

export async function adminListMaintenanceNotices(): Promise<{
    notices: MaintenanceNotice[];
    known_components: KnownMaintenanceComponent[];
}> {
    const res = await fetch(`${API_BASE}/admin/maintenance/notices`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminUpsertMaintenanceNotice(
    component: string,
    body: {
        active: boolean;
        message?: string;
        eta_at?: string | null;
        duration_hours?: number | null;
    },
): Promise<{ notice: MaintenanceNotice }> {
    const res = await fetch(
        `${API_BASE}/admin/maintenance/notices/${encodeURIComponent(component)}`,
        {
            method: "PUT",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
        },
    );
    return (await handleResponse(res)).json();
}

export async function adminClearMaintenanceNotice(
    component: string,
): Promise<{ notice: MaintenanceNotice | null }> {
    const res = await fetch(
        `${API_BASE}/admin/maintenance/notices/${encodeURIComponent(component)}`,
        {
            method: "DELETE",
            headers: authHeaders(),
        },
    );
    return (await handleResponse(res)).json();
}

// --- Admin: per-key granular permissions (Phase 0c) ---

export type KeyPermission = "region_overwrite";

export async function adminGetKeyPermissions(
    apiKey: string,
): Promise<{ key: string; extra_permissions: Record<string, boolean> }> {
    const res = await fetch(
        `${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/permissions`,
        { headers: authHeaders() },
    );
    return (await handleResponse(res)).json();
}

export async function adminSetKeyPermission(
    apiKey: string,
    permission: KeyPermission,
    enabled: boolean,
): Promise<{ key: string; extra_permissions: Record<string, boolean> }> {
    const res = await fetch(
        `${API_BASE}/admin/users/${encodeURIComponent(apiKey)}/permissions`,
        {
            method: "PATCH",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ permission, enabled }),
        },
    );
    return (await handleResponse(res)).json();
}

// --- Admin: TOTP enrolment (Phase 4a) ---

export interface TotpStatus {
    enrolled: boolean;
    configured: boolean;
}

export async function adminTotpStatus(): Promise<TotpStatus> {
    const res = await fetch(`${API_BASE}/admin/totp/status`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminTotpEnroll(): Promise<{ secret: string; otpauth_uri: string }> {
    const res = await fetch(`${API_BASE}/admin/totp/enroll`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminTotpConfirm(code: string): Promise<{ enrolled: boolean }> {
    const res = await fetch(`${API_BASE}/admin/totp/confirm`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ code }),
    });
    return (await handleResponse(res)).json();
}

// --- Admin: weekly backups (Phase 4a) ---

export interface BackupRecord {
    key: string;
    kind: "scheduled" | "manual";
    size: number;
    last_modified: string | null;
}

export interface BackupListResponse {
    backups: BackupRecord[];
    retention: { scheduled: number; manual: number };
}

export async function adminListBackups(): Promise<BackupListResponse> {
    const res = await fetch(`${API_BASE}/admin/backups`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminCreateBackup(): Promise<{ created: string }> {
    const res = await fetch(`${API_BASE}/admin/backups/create`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminCleanupBackups(): Promise<{ deleted: number }> {
    const res = await fetch(`${API_BASE}/admin/backups/cleanup-now`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminRestoreBackup(
    key: string,
    totpCode: string,
): Promise<{ restored_from: string; orphaned_contributions: number; backup_taken_at: string | null }> {
    const res = await fetch(`${API_BASE}/admin/backups/restore`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ key, confirm: true, totp_code: totpCode }),
    });
    return (await handleResponse(res)).json();
}

export interface LastRestoreInfo {
    admin_key_suffix: string;
    backup_key: string;
    restored_at: string;
    orphaned_contributions: number;
}

export async function adminLastBackupRestore(): Promise<{ last_restore: LastRestoreInfo | null }> {
    const res = await fetch(`${API_BASE}/admin/backups/last-restore`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}


// --- Admin: shareable backup download links ---

export type BackupDownloadLinkStatus = "active" | "expired" | "revoked";

export interface BackupDownloadLink {
    id: number;
    token: string;
    backup_key: string;
    label: string | null;
    created_by_suffix: string;
    created_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
    revoked_by_suffix: string | null;
    redeem_count: number;
    success_count: number;
    last_redeem_at: string | null;
    status: BackupDownloadLinkStatus;
    url: string;
    /** Only present on the create response. */
    size?: number;
}

export interface BackupDownloadRedemption {
    id: number;
    redeemed_at: string | null;
    ip_hash_short: string | null;
    user_agent: string | null;
    success: boolean;
    failure_reason: string | null;
}

export async function adminCreateBackupDownloadLink(args: {
    key: string;
    ttl_seconds: number;
    label?: string;
}): Promise<BackupDownloadLink> {
    const res = await fetch(`${API_BASE}/admin/backups/download-links`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            key: args.key,
            ttl_seconds: args.ttl_seconds,
            label: args.label?.trim() || undefined,
        }),
    });
    return (await handleResponse(res)).json();
}

export async function adminListBackupDownloadLinks(): Promise<{ links: BackupDownloadLink[] }> {
    const res = await fetch(`${API_BASE}/admin/backups/download-links`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminListBackupDownloadRedemptions(
    linkId: number,
): Promise<{ redemptions: BackupDownloadRedemption[] }> {
    const res = await fetch(
        `${API_BASE}/admin/backups/download-links/${linkId}/redemptions`,
        { headers: authHeaders() },
    );
    return (await handleResponse(res)).json();
}

export async function adminRevokeBackupDownloadLink(
    linkId: number,
): Promise<{ revoked: boolean; link: BackupDownloadLink }> {
    const res = await fetch(
        `${API_BASE}/admin/backups/download-links/${linkId}`,
        { method: "DELETE", headers: authHeaders() },
    );
    return (await handleResponse(res)).json();
}


// ---------------------------------------------------------------------------
// Admin � WebAuthn / passkey 2FA (Phase 4c)
// ---------------------------------------------------------------------------

export interface WebAuthnStatus {
    configured: boolean;
    enrolled: boolean;
    enforced: boolean;
    session_ttl_seconds: number;
}

export interface WebAuthnCredential {
    id: number;
    name: string;
    created_at: string | null;
    last_used_at: string | null;
}

export async function adminWebauthnStatus(): Promise<WebAuthnStatus> {
    const res = await fetch(`${API_BASE}/admin/webauthn/status`, { headers: authHeaders() });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnListCredentials(): Promise<{ credentials: WebAuthnCredential[] }> {
    const res = await fetch(`${API_BASE}/admin/webauthn/credentials`, { headers: authHeaders() });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnDeleteCredential(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/webauthn/credentials/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    await handleResponse(res);
}

export async function adminWebauthnRegisterBegin(name: string): Promise<{ options: unknown }> {
    const res = await fetch(`${API_BASE}/admin/webauthn/register/begin`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
    });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnRegisterComplete(name: string, credential: unknown): Promise<{ registered: boolean; id: number }> {
    const res = await fetch(`${API_BASE}/admin/webauthn/register/complete`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name, credential }),
    });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnAuthBegin(): Promise<{ options: unknown }> {
    const res = await fetch(`${API_BASE}/admin/webauthn/auth/begin`, {
        method: "POST",
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnAuthComplete(credential: unknown): Promise<{ session_token: string; expires_in: number }> {
    const res = await fetch(`${API_BASE}/admin/webauthn/auth/complete`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ credential }),
    });
    return (await handleResponse(res)).json();
}

export async function adminWebauthnLogout(): Promise<void> {
    try {
        await fetch(`${API_BASE}/admin/webauthn/logout`, {
            method: "POST",
            headers: authHeaders(),
        });
    } catch {
        // best effort � clear locally regardless
    }
    clearAdminSession();
}

// --- Admin: Resources overlay (worldgen reconstruction) ---

export interface ResourcesActiveBundle {
    seed: string;
    vs_version: string;
    generated_at: string | null;
    world_bounds: { min_x: number; max_x: number; min_z: number; max_z: number } | null;
    size_bytes: number;
    deposit_type_count: number;
    layer_count: number;
}

export interface ResourcesStatus {
    active_bundle: ResourcesActiveBundle | null;
    canonical: { seed: string; vs_version: string };
}

export async function getResourcesStatus(): Promise<ResourcesStatus> {
    const res = await fetch(`${API_BASE}/admin/resources/status`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

/**
 * Stream a resources-overlay bundle (.zip) to the backend, reporting
 * percentage progress as bytes are uploaded. The backend spools the file
 * to local disk and returns ``{job_id}`` immediately (HTTP 202); the
 * actual unpack into R2 then runs in a background worker. Poll
 * ``getResourcesUploadJob`` for live progress.
 */
export function uploadResourcesBundle(
    file: File,
    onProgress?: (percent: number) => void,
): Promise<{ job_id: string; size_bytes: number }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${UPLOAD_API_BASE}/admin/resources/upload`);
        for (const [headerName, headerValue] of Object.entries(authHeaders())) {
            xhr.setRequestHeader(headerName, headerValue);
        }
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.min(Math.round((e.loaded / e.total) * 100), 100));
            }
        };
        xhr.onload = () => {
            if (xhr.status === 401) {
                clearAdminSession();
                window.dispatchEvent(new Event("auth-rejected"));
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                onProgress?.(100);
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    reject(new Error(`Invalid JSON in response: ${e}`));
                }
                return;
            }
            let detail = `Upload failed (${xhr.status})`;
            try {
                const body = JSON.parse(xhr.responseText);
                if (body && typeof body.detail === "string") detail = body.detail;
            } catch {
                // ignore
            }
            reject(new ApiError(detail, xhr.status));
        };
        xhr.onerror = () => reject(new Error("Network error during bundle upload"));
        xhr.send(file);
    });
}

export type ResourcesUploadJobStatus = "unpacking" | "swapping" | "complete" | "failed";

export interface ResourcesUploadJob {
    id: string;
    seed: string;
    vs_version: string;
    status: ResourcesUploadJobStatus;
    phase: string | null;
    total_files: number;
    processed_files: number;
    total_bytes: number;
    uploaded_bytes: number;
    error: string | null;
    created_at: string | null;
    updated_at: string | null;
    completed_at: string | null;
}

export async function getResourcesUploadJob(jobId: string): Promise<ResourcesUploadJob> {
    const res = await fetch(`${API_BASE}/admin/resources/jobs/${encodeURIComponent(jobId)}`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export async function getActiveResourcesUploadJob(): Promise<ResourcesUploadJob | null> {
    const res = await fetch(`${API_BASE}/admin/resources/jobs/active`, {
        headers: authHeaders(),
    });
    const body = await (await handleResponse(res)).json();
    return body.job ?? null;
}

export interface ResourcesManifest {
    schema_version: number;
    seed: string;
    vs_version: string;
    generated_at: string | null;
    world_bounds: { min_x: number; max_x: number; min_z: number; max_z: number } | null;
    layers: Array<{
        id: string;
        kind: "heatmap" | string;
        legend?: { values: Array<{ id: string; label: string; color: string }> };
        scale?: { min: number; max: number; unit: string };
        levels: number[];
    }>;
    deposit_types: Array<{ id: string; label: string; color: string }>;
    presigned_tiles: Record<string, Record<string, Array<{ cx: number; cy: number; url: string }>>>;
    presigned_tiles_expires_at: string;
}

export async function getResourcesManifest(): Promise<ResourcesManifest> {
    const res = await fetch(`${API_BASE}/admin/resources/manifest`, {
        headers: authHeaders(),
    });
    return (await handleResponse(res)).json();
}

export interface ResourceDeposit {
    type: string;
    x: number;
    y: number;
    z: number;
    qty: number | null;
    richness: number | null;
}

export async function getResourcesDeposits(opts: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    types?: string[];
    cursor?: number | null;
    signal?: AbortSignal;
}): Promise<{ deposits: ResourceDeposit[]; next_cursor: number | null; page_limit: number }> {
    const params = new URLSearchParams({
        min_x: String(opts.minX),
        max_x: String(opts.maxX),
        min_z: String(opts.minZ),
        max_z: String(opts.maxZ),
    });
    if (opts.types && opts.types.length > 0) params.set("types", opts.types.join(","));
    if (opts.cursor != null) params.set("cursor", String(opts.cursor));
    const res = await fetch(`${API_BASE}/admin/resources/deposits?${params.toString()}`, {
        headers: authHeaders(),
        signal: opts.signal,
    });
    return (await handleResponse(res)).json();
}
