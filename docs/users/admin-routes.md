# Admin Route Reference

Every endpoint listed here requires `X-API-Key: <ADMIN_API_KEY>` and is gated by `Depends(require_admin)`.

Routes are split across two routers:
- [backend/app/routes/admin_users.py](../../backend/app/routes/admin_users.py) — users, flags, bans
- [backend/app/routes/admin.py](../../backend/app/routes/admin.py) — keys, invite links, map generation

All paths below are prefixed with `/api/admin`.

## Users

| Method | Path | Description |
|---|---|---|
| `GET` | `/users` | List users. Query: `q`, `sort` (`joined_at` \| `last_login_at` \| `is_hireable`), `cursor`, `limit` (1–100), `flagged`, `banned`, `genesis`, `include_deleted` |
| `GET` | `/users/stats` | Aggregate counts. `?refresh=true` bypasses the 60 s cache. See [Stats](./stats.md) |
| `GET` | `/users/{api_key}` | Single user enriched with key metadata, `flag_count`, `is_banned` |
| `GET` | `/users/{api_key}/siblings` | Other accounts on the same `bound_identity`. See [Siblings & alts](./siblings-and-genesis.md) |
| `POST` | `/users/{api_key}/regenerate-name` | Force a new auto-generated `display_name`. Audited as `regenerate_name` |
| `POST` | `/users/{api_key}/rekey` | Mint a new api_key, revoke the old one. **Returns the new key once.** Audited as `rekey` |
| `POST` | `/users/{api_key}/reactivate` | Clear `deleted_at` and un-revoke the user's key. Audited as `reactivate` |
| `DELETE` | `/users/{api_key}` | Soft-delete with admin tombstone. Audited as `soft_delete` |
| `GET` | `/users/{api_key}/ban-preview` | Preview the blast radius of banning this user's IP |
| `POST` | `/users/{api_key}/ban` | Ban the user's IP. Body: `reason_code`, `reason`, `admin_notes?`, `duration_days?`. Cascades: revoke all keys + soft-delete all users on IP. Audited as `ban_ip` |

## IP bans

| Method | Path | Description |
|---|---|---|
| `GET` | `/ip-bans` | List active (non-expired) bans, paginated 50 per page |
| `DELETE` | `/ip-bans/{ip_hash}` | Lift a ban. Does **not** un-revoke keys or reactivate users. Audited as `unban_ip`. See [IP bans > Unban](./ip-bans.md#unban) |

## Flags

| Method | Path | Description |
|---|---|---|
| `GET` | `/flags` | List flags. Query: `unresolved_only` (default `true`), `reason`, `flagged_user`, `cursor`, `limit` (1–200) |
| `POST` | `/flags/{flag_id}/resolve` | Body: `{"resolution": "valid" \| "abuse" \| "dismissed"}`. Audited as `resolve_flag` |

## Keys & invite links

| Method | Path | Description |
|---|---|---|
| `GET` | `/keys` | List dynamic api_keys |
| `POST` | `/keys` | Mint a key. Body: `name`, `permissions` (`read` \| `contribute`), `consume_once` |
| `DELETE` | `/keys/{key_id}` | Revoke an api_key |
| `GET` | `/invite-links` | List invite links |
| `POST` | `/invite-links` | Mint an invite link. Body: `name`, `permissions`, `max_uses?`, `expires_in_hours?` |
| `DELETE` | `/invite-links/{token}` | Revoke an invite link |

## TOPS map

| Method | Path | Description |
|---|---|---|
| `GET` | `/tops-map/generation-status` | Current state of the background map-tile generator |
| `POST` | `/tops-map/generate` | Trigger generation. Body: `levels?`, `affected_bounds?` |
| `DELETE` | `/tops-map/level/{level}` | Wipe an entire resolution level from R2 |

## Auth dependency

`require_admin` is defined in [backend/app/auth.py](../../backend/app/auth.py). It accepts the request only if the resolved key has `is_admin = True`, which today means it matches the `ADMIN_API_KEY` env var. It does **not** check `ip_bans` for the admin key, so admins can still operate even from a banned IP.
