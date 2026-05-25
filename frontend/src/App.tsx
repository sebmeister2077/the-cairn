import { useEffect } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { AppContent } from "@/components/AppContent";
import { PageViewTracker } from "@/components/PageViewTracker";
import {
  getStoredApiKey,
  clearPersistedQueryCache,
  PERSISTED_QUERY_CACHE_KEY,
  ApiError,
} from "@/lib/api";
import "./index.css";

const TWO_WEEKS = 2 * 7 * 24 * 60 * 60 * 1000;

// HTTP statuses that indicate the request will keep failing the same way no
// matter how many times we retry. Hammering them just spams the server and
// noisy network panels.
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);
const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: TWO_WEEKS,
      retry(failureCount, error) {
        if (error instanceof ApiError && NON_RETRYABLE_STATUSES.has(error.status)) {
          return false;
        }
        return failureCount < 2;
      },
      retryDelay(failureCount, error) {
        if (error instanceof ApiError) {
          // Retry more aggressively on rate limit errors since they're likely
          // to be transient and we want to recover from them as quickly as possible.
          if (error.status === 429) return 1000;
        }
        // Otherwise, use an exponential backoff strategy with some jitter.
        const baseDelay = Math.min(1000 * 2 ** failureCount, 30000);
        return baseDelay / 2 + Math.random() * (baseDelay / 2);
      },
    },
  },
};
const queryClient = new QueryClient(queryClientConfig);

function ScrollToTop() {
  const location = useLocation();

  useEffect(() => {
    if (location.hash) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  return null;
}

// Persist query cache in localStorage so things like the cached TOPS map
// chunk URLs survive page reloads. We only persist queries that opt in via
// `meta.persist === true` to avoid storing huge / non-serialisable payloads
// (e.g. stitched image Blobs).
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: PERSISTED_QUERY_CACHE_KEY,
});

export default function App() {
  // Listen for the global `auth-rejected` signal that api.ts dispatches when
  // any backend call returns 401. We purge in-memory + persisted query data
  // (so stale results from the no-longer-valid session can't leak across the
  // UI). The API key itself is left alone — an admin may have only
  // temporarily disabled it — but the admin passkey session is cleared
  // inside api.ts before the event fires. AppContent listens for the same
  // event and uses react-router to navigate + show a contextual banner so
  // the user gets visual feedback instead of a silent reload.
  useEffect(() => {
    function onAuthRejected() {
      queryClient.clear();
      clearPersistedQueryCache();
    }
    window.addEventListener("auth-rejected", onAuthRejected);
    return () => window.removeEventListener("auth-rejected", onAuthRejected);
  }, []);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        hydrateOptions: queryClientConfig,
        maxAge: TWO_WEEKS,
        // Bump this string whenever a persisted query payload's shape or
        // semantics changes in a way that would corrupt rendering if a
        // returning user hydrated from an old snapshot. The persister
        // discards (and rewrites) the cache when this value differs from
        // what's stored.
        //
        // 2026-05-19 — v2: per-level TOPS map metadata (`tops-map-level/{n}`)
        // could drift out of sync with the global stats during a server
        // regen race (fixed backend-side). Users with the stale metadata
        // in localStorage would keep projecting waypoint overlays into
        // the wrong world bounds even after the backend was fixed, until
        // their cache happened to refetch. Bumping the buster forces a
        // clean hydration on next load.
        buster: "v2-2026-05-20-tops-map-bounds",
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            if ((query.meta as { persist?: boolean } | undefined)?.persist !== true) return false;
            // Gate persistence on having an API key in storage so that
            // queries fetched while logged in don't outlive logout /
            // account deletion / a 401 wipe.
            if (!getStoredApiKey()) return false;
            // Persist any query that currently has usable data — even if
            // the latest refetch errored. TanStack Query keeps `state.data`
            // populated on refetch failure but flips `state.status` to
            // "error", so gating on status === "success" would drop the
            // entry from the next snapshot and the persister would wipe it
            // from storage. The whole point of persisting overlay /
            // tileSet queries is to survive exactly this kind of transient
            // backend outage, so we deliberately keep the previous good
            // payload around for the next page load to hydrate from.
            // Null/undefined success payloads are still skipped so they
            // can't overwrite a previously-good entry.
            const data = query.state.data as unknown;
            if (data == null) return false;
            // CachedOverlay wraps payloads in `{ etag, expiresAt, data }`,
            // so look one level in for that shape too.
            if (typeof data === "object" && data !== null && "data" in data) {
              const inner = (data as { data?: unknown }).data;
              if (inner == null) return false;
            }
            return true;
          },
        },
      }}
    >
      <BrowserRouter>
        <ScrollToTop />
        <PageViewTracker />
        <AppContent />
      </BrowserRouter>
      {import.meta.env.DEV && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </PersistQueryClientProvider>
  );
}
