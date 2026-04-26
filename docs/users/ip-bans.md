# IP Bans

The IP ban is the only enforcement action in the system that actually blocks traffic. It targets the **hashed IP**, not the user account, so it removes every account on that connection at once.

## The `ip_bans` table

| Field | Type | Notes |
|---|---|---|
| `ip_hash` | TEXT PK | HMAC-SHA256 of the IP, computed with `IP_HASH_SALT`. Non-reversible |
| `reason_code` | TEXT | Enum: `spam`, `impersonation`, `abuse`, `harassment`, `duplicate_account`, `provocative_name`, `other` |
| `reason` | TEXT | Free text, 1–500 chars |
| `admin_notes` | TEXT, nullable | Internal notes, ≤2000 chars |
| `banned_by` | TEXT | Admin api_key that issued the ban |
| `banned_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ | After this, the ban is ignored (but row persists until cleanup) |

## Issuing a ban

In the admin UI, the **Ban IP** button on a user row opens a dialog that:

1. Shows a **blast-radius preview** (`GET /api/admin/users/{api_key}/ban-preview`) — every account currently bound to the same IP hash.
2. Lets you pick `reason_code`, free-text `reason`, optional `admin_notes`, and `duration_days` (default `IP_BAN_DEFAULT_DAYS`, **365**).

`POST /api/admin/users/{api_key}/ban` then:

1. Looks up the target user's `bound_identity`. If NULL (key never used), error.
2. Upserts an `ip_bans` row with `expires_at = now() + duration`. If the IP is already banned, the existing row is updated.
3. **Revokes every api_key** with `bound_identity = <ip_hash>`.
4. **Soft-deletes every active user** on that IP, with tombstone `[banned-<ts>-<n>]`.
5. Writes an audit entry: action `ban_ip`, target = ip_hash, metadata includes `reason_code`, `reason`, `revoked_keys`, `deleted_users`, `triggered_by_user`.

This is destructive. Always check the preview first.

## Enforcement

In [backend/app/auth.py](../../backend/app/auth.py), `require_active_user` runs:

```python
ip_hash = hash_ip(client_ip)
if accounts_db.is_ip_banned(ip_hash):
    raise HTTPException(403, "Your IP is banned")
```

Where `is_ip_banned` is:

```sql
SELECT 1 FROM ip_bans WHERE ip_hash = ? AND expires_at > now();
```

The check happens **before** account validation and applies to all non-admin keys. The `ADMIN_API_KEY` bypasses it.

## Listing & expiry

`GET /api/admin/ip-bans` lists active (non-expired) bans, paginated 50 per page.

Expired bans are ignored by the enforcement check but the rows stay in the table. `cleanup_expired_ip_bans()` deletes them; this is not currently called on a schedule, run it manually if the table grows.

## Unban

`DELETE /api/admin/ip-bans/{ip_hash}` simply deletes the row. **It does not roll back the cascade**:

- Revoked api_keys stay revoked.
- Soft-deleted users stay soft-deleted.

If you want the affected users back, you have to:

1. Lift the IP ban (`DELETE /api/admin/ip-bans/{ip_hash}`).
2. For each user you want to restore, click **Reactivate** on their row, which clears `deleted_at` and un-revokes their key.

This is intentional: usually you ban an IP because you don't trust the people on it, so a later unban (e.g. for a shared connection where one bad actor is now gone) shouldn't silently bring everyone back without explicit admin review.

## Operational notes

- Bans are HMAC-keyed by `IP_HASH_SALT`. Rotating the salt invalidates every existing ban (and every `bound_identity`). Don't.
- IP bans cannot be applied to a user who has never used their key, because there's no `bound_identity` yet.
- Two real users behind the same NAT/CGNAT will share an IP hash. The "Siblings" view (see [Siblings & alts](./siblings-and-genesis.md)) is your tool for distinguishing actual alts from coincidental cohabitants before you ban.
