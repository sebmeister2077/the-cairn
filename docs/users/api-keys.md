# API Keys

The API key **is** the identity. There are no usernames or passwords. Anyone holding a key can act as that user.

## The `api_keys` table

| Field | Type | Notes |
|---|---|---|
| `key` | TEXT PK | 32-byte URL-safe random token |
| `name` | TEXT | Human label, e.g. "User API Key", "Invite link 2026-04" |
| `permissions` | TEXT | `'read'` or `'contribute'` |
| `consume_once` | BOOL | If true, the key gets bound to the first IP that uses it |
| `bound_identity` | TEXT, nullable | HMAC-SHA256 hash of the IP that consumed it (NULL until first use, NULL forever for non-consume_once keys) |
| `revoked` | BOOL | True = key no longer authenticates |
| `usage_count` | BIGINT | Incremented on every authenticated request |
| `created_at` | TIMESTAMPTZ | Key creation |
| `last_used_at` | TIMESTAMPTZ, nullable | Most recent successful auth |

## Auth header

All authenticated routes accept the key via:

- **Header:** `X-API-Key: <key>`
- **Query string:** `?api_key=<key>` (less safe, used by some clients)

Resolution order in [backend/app/auth.py](../../backend/app/auth.py):

1. Match against `ADMIN_API_KEY` env var → admin context, full access, **bypasses IP ban check** for the admin themselves.
2. Match against `API_KEYS` env var (legacy comma list) → contribute permissions, never revoked.
3. Look up in the `api_keys` table → enforce `revoked` and IP binding.

## IP binding (`consume_once`)

Most user-facing keys are minted with `consume_once = TRUE`. The first time the key is used:

```python
ip_hash = HMAC_SHA256(IP_HASH_SALT, client_ip)
UPDATE api_keys SET bound_identity = <ip_hash> WHERE key = <key> AND bound_identity IS NULL;
```

After that, every subsequent request must come from an IP whose hash matches `bound_identity`, otherwise auth returns **401 "API key is locked to another user"**.

This is what makes alt-account detection possible (see [Siblings & alts](./siblings-and-genesis.md)) and what enables [IP bans](./ip-bans.md) to surgically take out every account on a connection.

### `IP_HASH_SALT`

The salt is read from the env var `IP_HASH_SALT`. **Do not rotate it casually** — every existing `bound_identity` and every `ip_bans.ip_hash` is computed against the current salt. Rotating breaks all of them silently.

`X-Forwarded-For` is honoured (assumes a trusted reverse proxy in front of the API).

## Creating keys

Admins create keys via `POST /api/admin/keys`:

```json
{
  "name": "My new key",
  "permissions": "contribute",
  "consume_once": true
}
```

Or generate an invite link via `POST /api/admin/invite-links` which mints a key the first time someone redeems it.

## Revocation

Keys can be revoked from three places:

- **Admin** explicitly: `DELETE /api/admin/keys/{key_id}`
- **User soft-delete**: revokes the user's own key
- **IP ban**: revokes *every* key bound to the banned IP

Revocation is one-way through the normal flows except for `reactivate`, which un-revokes the user's specific key when bringing a soft-deleted user back. There is no admin "un-revoke arbitrary key" route.

## Re-key (admin)

`POST /api/admin/users/{api_key}/rekey` swaps a user's `api_key` for a freshly minted one and revokes the old one. The new key is shown **once** in the response. See [Accounts > Re-key](./accounts.md#re-key).
