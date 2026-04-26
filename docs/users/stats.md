# Stats

The card at the top of the admin Users page comes from `GET /api/admin/users/stats` and is computed by `get_user_stats()` in [backend/app/core/accounts_db.py](../../backend/app/core/accounts_db.py).

## Caching

Results are cached in the `app_state` table for **60 seconds**. The response includes `"cached": true|false` so you can tell. The **Refresh stats** button on the page hits `?refresh=true`, which bypasses the cache and recomputes.

## Fields

| Field | Definition |
|---|---|
| `total` | All users except the special `__admin__` row |
| `active` | `total` minus soft-deleted (`deleted_at IS NULL`) |
| `active_last_7_days` | Users whose key has been used in the last 7 days (`api_keys.last_used_at > now() - interval '7 days'`) |
| `hireable` | `is_hireable AND deleted_at IS NULL` |
| `flagged` | `COUNT(DISTINCT flagged_user) FROM user_flags WHERE resolved_at IS NULL` — i.e. distinct users with at least one open flag |
| `banned` | Active (non-expired) rows in `ip_bans`. **This counts banned IPs, not banned users.** A single ban often takes out multiple accounts |
| `deleted` | All users with `deleted_at IS NOT NULL` (includes self-deletes and ban cascades) |

## Things that are easy to misread

- `banned` is a count of `ip_bans` rows. The number of *accounts* affected by bans is `deleted` minus self-deletes, which isn't tracked separately. If you need it, query `users WHERE display_name LIKE '[banned-%'`.
- `flagged` collapses by user, not by flag. A user with 5 open flags counts as 1.
- `active_last_7_days` is computed off `api_keys.last_used_at`, so a user who hasn't used the API in 8 days but is still "logged in" in the frontend won't count.

## Refreshing

Click **Refresh stats** in the page header, or call:

```
GET /api/admin/users/stats?refresh=true
```

Refresh writes the new value back to the cache, so subsequent unforced reads in the next 60 s see the fresh value.
