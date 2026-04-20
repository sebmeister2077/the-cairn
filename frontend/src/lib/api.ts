const configuredApiBase = import.meta.env.VITE_API_BASE?.replace(/\/+$/, "");
const API_BASE = configuredApiBase || "/api";

// For large uploads, use the same API base. In dev this is usually "/api" via Vite proxy.
const UPLOAD_API_BASE = API_BASE;

if (import.meta.env.PROD && !configuredApiBase) {
    console.warn("[api] VITE_API_BASE is not set. Falling back to /api on current origin.");
}

if (import.meta.env.DEV) {
    console.info(`[api] API base resolved to: ${API_BASE}`);
}

function getApiKey(): string {
    return localStorage.getItem("api_key") ?? "";
}

export function setApiKey(key: string) {
    localStorage.setItem("api_key", key);
}

export function getStoredApiKey(): string {
    return getApiKey();
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

export function contributeMap(
    file: File,
    contributor: string,
    onProgress?: (percent: number) => void,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const params = new URLSearchParams();
        if (contributor) params.set("contributor", contributor);
        const qs = params.toString();
        // Send directly to backend when configured; otherwise use API_BASE (dev proxy/local routes)
        xhr.open("POST", `${UPLOAD_API_BASE}/contribute${qs ? `?${qs}` : ""}`);
        xhr.setRequestHeader("X-API-Key", getApiKey());
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => {
            try {
                const body = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(body);
                } else {
                    reject(new Error(body.detail ?? `HTTP ${xhr.status}`));
                }
            } catch {
                reject(new Error(`HTTP ${xhr.status}`));
            }
        };

        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(file);
    });
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
