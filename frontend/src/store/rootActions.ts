// Cross-cutting actions handled by every (or many) slices. Kept in its own
// module so slices can import the action creator without pulling in the
// store / persistence layer (avoids circular imports).

import { createAction } from "@reduxjs/toolkit";

/**
 * Replace persisted slice state from a freshly-read envelope. Each slice
 * opts in via `extraReducers` and merges the corresponding entry under
 * its own slice name, ignoring keys it does not own. The payload is a
 * partial root state — slices missing from the payload keep their
 * current value (this is what makes "blacklist a slice" work end-to-end:
 * the writer omits it, so the hydrate never overwrites it).
 */
export const hydrateRoot = createAction<Record<string, unknown>>(
    "@@persist/hydrateRoot",
);
