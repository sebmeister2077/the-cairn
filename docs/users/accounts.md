# Accounts & Lifecycle

A user account is a row in `users`, keyed by `api_key` (which is also a foreign key into `api_keys`). One user has exactly one current `api_key`; replacing it is the [re-key](#re-key) flow.

## The `users` table

| Field | Type | Notes |
|---|---|---|
| `api_key` | TEXT PK | FK → `api_keys.key` |
| `display_name` | TEXT, UNIQUE | Public name like `Bright-Explorer-1234`. **Auto-generated**, never user-chosen |
| `in_game_name` | TEXT, nullable | Optional Vintage Story IGN, used for leaderboards |
| `is_hireable` | BOOL | User opted in to the hireable list |
| `is_leaderboard_visible` | BOOL | User opts in to leaderboards |
| `show_contributions` | BOOL | User shares contribution stats publicly |
| `genesis_for_ip` | BOOL | True if this is the first account ever created on its IP. See [Siblings & alts](./siblings-and-genesis.md) |
| `joined_at` | TIMESTAMPTZ | Account creation |
| `terms_accepted_at` | TIMESTAMPTZ | When the user accepted ToS |
| `terms_version` | TEXT | Which ToS version was accepted |
| `deleted_at` | TIMESTAMPTZ, nullable | NULL = active, non-NULL = soft-deleted |
| `name_regen_count` | INT | How many times the name has been regenerated |
| `last_name_change_at` | TIMESTAMPTZ, nullable | For rate-limiting display name regens |

## Registration

`POST /account/register` (in [backend/app/routes/account.py](../../backend/app/routes/account.py)):

1. Generate a unique `display_name`. Forbidden patterns (admin/moderator/system/etc.) are rejected by [backend/app/core/display_names.py](../../backend/app/core/display_names.py).
2. Determine `genesis_for_ip` by checking whether any non-deleted user already exists on the caller's IP hash.
3. Insert the `users` row with the current `terms_version`.
4. **If the user is not genesis**, create a `user_flag` with `reason = "shared_ip"` immediately. See [Flags](./flags.md).

The user does *not* pick a name. There is no email, password, or username. The `api_key` itself is the identity.

## Profile updates

`PATCH /account/me` lets the user change `in_game_name`, `is_hireable`, `is_leaderboard_visible`, `show_contributions`. If `in_game_name` changes and collides with another active user's IGN, a `duplicate_ingame_name` flag is raised — see [In-game name duplicates](./in-game-name-duplicates.md). The name change is **not blocked** by the collision; it's just recorded.

## Regenerate display name

`POST /account/regenerate-name` (user-initiated) or `POST /api/admin/users/{api_key}/regenerate-name` (admin-initiated). Picks a new unique name, increments `name_regen_count`, sets `last_name_change_at`.

User-initiated regens are rate-limited to `RATE_LIMIT_REGEN_NAME_MAX` (default **3**) per `RATE_LIMIT_REGEN_NAME_WINDOW` (default **24 h**). Admin-initiated regens are not rate-limited.

## Soft-delete

Soft-delete is the only deletion mode. Rows are never `DELETE`d from `users`.

When a user is soft-deleted (either by themselves via `DELETE /account/me`, or by an admin via `DELETE /api/admin/users/{api_key}`):

```sql
UPDATE users SET
  deleted_at  = now(),
  display_name = '<tombstone>',         -- e.g. [deleted-1714000000]
  in_game_name = NULL,
  is_hireable  = FALSE,
  is_leaderboard_visible = FALSE
WHERE api_key = ? AND deleted_at IS NULL;

UPDATE api_keys SET revoked = TRUE WHERE key = ?;
```

The user's contributions stay attached to the (now anonymised) display name. The api_key is revoked and can no longer authenticate.

Tombstone formats:
- User-initiated: `[deleted-<unix-ts>]`
- Admin-initiated: `[deleted-<unix-ts>]`
- Cascaded by an IP ban: `[banned-<unix-ts>-<n>]`

## Reactivate

`POST /api/admin/users/{api_key}/reactivate` (admin only):

```sql
UPDATE users SET deleted_at = NULL WHERE api_key = ?;
UPDATE api_keys SET revoked = FALSE WHERE key = ?;
```

This **does not restore** the original `display_name` or `in_game_name` — those were nulled/tombstoned during soft-delete. The user gets back a working account but will need to set their IGN again. Their original `api_key` works again.

## Re-key

`POST /api/admin/users/{api_key}/rekey` (admin only):

1. Mint a brand new api_key via `create_api_key` (consume_once, contribute permissions).
2. Move the `users` row to point at the new key: `UPDATE users SET api_key = <new> WHERE api_key = <old>`.
3. Revoke the old key.
4. Return the new key **once** in the response — it is never recoverable after that. Deliver it securely (DM, signed message, etc.).

Use re-key when:
- A user's key is leaked.
- You need to forcibly sign someone out without deleting their account.
- A user asks to "reset" their account.

## Stats

The aggregate counts on the admin Users page come from `get_user_stats` and are cached for 60 s. See [Stats](./stats.md).
