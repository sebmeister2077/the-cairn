# Plan: Shareable Backup Download Links

Add an admin feature in the Contribute page → Admin: Backups & Restore section to
generate **time-limited, multi-use, shareable download links** for any backup in R2.
Recipient does not need an API key. Backend issues a token, persists it in Postgres,
and each redeem is logged + visible to admins. Active links can be listed, copied, and
revoked.

## Design summary

- Recipient flow: `GET /api/public/backup-download/<token>` → 302 to a freshly minted
  presigned R2 GET URL with `Content-Disposition: attachment; filename=<original>`.
- Token TTL is admin-selectable per link (15 min / 1h / 24h / 7d / 30d). Presigned URL inside
  the redirect uses a short fixed TTL (e.g. 5 min) so leaking it from server logs is
  short-lived; the *token* is what the admin shares.
- Multi-use: token works until it expires or is revoked. Each redeem is logged.
- Backups are validated to live under `BACKUP_KEY_PREFIX` and to currently exist in
  `weekly_backup.list_backups()` at *issue* time. If the underlying object is later
  deleted (e.g. retention sweep), redeem returns 410 with a friendly message.

## Phases

### Phase 1 — Schema & data layer (backend)
1. Add two tables to `_ACCOUNT_SCHEMA_SQL` in `backend/app/core/database.py`:
   - `backup_download_links (id BIGSERIAL PK, token TEXT UNIQUE NOT NULL,
     backup_key TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ
     DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
     revoked_by TEXT, label TEXT)`
   - `backup_download_log (id BIGSERIAL PK, link_id BIGINT REFERENCES
     backup_download_links(id) ON DELETE CASCADE, redeemed_at TIMESTAMPTZ
     DEFAULT now(), ip_hash TEXT, user_agent TEXT, success BOOLEAN, failure_reason TEXT)`
   - Indexes: `idx_bdl_token (token)`, `idx_bdl_active (expires_at) WHERE
     revoked_at IS NULL`, `idx_bdlog_link (link_id, redeemed_at DESC)`.
2. Add helpers in `backend/app/core/accounts_db.py` (matches existing style):
   - `create_backup_download_link(token, backup_key, created_by, expires_at, label) -> dict`
   - `get_backup_download_link_by_token(token) -> Optional[dict]`
   - `list_backup_download_links(include_expired: bool = False) -> List[dict]`
     (returns rows joined with redeem count + last redeem timestamp)
   - `list_backup_download_redemptions(link_id) -> List[dict]`
   - `revoke_backup_download_link(link_id, admin_key) -> bool`
   - `record_backup_download_redemption(link_id, ip_hash, user_agent, success, failure_reason)`

### Phase 2 — Admin endpoints (backend)
*Depends on Phase 1.* All in `backend/app/routes/admin_backups.py`,
gated by `require_admin` + `_require_flag("weekly_backups")`.

3. `POST /api/admin/backups/download-links` body
   `{ key: str, ttl_seconds: int, label?: str }`:
   - Validate `key.startswith(BACKUP_KEY_PREFIX)` and present in `list_backups()`.
   - Validate `ttl_seconds` against allowed set `{3600, 86400, 604800, 2592000}`.
   - Generate token via `secrets.token_urlsafe(32)`.
   - Persist row, audit-log `map.create_backup_download_link` with metadata
     `{key, ttl_seconds, label, link_id}`.
   - Return `{ token, url, expires_at, key, size, label }` where `url` is the
     full public URL the admin will share (built from `settings.PUBLIC_BASE_URL`
     or request URL root).
4. `GET /api/admin/backups/download-links` → `{ links: [...] }` with for each
   link: `id, token, backup_key, created_by, created_at, expires_at,
   revoked_at, revoked_by, label, redeem_count, last_redeem_at, status`
   where `status ∈ {active, expired, revoked}`. Includes the shareable URL.
5. `GET /api/admin/backups/download-links/{id}/redemptions` →
   `{ redemptions: [{ redeemed_at, ip_hash, user_agent, success, failure_reason }] }`.
6. `DELETE /api/admin/backups/download-links/{id}` → set `revoked_at`,
   audit-log `map.revoke_backup_download_link`. Returns updated row.

### Phase 3 — Public redeem endpoint (backend)
*Parallel with Phase 2.* New router `backend/app/routes/public_backup_download.py`
mounted in `main.py` *without* admin auth.

7. `GET /api/public/backup-download/{token}`:
   - Look up token via `get_backup_download_link_by_token`. If missing/revoked/expired
     → log failed redemption (if link exists) and return 404 with neutral message
     (don't leak whether the token ever existed for cases that can't be matched).
   - Verify object still exists via `r2_storage.object_exists(backup_key)`. If not,
     log `failure_reason="object_missing"` and return 410.
   - Mint a 5-minute presigned download URL with `ResponseContentDisposition`
     set to `attachment; filename="<basename(backup_key)>"`. Requires extending
     `generate_presigned_download_url` to accept an optional
     `content_disposition` param that gets passed as `ResponseContentDisposition`.
   - Hash client IP using same scheme as `ip_bans.ip_hash` (find existing helper),
     truncate user-agent to e.g. 256 chars.
   - Record successful redemption, then return `RedirectResponse(url, status_code=302)`.
   - Apply existing rate limiter (`rate_limiter.py`) per IP to prevent enumeration
     (e.g. 30/min). Use a dedicated bucket.
8. Apply a `content_type="application/octet-stream"` default for backup downloads
   inside the presigned-URL helper extension (don't change existing PNG callers).

### Phase 4 — Frontend (admin UI)
*Depends on Phase 2.* Edits to `frontend/src/components/AdminBackupsPanel.tsx`
and `frontend/src/lib/api.ts`.

9. Add API client functions in `frontend/src/lib/api.ts`:
   `adminCreateBackupDownloadLink({key, ttl_seconds, label})`,
   `adminListBackupDownloadLinks()`, `adminRevokeBackupDownloadLink(id)`,
   `adminListBackupDownloadRedemptions(id)`, plus types `BackupDownloadLink`,
   `BackupDownloadRedemption`.
10. In `BackupRow`, add a **Generate link** button next to **Restore**. Clicking
    opens a small dialog (reuse `Dialog` like `RestoreDialog` does) with:
    - TTL `<select>` (1h, 24h, 7d, 30d)
    - Optional label `<Input>` ("e.g. Sent to Bob 2026-05-04")
    - On submit → POST, then show the generated URL in a read-only input with a
      "Copy" button, plus "Open" link.
11. New collapsible subsection inside the panel: **Active download links**
    (rendered after the backup list). Lists rows from `adminListBackupDownloadLinks`
    grouped by status (active first, then expired/revoked, paginated client-side).
    Each row shows: backup key (truncated), label, expires-in countdown,
    redeem count, created-by suffix, and actions:
      - **Copy link** (rebuilds URL from token)
      - **View redemptions** (expands an inner list with timestamp, IP-hash short, UA)
      - **Revoke** (`ConfirmDialog`)
    Auto-refresh via `useQuery` polling every 30 s while panel open.
12. Surface "feature gated" parity: if `weekly_backups` is off (404 from list),
    hide the section like the existing backup list does.

### Phase 5 — Verification
13. Backend unit/integration:
    - Generate link → list shows it as active with `redeem_count=0`.
    - Hit public redeem twice → 302 both times, `redeem_count=2`, audit log has
      one `create_backup_download_link` entry; redemption table has two rows.
    - Wait past `expires_at` (or set in past via SQL) → 404, log entry with
      `success=false, failure_reason="expired"`.
    - Revoke → subsequent redeem 404, `failure_reason="revoked"`.
    - Tampered token (one char flipped) → 404, no log row.
    - Object deleted out from under link → 410, log row `failure_reason="object_missing"`.
    - `ttl_seconds` outside allowed set → 400.
    - Non-admin caller on admin endpoints → 401/403.
14. Manual UI checks in Contribute page → Backups panel:
    - Open the panel as admin, generate a 1-hour link, copy, paste in incognito
      window → file downloads with correct name.
    - Revoke link → redeem in incognito returns error page.
    - Verify redemption list in UI updates after each download.
    - Verify list polling does not spam network when panel is collapsed.

## Relevant files

- `backend/app/core/database.py` — append two CREATE TABLEs to `_ACCOUNT_SCHEMA_SQL`.
- `backend/app/core/accounts_db.py` — add CRUD helpers for the new tables next to
  `audit_log()`.
- `backend/app/core/r2_storage.py` — extend `generate_presigned_download_url` and
  `_cached_presigned_download_url` to accept optional `content_disposition`. Cache
  key must include it. Add a constant for the 5-min download-redirect TTL.
- `backend/app/routes/admin_backups.py` — add four new endpoints (create/list/
  redemptions/revoke) reusing `_require_flag("weekly_backups")` and `require_admin`.
  Reuse `r2_storage.BACKUP_KEY_PREFIX` validation pattern from existing restore.
- `backend/app/routes/public_backup_download.py` — *new* router (no admin gate),
  mounted in `backend/app/main.py` next to `app.include_router(admin_backups.router, ...)`.
- `backend/app/main.py` — `app.include_router(public_backup_download.router, prefix="/api")`.
- `backend/app/rate_limiter.py` — reuse existing limiter; add a bucket name.
- `frontend/src/lib/api.ts` — add four client functions + types alongside
  existing `adminListBackups`/`adminCreateBackup` etc.
- `frontend/src/components/AdminBackupsPanel.tsx` — add **Generate link** button
  in `BackupRow`, generation dialog, and the **Active download links** section.

## Decisions

- Multi-use, time-limited (per request); revocable.
- TTL chosen per link from a fixed dropdown: 1h / 24h / 7d / 30d.
- Public endpoint redirects to a presigned R2 URL (no FastAPI proxying of multi-GB
  files). Filename preserved via `ResponseContentDisposition`.
- Tokens stored in Postgres (`backup_download_links`) with a separate
  `backup_download_log` for redemption history; both shown in admin UI.
- Backup-key validity is checked at *issue* time and again at *redeem* time
  (objects can be removed by retention sweep between).
- IP hashing reuses the same scheme as `ip_bans` (privacy parity with rest of
  the app); user agent stored truncated.
- Existing audit log records issuance + revocation; per-redeem details live in
  the dedicated redemption table.

## Out of scope

- TOTP gating on link generation (link recipients are explicitly trusted by the
  admin who shared it — restore stays the only TOTP-gated path).
- Single-use semantics, password-protected links, or per-link IP allow-list
  (can be layered later if needed).
- Bulk "download all backups" UX — per-row only.
- Decompression of `.zst` backups server-side — recipient runs `zstd -d`.

## Further considerations

1. **Public URL base for the shareable link** — backend needs to know the
   externally visible host. Recommendation: read `settings.PUBLIC_BASE_URL`
   (add to `config.py` if missing); fall back to `str(request.base_url)` from
   the create endpoint when unset.
2. **Rate-limit policy on the public endpoint** — recommend 30 redeems/min/IP and
   100/hour/IP (per-token rate limit not required since `expires_at` already
   bounds usage). Adjust if abusive scraping becomes a concern.
3. **Token leak in logs** — make sure FastAPI access logs and any reverse-proxy
   log scrubber strip `/api/public/backup-download/<token>` paths, or move the
   token into a query string + use the existing log filter. Default uvicorn
   logs path → mention in deployment docs.
