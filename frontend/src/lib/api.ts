const API_BASE = "/api";

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
