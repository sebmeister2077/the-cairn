// Filter state for the admin Usage page.
//
// Persisted in the root envelope so the analyst's chosen category
// filter survives page reloads and cross-tab navigation. An empty
// ``overviewCategories`` array means "no filter — show all categories".

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export type PagesSortKey = "views" | "distinct_actors" | "distinct_ips" | "path";
export type SortOrder = "asc" | "desc";

export type PagesFilters = {
    /** Case-insensitive substring filter applied to ``path``. Empty = no filter. */
    query: string;
    /** Hide rows below this view count. ``0`` = no minimum. */
    minViews: number;
    sortKey: PagesSortKey;
    sortOrder: SortOrder;
    /** Drill-down: ``null`` means "show top-N", a string narrows the chart to that route. */
    selectedPath: string | null;
};

export type MapLayerFilters = {
    timelineMode: "enables" | "snapshots";
    /**
     * Minimum seconds between an account's creation and a later usage event
     * for its map-layer telemetry to count as legitimate. ``0`` = no minimum.
     * Independent from the Accounts section's own gap value.
     */
    minActivityGapSeconds: number;
}

export const DEFAULT_PAGES_FILTERS: PagesFilters = {
    query: "",
    minViews: 0,
    sortKey: "views",
    sortOrder: "desc",
    selectedPath: null,
};

export type AdminUsageFilters = {
    /** Whitelist of category names to keep on the Overview chart. Empty = all. */
    overviewCategories: string[];
    pages: PagesFilters;
    /** Accounts section: when true, exclude API keys that never made a request. */
    accountsExcludeUnused: boolean;
    /**
     * Accounts section: minimum seconds between an account's creation and a
     * later usage event for it to count as legitimate. ``0`` = no minimum.
     */
    accountsMinActivityGapSeconds: number;

    mapLayer: MapLayerFilters;
};

export const DEFAULT_ADMIN_USAGE_FILTERS: AdminUsageFilters = {
    overviewCategories: [],
    pages: DEFAULT_PAGES_FILTERS,
    accountsExcludeUnused: false,
    accountsMinActivityGapSeconds: 0,
    mapLayer: {
        timelineMode: "enables",
        minActivityGapSeconds: 0,
    },
};

export const adminUsageFiltersSlice = createSlice({
    name: "adminUsageFilters",
    initialState: DEFAULT_ADMIN_USAGE_FILTERS,
    reducers: {
        setOverviewCategories(state, action: PayloadAction<string[]>) {
            // De-dupe and sort so the array stays stable across renders.
            state.overviewCategories = Array.from(new Set(action.payload)).sort();
        },
        toggleOverviewCategory(state, action: PayloadAction<string>) {
            const cat = action.payload;
            const idx = state.overviewCategories.indexOf(cat);
            if (idx === -1) {
                state.overviewCategories.push(cat);
                state.overviewCategories.sort();
            } else {
                state.overviewCategories.splice(idx, 1);
            }
        },
        clearOverviewCategories(state) {
            state.overviewCategories = [];
        },
        patchPagesFilters(state, action: PayloadAction<Partial<PagesFilters>>) {
            Object.assign(state.pages, action.payload);
        },
        resetPagesFilters(state) {
            state.pages = DEFAULT_PAGES_FILTERS;
        },
        setPagesSelectedPath(state, action: PayloadAction<string | null>) {
            state.pages.selectedPath = action.payload;
        },
        setMapLayerTimelineMode(state, action: PayloadAction<"enables" | "snapshots">) {
            state.mapLayer.timelineMode = action.payload;
        },
        setMapLayerMinActivityGap(state, action: PayloadAction<number>) {
            state.mapLayer.minActivityGapSeconds = Math.max(0, action.payload);
        },
        setAccountsExcludeUnused(state, action: PayloadAction<boolean>) {
            state.accountsExcludeUnused = action.payload;
        },
        setAccountsMinActivityGap(state, action: PayloadAction<number>) {
            state.accountsMinActivityGapSeconds = Math.max(0, action.payload);
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.adminUsageFilters as
                | AdminUsageFilters
                | undefined;
            if (!next) return state;
            return {
                ...DEFAULT_ADMIN_USAGE_FILTERS,
                ...next,
                pages: { ...DEFAULT_PAGES_FILTERS, ...(next.pages ?? {}) },
                mapLayer: {
                    ...DEFAULT_ADMIN_USAGE_FILTERS.mapLayer,
                    ...(next.mapLayer ?? {}),
                },
            };
        });
    },
});

export const {
    setOverviewCategories,
    toggleOverviewCategory,
    clearOverviewCategories,
    patchPagesFilters,
    resetPagesFilters,
    setPagesSelectedPath,
    setMapLayerTimelineMode,
    setMapLayerMinActivityGap,
    setAccountsExcludeUnused,
    setAccountsMinActivityGap,
} = adminUsageFiltersSlice.actions;
