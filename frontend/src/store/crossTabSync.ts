// Cross-tab synchronisation. We listen for native `storage` events (which
// only fire when ANOTHER tab writes localStorage) and dispatch the
// corresponding slice action so this tab's UI re-renders without a full
// reload. Same-tab updates flow through dispatch directly and skip this
// listener entirely.

import type { Store } from "@reduxjs/toolkit";
import { reconcileAuthFromStorage } from "./slices/auth";
import { reconcileThemeFromStorage } from "./slices/theme";
import { reconcileConsentFromStorage } from "./slices/consent";
import { reconcileMapViewFromStorage } from "./slices/mapView";
import { reconcileTLGroupingsFromStorage } from "./slices/tlGroupings";

type Reconciler = (
    key: string,
    newValue: string | null,
) => { type: string; payload?: unknown } | null;

const RECONCILERS: Reconciler[] = [
    reconcileAuthFromStorage,
    (k) => reconcileThemeFromStorage(k),
    (k) => reconcileConsentFromStorage(k),
    (k) => reconcileMapViewFromStorage(k),
    (k) => reconcileTLGroupingsFromStorage(k),
];

export function installCrossTabSync(store: Store) {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
        if (!e.key) return;
        for (const fn of RECONCILERS) {
            const action = fn(e.key, e.newValue);
            if (action) {
                store.dispatch(action);
                // Don't `return` — multiple slices could share a key in
                // the future and we want every reconciler to see it.
            }
        }
    };
    window.addEventListener("storage", handler);
}
