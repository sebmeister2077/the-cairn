// Admin Users page filters — mirrors the storage in [pages/admin/AdminUsersPage.tsx].

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsReadJson, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";

const FILTERS_LS = "admin_users_filters_v1";

export interface AdminUsersFilters {
    q: string;
    sort: string;
    filterFlagged: boolean;
    filterBanned: boolean;
    filterGenesis: boolean;
    includeDeleted: boolean;
}

export const DEFAULT_ADMIN_USERS_FILTERS: AdminUsersFilters = {
    q: "",
    sort: "joined_at",
    filterFlagged: false,
    filterBanned: false,
    filterGenesis: false,
    includeDeleted: true,
};

export function loadInitialAdminUsersFilters(): AdminUsersFilters {
    const stored = lsReadJson<Partial<AdminUsersFilters>>(FILTERS_LS, {});
    return { ...DEFAULT_ADMIN_USERS_FILTERS, ...stored };
}

export const adminUsersFiltersSlice = createSlice({
    name: "adminUsersFilters",
    initialState: loadInitialAdminUsersFilters(),
    reducers: {
        setAdminUsersFilters(_state, action: PayloadAction<AdminUsersFilters>) {
            return action.payload;
        },
        patchAdminUsersFilters(
            state,
            action: PayloadAction<Partial<AdminUsersFilters>>,
        ) {
            Object.assign(state, action.payload);
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.adminUsersFilters as
                | AdminUsersFilters
                | undefined;
            return next ? { ...DEFAULT_ADMIN_USERS_FILTERS, ...next } : state;
        });
    },
});

export const { setAdminUsersFilters, patchAdminUsersFilters } =
    adminUsersFiltersSlice.actions;

export function persistAdminUsersFilters(
    getSlice: () => AdminUsersFilters,
    prev: AdminUsersFilters,
) {
    const s = getSlice();
    if (s !== prev) lsWriteJson(FILTERS_LS, s);
}
