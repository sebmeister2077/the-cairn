import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { API_BASE, getStoredApiKey } from "@/lib/api";
import { normalizePath } from "@/lib/pageTracking";

/**
 * Best-effort page-view recorder for the admin Usage "Pages" dashboard.
 *
 * Page-views are **buffered in memory** and flushed in batches to
 * ``POST /api/usage/page-views`` — much cheaper than one request per
 * navigation. Flush triggers, whichever comes first:
 *
 *  - the buffer reaches ``MAX_BUFFER`` entries
 *  - ``FLUSH_INTERVAL_MS`` elapses since the first queued entry
 *  - the tab becomes hidden (``visibilitychange``) or is unloaded
 *    (``pagehide``) — at which point we use ``navigator.sendBeacon``
 *    so the batch survives the navigation away
 *
 * Consecutive duplicates of the same normalized template are
 * suppressed (one row per session of staring at a page is enough).
 * All errors are swallowed — telemetry must never affect the user.
 */

const MAX_BUFFER = 20;
const FLUSH_INTERVAL_MS = 15_000;
const NAV_DEBOUNCE_MS = 300;

export function PageViewTracker(): null {
  const location = useLocation();
  const lastQueued = useRef<string | null>(null);
  const buffer = useRef<string[]>([]);
  const flushTimer = useRef<number | null>(null);
  const navTimer = useRef<number | null>(null);

  const flush = (useBeacon: boolean) => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (buffer.current.length === 0) return;
    const batch = buffer.current;
    buffer.current = [];
    sendBatch(batch, useBeacon).catch(() => {
      /* swallow — telemetry is best-effort */
    });
  };

  const enqueue = (path: string) => {
    // Collapse same-path-as-last-queued so a re-render that re-fires
    // the same pathname doesn't double-count.
    if (path === lastQueued.current) return;
    lastQueued.current = path;
    buffer.current.push(path);

    if (buffer.current.length >= MAX_BUFFER) {
      flush(false);
      return;
    }
    if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        flush(false);
      }, FLUSH_INTERVAL_MS);
    }
  };

  // Queue on every route change (debounced to ignore in-flight redirects).
  useEffect(() => {
    const template = normalizePath(location.pathname);
    if (navTimer.current !== null) window.clearTimeout(navTimer.current);
    navTimer.current = window.setTimeout(() => {
      navTimer.current = null;
      enqueue(template);
    }, NAV_DEBOUNCE_MS);
    return () => {
      if (navTimer.current !== null) {
        window.clearTimeout(navTimer.current);
        navTimer.current = null;
      }
    };
  }, [location.pathname]);

  // Lifecycle-tied flush: send on tab hide or unload.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Best-effort final flush on unmount in dev/HMR scenarios.
      flush(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

async function sendBatch(paths: string[], useBeacon: boolean): Promise<void> {
  if (paths.length === 0) return;
  const url = `${API_BASE}/usage/page-views`;
  const body = JSON.stringify({ events: paths.map((p) => ({ path: p })) });
  const apiKey = getStoredApiKey();

  // Beacon is fire-and-forget and survives ``pagehide`` — ideal for the
  // unload path, but it can't carry an ``X-API-Key`` header, so when a
  // signed-in user navigates away their final batch goes anonymously.
  // (Trade-off accepted: this only affects the very last batch.)
  if (useBeacon && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
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
