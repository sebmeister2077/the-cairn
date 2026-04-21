const configuredApiBase = import.meta.env.VITE_API_BASE?.replace(/\/+$/, "");
const API_BASE = configuredApiBase || "/api";

// For large uploads, use the same API base. In dev this is usually "/api" via Vite proxy.
const UPLOAD_API_BASE = API_BASE;

function getApiKey(): string {
    return localStorage.getItem("api_key") ?? "";
}

export function setApiKey(key: string) {
    localStorage.setItem("api_key", key);
}

export function getStoredApiKey(): string {
    return getApiKey();
}

export function getStoredIsAdmin(): boolean {
    return localStorage.getItem("is_admin") === "true";
}

export function setStoredIsAdmin(value: boolean) {
    localStorage.setItem("is_admin", value ? "true" : "false");
}

export async function checkAdminStatus(): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE}/me`, {
            headers: { "X-API-Key": getApiKey() },
        });
        if (!res.ok) return false;
        const data = await res.json();
        return !!data.is_admin;
    } catch {
        return false;
    }
}

async function handleResponse(res: Response) {
    if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail ?? `HTTP ${res.status}`);
    }
    return res;
}

export async function extractWaypoints(formData: FormData) {
    const res = await fetch(`${API_BASE}/extract`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function importWaypoints(formData: FormData) {
    const res = await fetch(`${API_BASE}/import`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
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
        headers: { "X-API-Key": getApiKey() },
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
        headers: { "X-API-Key": getApiKey() },
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function getMapStats(formData: FormData) {
    const res = await fetch(`${API_BASE}/map-stats`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
        body: formData,
    });
    return (await handleResponse(res)).json();
}

export async function renderMap(formData: FormData, maxDimension?: number): Promise<Blob> {
    if (maxDimension) {
        formData.set("max_dimension", String(maxDimension));
    }
    const res = await fetch(`${API_BASE}/map-render`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
        body: formData,
    });
    await handleResponse(res);
    return res.blob();
}

export async function getTopsMapStats() {
    const res = await fetch(`${API_BASE}/tops-map-stats`, {
        headers: { "X-API-Key": getApiKey() },
    });
    return (await handleResponse(res)).json();
}

export async function renderTopsMap(maxDimension?: number): Promise<Blob> {
    const params = new URLSearchParams();
    if (maxDimension) params.set("max_dimension", String(maxDimension));
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/tops-map-render${qs ? `?${qs}` : ""}`, {
        headers: { "X-API-Key": getApiKey() },
    });
    await handleResponse(res);
    return res.blob();
}

export async function getContributeInfo(signal?: AbortSignal) {
    const res = await fetch(`${API_BASE}/contribute/info`, {
        headers: { "X-API-Key": getApiKey() },
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
): Promise<Record<string, unknown>> {
    const initRes = await fetch(`${UPLOAD_API_BASE}/contribute/upload-url`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": getApiKey(),
        },
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

    const completeRes = await fetch(`${UPLOAD_API_BASE}/contribute/complete`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": getApiKey(),
        },
        body: JSON.stringify({
            contribution_id: session.contribution_id,
            contributor,
        }),
    });

    onProgress?.(100);
    return (await handleResponse(completeRes)).json();
}

export async function getContributePreview(contributionId: string): Promise<Blob> {
    const res = await fetch(`${API_BASE}/contribute/preview/${contributionId}`, {
        headers: { "X-API-Key": getApiKey() },
    });
    await handleResponse(res);
    return res.blob();
}

export async function approveContribution(contributionId: string) {
    const res = await fetch(`${API_BASE}/contribute/${contributionId}/approve`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
    });
    return (await handleResponse(res)).json();
}

export async function rejectContribution(contributionId: string) {
    const res = await fetch(`${API_BASE}/contribute/${contributionId}/reject`, {
        method: "POST",
        headers: { "X-API-Key": getApiKey() },
    });
    return (await handleResponse(res)).json();
}

// ---------------------------------------------------------------------------
// Admin — dynamic API key management
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
    key: string;
    name: string;
    permissions: "read" | "contribute";
    consume_once: boolean;
    bound_identity: string | null;
    revoked: boolean;
    created_at: string;
    last_used_at: string | null;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
    const res = await fetch(`${API_BASE}/admin/keys`, {
        headers: { "X-API-Key": getApiKey() },
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
        headers: {
            "X-API-Key": getApiKey(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
    });
    return (await handleResponse(res)).json();
}

export async function revokeApiKey(key: string): Promise<void> {
    const res = await fetch(`${API_BASE}/admin/keys/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { "X-API-Key": getApiKey() },
    });
    if (res.status === 204) return;
    await handleResponse(res);
}