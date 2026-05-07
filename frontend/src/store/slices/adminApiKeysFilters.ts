import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";
import type { ApiKeySort } from "@/lib/api";



export type AdminApiKeysFilters = {
    q: string;
    sort: ApiKeySort;
    order: "asc" | "desc";
    binding: "any" | "bound" | "unbound";
}

export const DEFAULT_ADMIN_API_KEYS_FILTERS: AdminApiKeysFilters = {
    q: "",
    sort: "created_at",
    order: "desc",
    binding: "any",
};

export const adminApiKeysFiltersSlice = createSlice({
    name: "adminApiKeysFilters",
    initialState: DEFAULT_ADMIN_API_KEYS_FILTERS,
    reducers: {
        setAdminApiKeysFilters(_state, action: PayloadAction<AdminApiKeysFilters>) {
            return action.payload;
        },
        patchAdminApiKeysFilters(
            state,
            action: PayloadAction<Partial<AdminApiKeysFilters>>,
        ) {
            Object.assign(state, action.payload);
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.adminApiKeysFilters as
                | AdminApiKeysFilters
                | undefined;
            return next ? { ...DEFAULT_ADMIN_API_KEYS_FILTERS, ...next } : state;
        });
    },
});

export const { setAdminApiKeysFilters, patchAdminApiKeysFilters } =
    adminApiKeysFiltersSlice.actions;