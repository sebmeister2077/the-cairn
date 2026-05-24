// Phase 1 — informational match-score result attached to each pending row.
export type MatchScore = {
    status: "pending" | "ready" | "failed";
    tile_overlap_pct?: number;
    pixel_similar_pct?: number;
    overlap_count?: number;
    pending_total?: number;
    reason?: string;
}

export type PendingContribution = {
    id: string;
    contributor: string;
    created_at: string;
    timestamp?: string;
    tile_count: number;
    status: string;
    is_mine: boolean;
    preview_image_url?: string;
    preview_signed_url?: string;
    match_score?: MatchScore | null;
    // Phase 2 — region-restricted update bounds (admin-or-owner only) and mode
    // ("overwrite" | "gap_fill"). The mode is always present; bounds are
    // redacted from non-admin/non-owner viewers.
    //
    // Wire format is a 4-tuple `[min_x, max_x, min_z, max_z]` (see
    // backend/app/routes/contribute_r2.py); the object form is accepted
    // for forward-compat. Use ``normalizeContributionRegion`` before
    // reading individual fields.
    update_region?:
    | { min_x: number; max_x: number; min_z: number; max_z: number }
    | [number, number, number, number]
    | null;
    update_region_mode?: "overwrite" | "gap_fill";
    // Async validation lifecycle (see backend/app/tasks/validate_uploads.py).
    // ``'pending'`` = worker hasn't validated the .db yet (tile_count=0).
    // ``'valid'`` = SQLite open + tile-count succeeded; row is approvable.
    // Missing means a legacy synchronously-validated row.
    validation_status?: "pending" | "valid" | null;
    validation_error?: string | null;
    // Async approval lifecycle (see backend/app/tasks/approve_contribution.py).
    // ``'queued'`` = admin pressed Approve, worker hasn't picked it up.
    // ``'running'`` = worker is merging right now.
    // ``'failed'`` = worker hit a non-retryable error or burned all attempts.
    // Missing on success — row will flip to ``status='approved'`` instead.
    approval_status?: "queued" | "running" | "failed" | null;
    approval_attempts?: number;
    approval_error?: string | null;
}

export type WithdrawnEntry = {
    id: string;
    withdrawn_at: string;
    is_mine: boolean;
}

export type ApprovedEntry = {
    id: string;
    contributor: string;
    approved_at: string;
    tiles_new: number;
    tiles_existing: number;
    combined_total: number;
}

// Phase 3 — public history grid entry. Returned for approved (and
// withdrawn-with-preview) contributions whose retention deadline hasn't
// elapsed.
export type HistoryEntry = {
    id: string;
    status: "approved" | "withdrawn" | "reverted" | "orphaned_by_restore";
    contributor: string;
    tile_count: number;
    tiles_new?: number | null;
    tiles_existing?: number | null;
    combined_total?: number | null;
    approved_at?: string | null;
    withdrawn_at?: string | null;
    preview_signed_url?: string | null;
    is_mine?: boolean;
    // Phase 4b — admin-only fields surfaced for revert UI.
    revert_supported?: boolean;
    revert_added_count?: number | null;
    revert_replaced_count?: number | null;
    reverted_at?: string | null;
    can_revert?: boolean;
    // Async revert state — populated once the admin queues a revert.
    // The backend worker drains the queue; the frontend polls /info to
    // observe the transitions queued -> running -> (status='reverted'
    // or revert_status='failed' with revert_error set).
    revert_status?: "queued" | "running" | "failed" | null;
    revert_error?: string | null;
    revert_attempts?: number | null;
}

export type ContributeInfo = {
    map_id: string;
    total_tiles: number;
    pending: PendingContribution[];
    withdrawn: WithdrawnEntry[];
    approved: ApprovedEntry[];
    history?: HistoryEntry[];
    history_total?: number;
    history_window_days?: number | null;
    public_history_enabled?: boolean;
    is_admin?: boolean;
    match_score_enabled?: boolean;
    heavy_compute_enabled?: boolean;
    revert_enabled?: boolean;
    revert_window_days?: number;
    can_contribute?: boolean;
    cooldown_reason?: "pending" | "cooldown" | null;
    pending_contribution_id?: string | null;
    next_allowed_at?: string | null;
    cooldown_days?: number;
    withdraw_limit_per_week?: number;
    withdrawals_used_this_week?: number;
    withdraw_next_allowed_at?: string | null;
    // Phase 2 — region-restricted update gating
    region_overwrite_enabled?: boolean;
    can_use_region_overwrite?: boolean;
    /** Legacy alias for ``region_chunk_area_cap_non_admin`` (kept for one release). */
    region_tile_cap_non_admin?: number;
    /** Max chunk² area a non-admin contributor may overwrite per upload. */
    region_chunk_area_cap_non_admin?: number;
    /** Per-edge chunk count the admin reviewer may expand the bounds by. */
    region_admin_expand_chunks_max?: number;
};