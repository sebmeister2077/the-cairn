import { API_BASE, getStoredApiKey } from "@/lib/api";
import { hasAcceptedStorage } from "@/lib/consent";

export type PromoAction =
    | "impression"
    | "details_open"
    | "dismiss"
    | "announcement_click"
    | "map_click";

/**
 * Best-effort promo-banner telemetry. Records a single interaction into the
 * admin Usage dashboard (``usage_events`` / category ``promo``) via
 * ``POST /api/usage/promo-event``.
 *
 * Fire-and-forget: never awaited, all errors swallowed — analytics must never
 * affect the user. Held off until the visitor has accepted storage/consent,
 * mirroring the page-view tracker.
 */
export function recordPromoEvent(
    action: PromoAction,
    promoId: string,
    opts?: { afterDetails?: boolean },
): void {
    if (!hasAcceptedStorage()) return;
    const apiKey = getStoredApiKey();
    const body: Record<string, unknown> = { promo_id: promoId, action };
    if (action === "dismiss" && typeof opts?.afterDetails === "boolean") {
        body.after_details = opts.afterDetails;
    }
    try {
        void fetch(`${API_BASE}/usage/promo-event`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "X-API-Key": apiKey } : {}),
            },
            body: JSON.stringify(body),
            keepalive: true,
            credentials: "same-origin",
        }).catch(() => {
            /* swallow — telemetry is best-effort */
        });
    } catch {
        /* swallow */
    }
}
