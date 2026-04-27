# Audit Log

Every admin write action against the user/moderation system appends one row to `admin_audit_log`. Reads are not logged.

## Schema

| Field | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `admin_key` | TEXT | The api_key that performed the action (the `ADMIN_API_KEY` itself, in practice) |
| `action` | TEXT | Verb, see table below |
| `target` | TEXT, nullable | api_key, ip_hash, or flag id depending on action |
| `metadata` | JSONB, nullable | Action-specific context |
| `created_at` | TIMESTAMPTZ | |

Index: `idx_audit_created_at` on `created_at DESC`.

## Actions

| `action` | `target` | `metadata` | Logged from |
|---|---|---|---|
| `regenerate_name` | user api_key | `{"new_name": "..."}` | `POST /api/admin/users/{key}/regenerate-name` |
| `rekey` | user api_key (old) | `{"new_key_prefix": "<first 8 chars>"}` | `POST /api/admin/users/{key}/rekey` |
| `reactivate` | user api_key | `null` | `POST /api/admin/users/{key}/reactivate` |
| `soft_delete` | user api_key | `{"tombstone": "..."}` | `DELETE /api/admin/users/{key}` |
| `ban_ip` | ip_hash | `{"reason_code", "reason", "revoked_keys", "deleted_users", "triggered_by_user"}` | `POST /api/admin/users/{key}/ban` |
| `unban_ip` | ip_hash | `null` | `DELETE /api/admin/ip-bans/{ip_hash}` |
| `resolve_flag` | flag_id (as string) | `{"resolution": "valid" \| "abuse" \| "dismissed"}` | `POST /api/admin/flags/{id}/resolve` |
| `contribution.approve` | contribution_id | `{"tiles_new", "tiles_existing", "combined_total"}` | `POST /api/contribute/{id}/approve` |
| `contribution.reject` | contribution_id | `null` | `POST /api/contribute/{id}/reject` |
| `contribution.revert` | contribution_id | `{"deleted", "restored", "combined_total", "affected_bounds"}` | `POST /api/admin/contributions/{id}/revert` |
| `feature_flag.toggle` | flag key | `{"enabled": true\|false}` | `PATCH /api/admin/feature-flags/{key}` |
| `permission.grant` | user api_key | `{"permission": "region_overwrite"}` | `PATCH /api/admin/users/{key}/permissions` (enabled=true) |
| `permission.revoke` | user api_key | `{"permission": "region_overwrite"}` | `PATCH /api/admin/users/{key}/permissions` (enabled=false) |
| `lock.force_release` | `null` | `null` | `POST /api/admin/map-lock/force-release` |
| `map.create_backup` | R2 backup key | `{"kind": "manual"}` | `POST /api/admin/backups/create` |
| `map.restore_backup` | R2 backup key | `{"totp_verified": true, "backup_taken_at", "orphaned_contributions"}` | `POST /api/admin/backups/restore` |
| `totp.enrol` | `null` | `null` | `POST /api/admin/totp/confirm` |

## Querying

There is no admin UI for the audit log yet. Query the DB directly, e.g.:

```sql
-- Last 100 admin actions
SELECT created_at, action, target, metadata
FROM admin_audit_log
ORDER BY created_at DESC
LIMIT 100;

-- Every action ever taken on a specific user
SELECT created_at, action, metadata
FROM admin_audit_log
WHERE target = '<api_key>'
ORDER BY created_at DESC;

-- Bans issued in the last 30 days
SELECT created_at, target, metadata->>'reason_code' AS reason_code, metadata->>'reason' AS reason
FROM admin_audit_log
WHERE action = 'ban_ip'
  AND created_at > now() - interval '30 days'
ORDER BY created_at DESC;
```

## What is *not* logged

- Plain reads (`GET /api/admin/...`).
- Auth attempts and failures (those go to application logs, not this table).
- User-initiated actions (registration, profile edits, self-delete, etc.) are not in this table — they're in the `users` row's own timestamps and in `user_flags`.
- Key creation and revocation via `/api/admin/keys` is not logged here today (only the user-moderation routes call `audit_log()`).
