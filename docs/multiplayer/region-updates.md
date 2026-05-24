# Region-restricted contributions (operator guide)

This page is the practical reference for **region overwrite contributions** — when, why, and how they happen, plus the admin review surface and the configuration knobs.

The protocol-level mechanics (positions, columns, payload shape) live in [contribute.md](contribute.md#region-restricted-updates-phase-2). This document focuses on the **operator-facing pieces**: feature flag, contributor UX, admin review, settings, archive behaviour, audit log entries, and revert interaction.

## Quick mental model

Two contribution modes coexist:

| Mode | What it does | Default | Gating |
| --- | --- | --- | --- |
| `gap_fill` | Adds chunks where the combined map has none. Never overwrites. | ✅ | Always available. |
| `overwrite` | Replaces every chunk inside a rectangle with the upload's version. | — | Per-key permission + feature flag + cap. |

The contributor explicitly opts in to `overwrite` via the two-tab control on the upload card ([ContributionRegionField](../../frontend/src/components/contributions/ContributionRegionField.tsx)). Switching back to `gap_fill` clears any drawn region.

## Feature flag and per-key permission

Region overwrite is dangerous (it deletes other contributors' work inside the box), so it is gated by **three independent checks**:

1. The `region_overwrite` **feature flag** must be on. When off, every Phase-2 endpoint returns **404** and the picker is hidden in the UI.
2. The caller must be **admin** *or* hold the per-key `region_overwrite` permission (toggled from the admin Users panel). Non-eligible callers get **403**.
3. Non-admin uploads cannot exceed the configured **chunk-area cap** (`region_overwrite_settings.max_chunks_area_non_admin`, default 900 chunks² = 30×30 chunks). Admins are uncapped.

These checks are mirrored on the frontend via `region_overwrite_enabled`, `can_use_region_overwrite`, `region_chunk_area_cap_non_admin`, and `region_admin_expand_chunks_max` on `/contribute/info`.

## Settings (admin)

Two numeric knobs live under `app_settings.region_overwrite_settings` (JSON) and are edited from the **Admin → Feature flags** page via the [RegionOverwriteSettingsPanel](../../frontend/src/components/admin/RegionOverwriteSettingsPanel.tsx) that appears inline beneath the `region_overwrite` flag row when the flag is enabled:

- `max_chunks_area_non_admin` — Maximum rectangle area (in chunks²) a non-admin contributor may overwrite per upload. Default **900** (= 30×30 chunks = 960×960 blocks).
- `admin_expand_chunks_max` — Per-edge chunk count the admin reviewer may expand the bounds by during review (i.e. the admin can grow each edge by up to N chunks, or shrink without limit). Default **10**.

Both are validated server-side, persisted with a 30 s in-process cache, and every change is recorded in the audit log as `settings.region_overwrite.set`.

## Contributor UX

[ContributeUploadCard](../../frontend/src/components/contributions/ContributeUploadCard.tsx) renders the upload form. When `can_use_region_overwrite` is true the field is replaced with the [ContributionRegionField](../../frontend/src/components/contributions/ContributionRegionField.tsx) wrapper, which:

- Shows a two-tab segmented control: *Add new areas* (default `gap_fill`) and *Update existing region* (`overwrite`).
- Forces the picker to be visible when in `overwrite` mode.
- Snaps the picker's pixel-rectangle output to whole 32-block chunks via `snapRegionToChunks` — the backend would round anyway, but doing it client-side makes the cap maths predictable for the user.
- Disables the Upload button until either mode is `gap_fill` or the selection is non-empty and within cap (`isRegionSelectionValid`).
- Shows the live chunk count and per-call cap.

## Admin review

Pending contributions with `update_region_mode === "overwrite"` get an admin-only [AdminRegionReviewPanel](../../frontend/src/components/admin/AdminRegionReviewPanel.tsx) under the standard preview. The panel:

- Surfaces the original bounds vs the editable bounds (in **chunks**, not blocks).
- Shows per-edge expansion deltas and highlights any edge that exceeds `admin_expand_chunks_max`.
- Provides a 0..20-chunk **preview padding slider** so the reviewer can see context around the rectangle. Padded variants are cached at a distinct R2 key (`pending/<id>.padN.before.png` / `.padN.after.png`) so they don't poison the unpadded cache.
- "Save bounds" calls `PATCH /api/contribute/{id}/region` (see below). On success the cached preview PNGs are invalidated and the panel re-fetches them.
- "Reset to original" reverts the local edits without touching the backend.
- "Open in TOPS viewer" opens `/multiplayer/tops-map?x={centerX}&z={centerZ}&zoom=2` in a new tab so the admin can compare with the live map.

Approve/Reject/Withdraw remain in the shared per-row toolbar — the admin can save bounds first, then approve through the normal control.

## Backend surface (endpoints)

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `GET` | `/api/contribute/info` | Exposes gating + caps + per-row `update_region_mode` (always) and `update_region` (admin/owner only). | API key |
| `GET` | `/api/contribute/preview-region/{id}?side=before\|after&padding_chunks=N` | Cached before/after PNGs, optionally padded for context. `padding_chunks > 0` requires admin. | API key (owner-or-admin) |
| `POST` | `/api/contribute/region-preview` | Counts in-region tiles for a candidate rectangle against an already-uploaded pending file. | API key (owner-or-admin) |
| `PATCH` | `/api/contribute/{id}/region` | Admin-only bounds edit during review. Enforces per-edge expansion cap, requires ≥1 in-region tile, invalidates cached previews, and writes `contribution.region_edit` to the audit log. | Admin |
| `POST` | `/api/contribute/complete` | Upload-completion path that consumes the region bounds and persists them. Empty in-region count rolls back the contribution. | API key |
| `POST` | `/api/contribute/{id}/approve` | Triggers the merge worker, which reads the (possibly admin-edited) region and runs `_merge_into_combined(..., region=...)`. | Admin |

`PATCH /api/contribute/{id}/region` body:

```json
{
  "update_region_min_x": -640,
  "update_region_max_x": -609,
  "update_region_min_z": 320,
  "update_region_max_z": 351
}
```

On per-edge cap violation it returns **400** with `detail.over_edges` listing the offending edges and the cap in blocks.

## Storage layout (R2)

| Key pattern | Purpose | Lifetime |
| --- | --- | --- |
| `pending/<id>.db` | The raw upload while it is awaiting review. | Until approve/withdraw/reject. |
| `pending/<id>.before.png` | Cached "before" preview at zero padding. | Until bounds edit or approval. |
| `pending/<id>.after.png` | Cached "after" preview at zero padding. | Until bounds edit or approval. |
| `pending/<id>.padN.before.png` | Padded "before" variant per padding value. | Until bounds edit or approval. |
| `pending/<id>.padN.after.png` | Padded "after" variant per padding value. | Until bounds edit or approval. |
| `undo/<id>.replaced.db` | The chunks that were **overwritten** during merge, captured for revert. | Until the contribution falls outside the revert window. |
| `archived/<id>.db[.zst]` | The region-pruned approval artifact (see below). | Per the archive retention policy. |

## Region-pruned archive

When a region-overwrite contribution is approved, the archived snapshot is **pruned to the recorded region** rather than the whole file. The worker:

1. Downloads `pending/<id>.db`.
2. Calls `prune_db_to_region(src, dst, region)` ([mapdb.py](../../backend/app/core/mapdb.py)) which `ATTACH`-copies only the in-region `mappiece` rows and the `blockidmapping` table, then `VACUUM`s.
3. Re-uploads the pruned `.db` into the pending key.
4. Records `archived_is_region_pruned = TRUE` + the kept-tile count and src/dst byte sizes on the `contributions` row (added by alembic migration `0019_contributions_archive_pruned`).
5. Writes `contribution.region_pruned_archive` to the audit log with the size deltas.

A 1 GB file overwriting a 30×30-chunk region typically prunes to **< 1 MB** (one tile is < 1 KB; 900 tiles ≈ a few hundred KB after VACUUM). If pruning fails the worker falls back to archiving the full file so an approval is never blocked.

This interacts with the `compress_artefacts` feature flag the same way the legacy gap-fill path does: when the flag is on, the pruned `.db` is then `.zst`-compressed and stored as `archived/<id>.db.zst`.

## Revert interaction

Region overwrite is **revert-compatible**. The merge worker captures every overwritten chunk into `undo/<id>.replaced.db` *before* applying the upload's version, so the standard revert flow (`POST /api/admin/contributions/{id}/revert`) restores the prior state by streaming the undo `.db` back into the combined map. Reverts of region contributions are not special-cased — they just replay the undo blob. See [contribute.md → Revert](contribute.md#revert-phase-4b) for the lifecycle details.

## Audit log

The flow emits three distinct actions so admins can reconstruct what happened:

| Action | Where | Metadata |
| --- | --- | --- |
| `settings.region_overwrite.set` | Admin saves the settings panel. | `{ before, after }` (the two settings dicts). |
| `contribution.region_edit` | Admin saves new bounds via the review panel. | `{ old_region, new_region, expansions_blocks, in_region_upload_tiles }`. |
| `contribution.region_pruned_archive` | Worker finishes the pruned-archive step. | `{ kept_tiles, src_bytes, dst_bytes }`. |

`contribution.approve`, `contribution.reject`, `contribution.withdraw`, and `contribution.revert` continue to be emitted by the shared pipeline.

## Failure modes & rollback

- **Empty in-region tile count at upload time** → 400, pending row dropped, R2 object deleted (so a misclick doesn't burn the contributor's pending slot).
- **Per-edge expansion cap exceeded on admin edit** → 400 with `detail.over_edges`. No state change.
- **Cached preview render failure** → endpoint returns the cached blob if available, otherwise 404. The admin can retry with a different padding to force a re-render.
- **Region prune failure during archive** → worker logs the exception and falls back to archiving the full `.db`. The approval still completes.
- **Revert** of a region contribution → standard `undo/<id>.replaced.db` replay, no special handling needed.
