import { useEffect } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { AppContent } from "@/components/AppContent";
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
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            query.state.status === "success" &&
            (query.meta as { persist?: boolean } | undefined)?.persist === true &&
            // Gate persistence on having an API key in storage so that
            // queries fetched while logged in don't outlive logout /
            // account deletion / a 401 wipe.
            !!getStoredApiKey(),
        },
      }}
    >
      <BrowserRouter>
        <ScrollToTop />
        <AppContent />
      </BrowserRouter>
      {import.meta.env.DEV && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </PersistQueryClientProvider>
  );
}
