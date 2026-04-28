# Users & Moderation — Admin Documentation

This folder is the operational reference for everything in the **account & moderation system**: how users come into existence, how they're identified, how they get flagged, banned, re-keyed, and how every admin action is recorded.

Each topic has its own page so you can jump straight to what you need.

## Index

| Page | What's in it |
|------|--------------|
| [Accounts & lifecycle](./accounts.md) | Registration, profile, soft-delete, reactivate, re-key, tombstones |
| [API keys](./api-keys.md) | Key creation, IP binding, revocation, the `X-API-Key` header |
| [Admin passkeys (WebAuthn)](./admin-webauthn.md) | Second-factor passkey 2FA for admin keys: registration, assertion, sessions, recovery |
| [Flags](./flags.md) | What a flag is, how flags are raised, what **Valid / False positive / Dismiss** actually do |
| [Feature flags](./feature-flags.md) | Runtime kill switches (`maintenance_mode`, `uploads_enabled`, `registration_enabled`, …) and how to toggle them |
| [IP bans](./ip-bans.md) | How an IP ban works, blast radius, expiry, unban behaviour |
| [Siblings & alts (Genesis)](./siblings-and-genesis.md) | `bound_identity`, `genesis_for_ip`, alt-account detection |
| [In-game name duplicates](./in-game-name-duplicates.md) | How collisions are detected and flagged |
| [Audit log](./audit-log.md) | Every admin action that gets recorded |
| [Admin route reference](./admin-routes.md) | Every `/api/admin/...` endpoint |
| [Stats](./stats.md) | What the numbers on the Users page mean |

## Quick mental model

- A **user** is a row in `users`, identified by an `api_key`.
- An **api_key** lives in `api_keys` and (for `consume_once` keys) is **bound** to the first IP that uses it via `bound_identity = HMAC-SHA256(ip)`.
- Two users with the same `bound_identity` are **siblings** (alts on the same connection). The first one is the **genesis** account.
- A **flag** (`user_flags`) is an automatic note that something looks suspicious about a user. Flags are raised by the system; admins resolve them. **Resolving a flag does not punish anyone automatically** — see [Flags](./flags.md).
- An **IP ban** (`ip_bans`) is the only enforcement action that actually blocks traffic. It hits the IP hash, not the account.
- Every admin write action is appended to `admin_audit_log`.

## Honest caveats

- `resolution = 'valid'` (the "strike") is **purely informational** today. It does not auto-ban, decrement reputation, or change anything else. See [Flags > What "Valid" actually does](./flags.md#what-valid-actually-does).
- IP bans hash the IP with `IP_HASH_SALT`. Raw IPs are never stored. If you rotate the salt you lose the ability to match existing bans against incoming traffic.
- `Unban IP` does **not** un-revoke api_keys or reactivate accounts. You have to do those manually after lifting a ban — see [IP bans > Unban](./ip-bans.md#unban).
