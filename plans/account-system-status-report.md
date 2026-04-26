# Account System — Configuration & Deployment Status Report

This is the post-implementation checklist for the account system added in
[plans/account-system-plan.md](plans/account-system-plan.md). Read it end-to-end
before deploying to production.

---

## 1. Database

### Schema

A new SQL block `_ACCOUNT_SCHEMA_SQL` was appended to
[backend/app/core/database.py](backend/app/core/database.py) and is executed
inside `ensure_schema()` on every boot. It creates:

- `users` — one row per `api_key`, with display name, in-game name, hireable
  flag, leaderboard opt-in, terms version, soft-delete tombstone, regen counter.
- `ip_bans` — IP-hash ban list with reason code/notes/expiry.
- `user_flags` — open/resolved flag log (auto-emitted for shared IP and
  duplicate in-game names; manually resolved by admins).
- `admin_audit_log` — append-only log of admin actions.

All `CREATE TABLE` and `CREATE INDEX` statements use `IF NOT EXISTS`, so the
migration is **idempotent** and safe to re-run on every boot.

### ⚠️ Required: `pg_trgm` extension

The schema runs `CREATE EXTENSION IF NOT EXISTS pg_trgm;` to power
case-insensitive substring search on display names / in-game names. On Supabase:

1. Open the SQL Editor.
2. Run `CREATE EXTENSION IF NOT EXISTS pg_trgm;` once with your service role.

If the role used by `SUPABASE_DB_URL` does not have `CREATE EXTENSION`
permission, startup will log a warning but the rest of the schema will still
apply. Searches will then fall back to `ILIKE` and may be slow at scale —
admin-only impact.

### Backfill

On every startup, `accounts_db.backfill_users()` runs and:

- Creates a `users` row for every existing `api_keys.key` that doesn't have
  one, with a freshly generated display name and `terms_version = "backfill"`.
- Marks the earliest non-deleted account on each `bound_identity` as
  `genesis_for_ip = true`.
- Seeds a synthetic `__admin__` user for `ADMIN_API_KEY` so the admin's actions
  can be foreign-keyed to a `users` row.

This is **idempotent and non-destructive**, but you should still take a database
snapshot before the first boot just in case.

---

## 2. Required environment variables

| Variable | Purpose | Default | Critical? |
|---|---|---|---|
| `SUPABASE_DB_URL` | Postgres connection string | — | **YES** — backfill needs DB access |
| `ADMIN_API_KEY` | Admin login + synthetic user seed | empty | **YES** — without it admins cannot moderate users |
| `IP_HASH_SALT` | HMAC salt for `_hash_ip()`. **Never rotate** without a dual-hash migration window — rotating it invalidates every existing IP-binding and IP-ban. | `default-salt-change-me` | **YES** — set to a long random string before launch |
| `TERMS_VERSION` | Bump to force re-acceptance of terms on next `/account/me`. The frontend can show a re-accept banner when `terms_version_current !== user.terms_version`. | `2025-01-01` | recommended |
| `RATE_LIMIT_REGEN_NAME_MAX` | Per-user limit on `/account/regenerate-name` | `3` | optional |
| `RATE_LIMIT_REGEN_NAME_WINDOW` | Window in seconds | `86400` (24 h) | optional |
| `RATE_LIMIT_PROFILE_MAX` | Per-user limit on `PATCH /account/me` | `10` | optional |
| `RATE_LIMIT_PROFILE_WINDOW` | Window in seconds | `3600` (1 h) | optional |
| `IP_BAN_DEFAULT_DAYS` | Default ban length when admin doesn't specify | `365` | optional |

### `.env` template addition

Append this to your existing `backend/.env`:

```env
ADMIN_API_KEY=<long-random-secret>
IP_HASH_SALT=<another-long-random-secret-NEVER-rotate>
TERMS_VERSION=2025-01-01
```

---

## 3. New backend routes

All routes registered under `/api`. **Mount order matters** — `admin_users.router`
is included before `admin.router` was *not* required in this case (no path
collisions), but if you add overlapping paths in future, FastAPI matches
first-registered first.

### User-facing (`require_active_user`)

```
POST   /api/account/register            # accept_terms: true
GET    /api/account/me
PATCH  /api/account/me                  # in_game_name, is_hireable, is_leaderboard_visible
POST   /api/account/regenerate-name
GET    /api/account/export              # full data export (GDPR)
DELETE /api/account/me                  # soft-delete + revoke key
```

### Admin (`require_admin`)

```
GET    /api/admin/users
GET    /api/admin/users/stats?refresh=true
GET    /api/admin/users/{api_key}
GET    /api/admin/users/{api_key}/siblings
POST   /api/admin/users/{api_key}/regenerate-name
POST   /api/admin/users/{api_key}/rekey            # returns new_api_key ONCE
POST   /api/admin/users/{api_key}/reactivate
DELETE /api/admin/users/{api_key}                  # soft-delete

GET    /api/admin/users/{api_key}/ban-preview
POST   /api/admin/users/{api_key}/ban              # blast-radius ban

GET    /api/admin/ip-bans
DELETE /api/admin/ip-bans/{ip_hash}

GET    /api/admin/flags
POST   /api/admin/flags/{flag_id}/resolve          # resolution: valid|abuse|dismissed
```

---

## 4. New frontend pages & navigation

| Path | Component | Notes |
|---|---|---|
| `/account` | `AccountPage` | Visible to anyone with an API key. Shows register flow if no `users` row exists. |
| `/manage/users` | `AdminUsersPage` | Admin only. Search, filter (Flagged/Banned/Genesis), per-row actions, ban modal with blast-radius preview. |
| `/manage/banned-ips` | `AdminBannedIpsPage` | Admin only. Active bans, unban button. |
| `/manage/flags` | `AdminFlagsPage` | Admin only. Quick-resolve buttons. |

A new "Account" button was added to the header next to the "API Key" button.

### ⚠️ No `Vite` env required

The frontend uses `VITE_API_BASE` if set, otherwise `/api`. Existing
[frontend/vercel.json](frontend/vercel.json) / Vite proxy config is unchanged.

---

## 5. Things you should test before launch

1. **Backfill on a copy of prod DB**: Restore a snapshot to a staging
   Supabase project, point a local backend at it, boot, and verify:
   - `SELECT COUNT(*) FROM users;` matches `SELECT COUNT(*) FROM api_keys;`
   - `SELECT COUNT(*) FROM users WHERE genesis_for_ip = TRUE;` is roughly
     the count of unique `bound_identity` values.
   - `SELECT * FROM users WHERE display_name = '__admin__';` returns one row.

2. **End-to-end invite flow**: Create an invite link, claim it in an
   incognito window, hit `/account` — should land on the "Create your account"
   screen, then resolve to a real profile after clicking the button.

3. **Ban blast radius**: Create two test accounts from the same IP, ban one.
   Both should be soft-deleted; both API keys revoked.

4. **Re-key flow**: Re-key a test user, verify the old key returns 401 and the
   new key works. The new key is shown **once** — make sure you copy it.

5. **Soft delete + reactivate**: Self-delete from `/account`, confirm key is
   revoked. Then admin-reactivate via `/manage/users` and confirm access
   returns.

---

## 6. Known limitations / follow-ups (not in MVP)

- **Hire board UI** — backend has `is_hireable`; no public "browse hireable
  users" page yet. (Future work.)
- **Public leaderboard** — `is_leaderboard_visible` flag exists; no UI yet.
- **In-game name flagging UI** — backend records `duplicate_ingame_name`
  flags automatically when a profile update collides with another active user;
  no in-product "report this name" button yet.
- **Rate limiter is in-process memory** — `_scoped_requests` lives in
  [backend/app/rate_limiter.py](backend/app/rate_limiter.py). On a
  multi-worker deployment limits are enforced **per worker**, not globally.
  Acceptable for current scale; revisit if you scale horizontally.
- **`ip_bans` cleanup** — `accounts_db.cleanup_expired_ip_bans()` exists but
  isn't scheduled. Add a cron / lifespan task if you want bans physically
  removed; otherwise expired bans are simply ignored by `is_ip_banned()`.
- **Terms re-acceptance UI** — backend exposes `terms_accepted_current` in
  `/account/me`; no banner / blocking modal for stale acceptance is wired up
  in the frontend yet. Bump `TERMS_VERSION` and the API will start returning
  `false`; you can read it from `useQuery(["account-me"])` to render whatever
  prompt you want.
- **Admin audit log viewer** — entries are written but there's no UI. Query
  via `SELECT * FROM admin_audit_log ORDER BY created_at DESC` for now.

---

## 7. Files added / modified

### Added

- [backend/app/core/accounts_db.py](backend/app/core/accounts_db.py)
- [backend/app/core/display_names.py](backend/app/core/display_names.py)
- [backend/app/routes/account.py](backend/app/routes/account.py)
- [backend/app/routes/admin_users.py](backend/app/routes/admin_users.py)
- [frontend/src/pages/AccountPage.tsx](frontend/src/pages/AccountPage.tsx)
- [frontend/src/pages/AdminUsersPage.tsx](frontend/src/pages/AdminUsersPage.tsx)
- [frontend/src/pages/AdminBannedIpsPage.tsx](frontend/src/pages/AdminBannedIpsPage.tsx)
- [frontend/src/pages/AdminFlagsPage.tsx](frontend/src/pages/AdminFlagsPage.tsx)

### Modified

- [backend/app/core/database.py](backend/app/core/database.py) — added
  `_ACCOUNT_SCHEMA_SQL`, wired into `ensure_schema()`.
- [backend/app/auth.py](backend/app/auth.py) — added `require_active_user`
  dependency; imports `accounts_db`.
- [backend/app/config.py](backend/app/config.py) — added `TERMS_VERSION`,
  per-key rate limit knobs, `IP_BAN_DEFAULT_DAYS`.
- [backend/app/rate_limiter.py](backend/app/rate_limiter.py) — added
  `check_scoped_rate_limit()`.
- [backend/app/main.py](backend/app/main.py) — registers new routers, runs
  account backfill on startup.
- [frontend/src/lib/api.ts](frontend/src/lib/api.ts) — added all
  account / admin-user / IP-ban / flag client functions and types.
- [frontend/src/App.tsx](frontend/src/App.tsx) — added `/account` route, three
  new admin sub-tabs under `/manage`, header "Account" button.
