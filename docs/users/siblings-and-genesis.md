# Siblings & Alts (Genesis)

The system tries to surface alt-account behaviour without storing raw IPs. The mechanism is `bound_identity` (a hashed IP) on `api_keys`.

## How siblings are detected

Every `consume_once` api_key gets `bound_identity = HMAC-SHA256(IP_HASH_SALT, client_ip)` written on its first use. Two users whose api_keys share the same `bound_identity` came in from the same connection.

`GET /api/admin/users/{api_key}/siblings` runs:

```sql
SELECT u.*, ak.last_used_at, ak.bound_identity, ak.revoked AS key_revoked
FROM users u
JOIN api_keys ak ON ak.key = u.api_key
WHERE ak.bound_identity = (
    SELECT bound_identity FROM api_keys WHERE key = ?
)
  AND ak.bound_identity IS NOT NULL
  AND u.api_key <> ?
ORDER BY u.joined_at;
```

In the admin UI, the **Siblings** button on a user row opens a dialog listing every other account on the same IP hash. Each is shown with its display name, IGN, and whether it's deleted or genesis.

## Genesis

`users.genesis_for_ip` is `TRUE` for the **first** non-deleted account ever created on a given IP hash. Subsequent accounts on the same IP are **not** genesis, and they get a `shared_ip` flag at registration time (see [Flags](./flags.md)).

The Genesis badge in the UI is a quick "this is the original / main account" hint; the others are likely alts (or housemates).

You can filter the user list to genesis-only via the **Genesis only** filter on the Users page (or `?genesis=true` on `GET /api/admin/users`).

## What this is *not*

- It is not VPN/proxy detection. Users behind shared NAT/CGNAT will appear as siblings even if they're unrelated.
- It is not device fingerprinting. A user on two networks (home + mobile) will look like two separate identities, each genesis on its own IP. Re-keying a user from a new network will rebind their key to that new IP.
- A user can deliberately get a fresh `bound_identity` by asking an admin for a re-key from a different network. There's no way to prevent this with this design.

## Recommended workflow when investigating an alt

1. Open the suspicious user's row, click **Siblings**.
2. Look at `joined_at` order. The earliest non-deleted one with `genesis_for_ip = true` is the "main".
3. Look at the **Flags (n)** dialog on each sibling — they'll usually have a `shared_ip` flag pointing at this IP hash.
4. If you want to take action on all of them at once, use **Ban IP** on any of them; it cascades to the whole IP. Use the **blast-radius preview** in the ban dialog to confirm the list before you commit. See [IP bans](./ip-bans.md).
