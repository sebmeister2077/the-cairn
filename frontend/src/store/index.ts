// Redux store for the frontend.
//
// Design notes:
// * Each slice is the runtime source of truth for its domain.
// * Persistence is consolidated into a single localStorage key
//   (`vsw:state:v1`, see [./rootPersistence.ts]) holding a versioned
//   envelope of every persisted slice. The legacy per-slice keys are
//   still read once via each slice's `loadInitial*State()` so existing
//   users keep their values on first load after the upgrade — the next
//   dispatch writes the envelope and from then on it wins.
// * Slices listed in `PERSIST_BLACKLIST` (in `rootPersistence.ts`) are
//   never written to the envelope, so they reset to `initialState` on
//   every page reload.
// * Cross-tab sync is one `storage` event listener that watches the
//   single envelope key and dispatches `hydrateRoot` once per change.
// * TanStack Query stays in charge of server state — RTK Query is not
//   introduced.

import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { authSlice } from "./slices/auth";
import { themeSlice } from "./slices/theme";
import { consentSlice } from "./slices/consent";
import { mapViewSlice } from "./slices/mapView";
import { resourcesOverlaySlice } from "./slices/resourcesOverlay";
import { adminUsersFiltersSlice } from "./slices/adminUsersFilters";
import { tlGroupingsSlice } from "./slices/tlGroupings";
import {
    installRootPersistence,
    loadPersistedRoot,
} from "./rootPersistence";

// `combineReducers` lets us derive `RootState` *before* `store` is built,
// which is essential because `loadPersistedRoot()` (and so the
// `preloadedState` argument below) is typed against `RootState`. Without
// this indirection TS sees a circular `RootState -> store -> preloadedState
// -> RootState` reference.
const rootReducer = combineReducers({
    auth: authSlice.reducer,
    theme: themeSlice.reducer,
    consent: consentSlice.reducer,
    mapView: mapViewSlice.reducer,
    resourcesOverlay: resourcesOverlaySlice.reducer,
    adminUsersFilters: adminUsersFiltersSlice.reducer,
    tlGroupings: tlGroupingsSlice.reducer,
});

export type RootState = ReturnType<typeof rootReducer>;

// Envelope wins over the legacy per-slice reads done inside each slice's
// `initialState` factory. `loadPersistedRoot()` returns `null` when no
// envelope is stored — in that case we keep whatever the slice loaded
// from its old key (the migration path).
const preloadedState = loadPersistedRoot() ?? undefined;

export const store = configureStore({
    reducer: rootReducer,
    preloadedState,
    devTools: import.meta.env.DEV,
});

export type AppDispatch = typeof store.dispatch;

installRootPersistence(store);
