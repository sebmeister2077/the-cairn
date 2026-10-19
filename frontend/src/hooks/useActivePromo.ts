import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActivePromo, getStoredApiKey, type PromoEvent } from "@/lib/helpers/api";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

// The active-promo banner is not above-the-fold critical. Hold the (single,
// cheap) request back until the browser is idle — or at most this long — so it
// never competes with the real page data at app startup.
const DEFER_TIMEOUT_MS = 3000;

/** Flip to ``true`` once the browser is idle (or after ``delayMs``). */
function useDeferredReady(delayMs: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idleHandle: number | undefined;
    let timer: number | undefined;
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(() => setReady(true), { timeout: delayMs });
    } else {
      timer = window.setTimeout(() => setReady(true), delayMs);
    }
    return () => {
      if (idleHandle !== undefined && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [delayMs]);
  return ready;
}

/**
 * Fetch the currently-active promotion.
 *
 * - Deferred: the request only fires once the browser is idle, so it stays out
 *   of the startup critical path.
 * - `staleTime` of one day: a returning visitor re-uses the cached promo for a
 *   day before a background refetch.
 * - Persisted (`meta.persist`) with a long `gcTime` so the banner survives
 *   reloads and shows instantly from localStorage until it expires.
 */
export function useActivePromo(): PromoEvent | null {
  const ready = useDeferredReady(DEFER_TIMEOUT_MS);
  const hasApiKey = !!getStoredApiKey();
  const { data } = useQuery({
    queryKey: ["active-promo"],
    queryFn: getActivePromo,
    enabled: ready && hasApiKey,
    staleTime: ONE_DAY_MS,
    gcTime: THIRTY_DAYS_MS,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    meta: { persist: true },
  });
  return data?.promo ?? null;
}
