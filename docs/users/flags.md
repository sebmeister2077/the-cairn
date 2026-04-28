# Flags

A **flag** is an automatic note that the system raises when something about a user looks suspicious. Flags are stored in `user_flags` and surface on the admin Users page (red badge + "Flags (n)" button).

> **Different from feature flags.** This page is about *user report flags* (the red badge). For runtime kill switches like `maintenance_mode` and `uploads_enabled`, see [feature-flags.md](./feature-flags.md).

> **Important up front:** flags are *informational*. The system never takes action based on them. Resolving a flag does not punish, ban, demote, or auto-anything. Resolution is a label so admins can clear their queue and keep the history. See [What "Valid" actually does](#what-valid-actually-does) below.

## The `user_flags` table

| Field | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `flagged_user` | TEXT | The user the flag is *about* |
| `related_user` | TEXT, nullable | Another user involved (e.g. the duplicate IGN holder). `ON DELETE SET NULL` |
| `reason` | TEXT | Reason code, see [Reasons](#reasons) |
| `metadata` | JSONB, nullable | Structured context, shape depends on reason |
| `created_at` | TIMESTAMPTZ | When the flag was raised |
| `resolved_at` | TIMESTAMPTZ, nullable | NULL = open |
| `resolved_by` | TEXT, nullable | Admin api_key that resolved |
| `resolution` | TEXT, nullable | `'valid'` \| `'abuse'` \| `'dismissed'` |

The "flag count" badge on the user row counts only **unresolved** flags (`WHERE resolved_at IS NULL`).

## Where flags come from

The system creates flags in exactly two places today. There is no admin "raise a flag" UI.

### 1. `shared_ip` — non-genesis registration

[backend/app/routes/account.py](../../backend/app/routes/account.py) `register`:

```python
if not is_genesis:
    create_user_flag(
        flagged_user=api_key,
        reason="shared_ip",
        metadata={"ip_hash": ip_hash},
    )
```

Raised when a new account is created from an IP that already has at least one non-deleted account on it. This is the alt-account detection signal.

### 2. `duplicate_ingame_name` — IGN collision

[backend/app/routes/account.py](../../backend/app/routes/account.py) profile update:

```python
for other in collisions:
    create_user_flag(
        flagged_user=ctx["key"],
        related_user=other["api_key"],
        reason="duplicate_ingame_name",
        metadata={"in_game_name": in_game_name},
    )
```

Raised when a user sets an `in_game_name` that, after normalisation (lowercase, collapsed whitespace), matches an active user's IGN. One flag per colliding user is created. The IGN change is **not blocked**. See [In-game name duplicates](./in-game-name-duplicates.md).

## Reasons

| `reason` | Meaning | Typical metadata | `related_user` |
|---|---|---|---|
| `shared_ip` | Account created on an IP that already has accounts | `{"ip_hash": "..."}` | NULL |
| `duplicate_ingame_name` | IGN matches another active user (case-insensitive) | `{"in_game_name": "..."}` | The other account |

If you want to add new reasons, just pass any string into `create_user_flag(reason=...)` — it's not enum-constrained at the DB level.

## Viewing flags

In the admin UI, on the Users page:

- The red **N flag(s)** badge on a user row is clickable.
- The **Flags (N)** button in the row's action group opens the same dialog.

The dialog lists all flags ever raised against the user, split into **Unresolved** and **Resolved**. Each row shows the reason badge, timestamp, related user (if any), and the raw `metadata` JSON.

API: `GET /api/admin/flags?flagged_user=<key>&unresolved_only=false`.

## Resolving a flag

`POST /api/admin/flags/{flag_id}/resolve` with body `{"resolution": "valid" | "abuse" | "dismissed"}` runs:

```sql
UPDATE user_flags SET
  resolved_at = now(),
  resolved_by = <admin_api_key>,
  resolution  = <resolution>
WHERE id = ?;
```

That is the entire effect. The row stays in the table forever; nothing else happens.

### What the three buttons mean

The buttons are pure labels for **why** you closed the flag. Pick the one that best documents your decision; the system treats all three identically.

| Button | `resolution` value | Meaning |
|---|---|---|
| **Valid** | `valid` | "Yes, the flag is correct, the user did something wrong." Counts as a strike on the record. |
| **False positive** | `abuse` | "The flag was raised in error / bad faith — the user did nothing wrong." No strike. |
| **Dismiss** | `dismissed` | "The flag is technically valid but I'm choosing not to act on it." No strike. |

> The internal value `abuse` is a legacy name from when the button was labeled "Abuse". The user-facing label is "False positive".

### What "Valid" actually does

**Nothing automated.** A "strike" is just the existence of one or more `user_flags` rows with `resolution = 'valid'` for that user. There is no:

- automatic ban after N strikes,
- reputation score,
- visibility/permissions change,
- email or in-app notification,
- propagation to siblings or to the IP.

If you want a `valid` resolution to actually do something to the user (warn, suspend, ban after N strikes, demote from hireable, …), that's a feature that has to be built. The data is in place to query it (`SELECT count(*) FROM user_flags WHERE flagged_user = ? AND resolution = 'valid'`), but no code consumes it today.

### What follow-up actions to take after marking Valid

Because nothing happens automatically, if a strike *should* lead to consequences, do them by hand from the same Users row:

- Light: **Regen name** (forces a new display name).
- Medium: **Re-key** (forces re-auth, breaks any leaked key).
- Heavy: **Delete** (soft-delete the account).
- Severe: **Ban IP** (takes out every account on the connection — see [IP bans](./ip-bans.md)).

All of these are recorded in the [Audit log](./audit-log.md).
