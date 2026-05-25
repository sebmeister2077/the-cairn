import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { API_BASE, getStoredApiKey } from "@/lib/api";
import { normalizePath } from "@/lib/pageTracking";

/**
 * Best-effort page-view recorder for the admin Usage "Pages" dashboard.
 *
 * Listens to React Router's ``location.pathname`` and POSTs a normalized
 * route template to ``/api/usage/page-view`` whenever the user navigates
 * (debounced 300ms; same-template repeats suppressed). Errors are
 * swallowed — telemetry failures must never affect the user.
 *
 * Uses ``navigator.sendBeacon`` when available so the request survives
 * page unload; otherwise falls back to ``fetch`` with ``keepalive``.
 */
export function PageViewTracker(): null {
  const location = useLocation();
  const lastSent = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const template = normalizePath(location.pathname);
    if (template === lastSent.current) return;

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      sendPageView(template).catch(() => {
        /* swallow — telemetry is best-effort */
      });
      lastSent.current = template;
    }, 300);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [location.pathname]);

  return null;
}

async function sendPageView(path: string): Promise<void> {
  const url = `${API_BASE}/usage/page-view`;
  const body = JSON.stringify({ path });
  const apiKey = getStoredApiKey();

  // Prefer sendBeacon for fire-and-forget reliability across navigations,
  // but only when we don't need to send the X-API-Key header (sendBeacon
  // can't set custom headers).
  if (!apiKey && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    } catch {
      /* fall through to fetch */
    }
  }

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
}
