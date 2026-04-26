# In-Game Name Duplicates

Users can set a custom **in-game name** (their actual Vintage Story IGN) on their profile. Display names are auto-generated and unique by construction; in-game names are *not* unique-constrained at the DB level, but collisions are detected and flagged.

## Normalisation

Two IGNs collide if their normalised forms match. Normalisation is:

```python
def normalise_ingame_name(name):
    if not name:
        return None
    parts = name.strip().split()  # also collapses internal whitespace
    return " ".join(parts).casefold()
```

So `"  Forest   Walker "` and `"forest walker"` collide, but `"Forest_Walker"` (underscore) does not collide with `"Forest Walker"`.

## Detection

When a user `PATCH`es their profile with a new `in_game_name`, the backend runs:

```sql
SELECT * FROM users
WHERE deleted_at IS NULL
  AND in_game_name IS NOT NULL
  AND lower(regexp_replace(trim(in_game_name), '\s+', ' ', 'g')) = <normalised>
  AND api_key <> <self>;
```

For every row returned, a flag is created:

```python
create_user_flag(
    flagged_user=current_user_key,
    related_user=other_user_key,
    reason="duplicate_ingame_name",
    metadata={"in_game_name": <raw_value>},
)
```

The IGN change itself **goes through unmodified** — the flag is purely a record so an admin can decide if it's impersonation or coincidence.

## What admins should look at

In the Flags dialog, a `duplicate_ingame_name` row will show:

- The other user it relates to (`related_user` column → `related_display_name`).
- The exact IGN that was claimed (in `metadata.in_game_name`).

Cross-reference with the [Siblings](./siblings-and-genesis.md) view: if the duplicate IGN claimant is on the same IP as the original, that's a stronger impersonation signal than two unrelated users.

If you decide it's impersonation, your direct levers are:

- Use **Regen name** on the impersonator (changes display name, doesn't touch IGN).
- Ask them via re-key flow / soft-delete if you want stronger action.
- Resolve the flag as **Valid** to record the strike. (Reminder: that resolution does not by itself do anything — see [Flags > What "Valid" actually does](./flags.md#what-valid-actually-does).)

If it's clearly coincidence (e.g. two unrelated genesis accounts that happen to share a common name), resolve as **False positive**.
