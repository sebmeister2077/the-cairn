import { useEffect } from "react";
import { API_BASE, getStoredApiKey } from "@/lib/api";

// Session-scoped guard: only report a given (template, ref) label once per
// page load, no matter how many times the component re-renders or remounts.
const reported = new Set<string>();

async function postLabel(path: string, ref: string, label: string): Promise<void> {
    const apiKey = getStoredApiKey();
    await fetch(`${API_BASE}/usage/page-entity-label`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify({ path, ref, label }),
        keepalive: true,
        credentials: "same-origin",
    });
}

/**
 * Report a human-readable label for the ref-enabled entity a page is showing
 * (e.g. an item name or player in-game name) so the admin "Items & Players"
 * usage tab can display names instead of raw ids.
 *
 * Fires once per ``(template, ref)`` per session, only when both a ref and a
 * non-empty label are available. Counting a view never depends on this — it's
 * a separate, best-effort naming call whose errors are swallowed.
 */
export function useReportEntityLabel(
    template: string,
    ref: string | null | undefined,
    label: string | null | undefined,
): void {
    useEffect(() => {
        if (!ref || !label) return;
        const trimmed = label.trim();
        if (!trimmed) return;
        const key = `${template}\u0000${ref}`;
        if (reported.has(key)) return;
        reported.add(key);
        postLabel(template, ref, trimmed).catch(() => {
            // Allow a retry on a later mount if the report failed.
            reported.delete(key);
        });
    }, [template, ref, label]);
}
