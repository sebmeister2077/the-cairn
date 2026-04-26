# Account System Implementation Plan

## 1. Original requirements (summary)

When users join with an API key and accept the terms, they are logged in as
an **anonymous user**. An **Account** page lets them:

- See their auto-generated anonymous display name.
- Optionally add their **in-game name**.
- Toggle **Hireable** (default `No`).
- See join date and last-login date.
- See (and copy) their API key so they can restore access if they clear cookies.
- Download all of their data as JSON (data export).
- **Delete account** — soft delete; any personal username fields replaced with `Deleted`.

In the **Manage** tab, admins get a new **Users** page:

- Table of all users with: anonymous name, in-game name, join date, last
  login, hireable, banned, API key (masked, reveal on click).
- Actions: delete user, ban IP (wipes personal data but keeps the hashed
  IP for 1 year so bans are enforceable, then auto-purged).
- Search by anonymous name or in-game name.
- Sort by join date, last login, hireable.
- Infinite scroll, 20 users per page.
- Banner with totals: registered, hireable, banned, deleted, active in last 7 days.

---

## 2. Opinion & suggestions

Overall the plan fits the existing architecture (API-key auth,
Supabase/Postgres, admin panel). A few things to refine before building:

### 2.1 Identity model — tie accounts to `api_keys`, don't invent a new one

`api_keys` already stores `key`, `created_at`, `last_used_at`,
`bound_identity` (hashed IP), `revoked`, `usage_count`. An "account" here is
really just **metadata attached to an API key**, so avoid a second identity
concept. Add a `users` table with `api_key` as the PK/FK (1:1), rather than
inventing user ids and a separate login flow.

Benefits: no migration pain, existing auth middleware keeps working, the
"login = present a valid API key" model stays intact.

### 2.2 "Logged in" means having a valid API key — be explicit

The app is already effectively logged in when the key is in local storage.
Frame the Account page as **"your account is your API key"** rather than
adding a session/cookie layer. This matches the invite-only closed-beta
design and `TERMS_AND_PRIVACY_PLAN.md`.

### 2.3 Showing the API key — security

- Keep the key in `localStorage` (already the case) and display it on the
  Account page behind a "Show / Copy" button.
- Warn the user the key is the **only** way to recover the account; there
  is no email reset. Offer a "Download recovery file" button (a small JSON
  with `{ api_key, created_at, display_name }`) so users have an offline copy.
- On the admin side, storing/displaying raw keys in the Users table is risky
  — an admin-panel XSS would leak every key. Consider storing a **key hash**
  in `api_keys` going forward (breaking change for existing keys; can be
  phased), or at minimum only reveal the key via a short-lived endpoint that
  writes to the audit log.

### 2.4 Anonymous display name generation

- Generate server-side at key creation (e.g. `Curious-Drifter-4821`).
- Must be **unique** — enforce with a `UNIQUE` constraint and retry loop.
- Allow the user to **regenerate** it a limited number of times
  (rate-limited, e.g. 3/day) to avoid impersonation through name squatting.
- Reserve a list of forbidden substrings (admin, mod, staff, deleted, etc.).

### 2.5 In-game name — treat it as user-submitted content

- Length cap (e.g. 32 chars), strip control chars, NFC-normalise.
- Rate-limit changes (e.g. 1 per hour) so it is not used as a chat channel.
- Consider a profanity filter or at least a "report user" button for admins
  (ties into the ban flow).
- Changing it should invalidate cached listings (or the admin list should
  always read fresh).

### 2.6 Soft delete semantics

- On delete:
  - Set `deleted_at`, clear `in_game_name`, replace `display_name` with a
    stable tombstone like `Deleted-<short-hash>` so existing references
    (contributions, logs) still resolve to something.
  - Revoke the API key (`revoked = TRUE`) so it cannot be reused.
  - Keep contribution attribution as `[Deleted user]` (same pattern as the
    existing `[Withdrawn]` marker).
- Deletion must be **idempotent** and confirmed (typed confirmation in UI).
- Clarify: deletion is **local** only (DB + R2 metadata). Any tile data
  already merged into the shared community map cannot be un-merged — say so
  in the UI (matches the Privacy plan).

### 2.7 IP bans — the tricky one

The plan says "ban his IP (also remove his personal data except the
encrypted IP address because it is needed, it will be deleted after a year
for cleanup)". Points:

- The IP is already **hashed** (HMAC-SHA256 with a salt) in
  `backend/app/auth.py` (`_hash_ip`). That hash is what you ban, not the
  raw IP. Keep it.
- Bans live in a dedicated `ip_bans` table with
  `(ip_hash, reason, banned_at, expires_at)`. Default expiry =
  `banned_at + 1 year`, with a nightly cleanup job.
- Auth middleware must check this table **early** (before key resolution)
  so a banned user cannot even use their key from a new browser.
- **Caveat**: hashes are per-salt; rotating `IP_HASH_SALT` invalidates all
  bans. Document this; consider a dual-hash window during rotation.
- **Caveat**: many users share IPs (CGNAT, households, VPNs). A ban is a
  blunt instrument — make it reversible (admin "unban" button) and logged.
- Also revoke the user's API key as part of the ban action.

### 2.8 Users table endpoint — pagination & search

- Use **keyset pagination** (`WHERE (joined_at, api_key) < (:last_joined,
  :last_key)`), not `OFFSET`, for stable infinite scroll as rows are added.
- Search: start with `ILIKE` on `display_name` / `in_game_name`; add
  `pg_trgm` GIN indexes for speed.
- Page size 20 is fine.
- All sort columns (`joined_at`, `last_login_at`, `is_hireable`) should be
  indexed.

### 2.9 Stats banner — cache it

Running `COUNT(*)` across the whole `users` table on every admin page load
is fine now but will not scale. Either compute on demand and cache in
`app_state` for 60 s, or materialise stats into a small `user_stats` row.
Start with the cached version.

### 2.10 Audit logging

Every admin action (delete user, ban IP, reveal API key) should write to
an `admin_audit_log` table with `admin_key`, `action`, `target`, `at`.
Critical when handling personal data, and invaluable for debugging.

### 2.11 Terms acceptance

Store `terms_accepted_at` and `terms_version` on the user row so re-
acceptance can be required when the policy changes. Ties into
`TERMS_AND_PRIVACY_PLAN.md`.

### 2.12 "Last login" — define what counts as a login

There is no session handshake, so "last login" effectively means
"last API request". `api_keys.last_used_at` is already updated on every
authenticated call — reuse it instead of adding a second field.

### 2.13 Data export JSON

Define the schema up-front, e.g.:

```json
{
  "api_key": "…",
  "display_name": "Curious-Drifter-4821",
  "in_game_name": "Seraph",
  "is_hireable": false,
  "joined_at": "…",
  "last_login_at": "…",
  "terms_accepted_at": "…",
  "contributions": [ { "id": "…", "status": "approved", "approved_at": "…" } ]
}
```

Serve from `GET /api/account/export` with the user's own key — no admin
role required for self-export. This is the GDPR "data portability" answer.

### 2.14 Minor UX points

- Account page should show a subtle **"you are browsing anonymously"**
  badge to reinforce the model.
- "Hireable" needs a short explainer tooltip — what does being hireable
  mean in this community? Who sees it?
- Users admin table should be **read-only on mobile** (destructive actions
  behind a confirm modal, not swipe).

---

## 3. Open questions

1. ~~**Hireable — who sees it?**~~ **Decided:** initially **admin-only**.
   A dedicated public "hire board" page will be added later. Implication:
   build the `is_hireable` flag + admin filter/sort now, but keep the
   field isolated behind admin endpoints — no public endpoint exposes it
   yet. When the hire board ships, `in_game_name` will become publicly
   visible, so still treat it as public-safe content from day one
   (length cap, control-char stripping, profanity filter hook).
2. ~~**Public profiles?**~~ **Decided:** **hire-board-only** for now.
   No general user-lookup endpoint. Future scope: a personal **stats**
   page (your own contributions, etc.), and an opt-in **public
   leaderboard** (e.g. top 10 by new chunks contributed). Implication:
   - Add an `is_leaderboard_visible` BOOLEAN to `users` (default FALSE)
     so the future leaderboard can filter on opt-in.
   - No public `/api/users` style endpoint is built now.
3. ~~**Multiple keys per person?**~~ **Decided:** **allow** multiple
   keys per IP, but **flag** them. The first account ever bound to an
   IP hash is the **"genesis" user**; every subsequent account on the
   same IP hash gets a `user_flags` row
   (`reason='shared_ip'`, `related_user` = genesis user) so the admin
   can investigate. Implementation:
   - Add `genesis_for_ip` BOOLEAN on `users` (TRUE only for the first
     non-deleted account on a given `bound_identity` hash).
   - The admin Users table shows a "Genesis" badge on those rows and
     supports a filter "Show all accounts on this IP" that lists every
     `users` row whose `api_keys.bound_identity` matches.
4. ~~**Admin key vs admin user.**~~ **Decided:** create a **synthetic
   admin user**. At startup, ensure a `users` row exists with
   `api_key = ADMIN_API_KEY`, `display_name = '__admin__'`,
   `terms_accepted_at = now()`, `terms_version = 'system'`. The row
   is hidden from the default admin Users list (filter
   `WHERE display_name <> '__admin__'`) but available via an explicit
   "Show system accounts" toggle. All `admin_audit_log` entries FK to
   this row.
5. ~~**Key recovery flow.**~~ **Decided:** **manual admin recovery only.**
   No automated reset. A user contacts an admin (e.g. Discord) and
   recovery is granted **only if their account history is
   non-trivial** (at least one approved contribution, or admin
   discretion). The admin issues a fresh key via the existing invite
   flow and rebinds the existing `users` row to the new
   `api_key` (an admin endpoint `POST /api/admin/users/{old_key}/rekey`
   updates the FK and revokes the old key). Audit-logged.
6. ~~**IP ban scope.**~~ **Decided:** **ban the IP hash for everyone.**
   When an admin bans, every `users` row whose
   `api_keys.bound_identity` matches that hash has its key revoked, and
   the hash is added to `ip_bans`. Rationale: "if you deserve a ban,
   no one on the network can join". Admin UI must show the **blast
   radius** (count + list of affected accounts) on the confirmation
   modal so the admin sees what they're about to do.
7. ~~**Ban appeals / unban UI.**~~ **Decided:** **ship the unban UI on
   day 1.** A "Banned IPs" tab under Manage with an Unban button per
   row. The ban modal also captures **notes**:
   - A required **reason** picked from a predefined dropdown
     (`spam`, `impersonation`, `abuse`, `harassment`, `duplicate_account`,
     `provocative_name`, `other`).
   - If `other`, a free-text **custom reason** is required.
   - An optional free-text **admin notes** field (always available,
     stored on the `ip_bans` row).
   - Schema additions: `reason_code TEXT NOT NULL`,
     `reason TEXT NOT NULL` (resolved label), `admin_notes TEXT` on
     `ip_bans`.
8. ~~**Active-in-last-7-days metric.**~~ **Decided:** option **(a)** —
   `COUNT(api_keys WHERE last_used_at > now() - interval '7 days'
   AND key IN (SELECT api_key FROM users WHERE deleted_at IS NULL))`.
   Every authenticated request counts. Free given `last_used_at` is
   already maintained.
9. ~~**Deletion grace period.**~~ **Decided:** **no grace period.**
   Soft-delete is applied immediately on user request. The only way to
   reactivate a deleted account is for the user to contact an admin, who
   can manually clear `deleted_at` and un-revoke the key. The Account
   page must show a clear, irreversible warning (typed confirmation:
   "DELETE") before the call goes through.
10. ~~**Banner refresh.**~~ **Decided:** **on page load only**, plus a
    manual **Refresh** button on the banner. Server-side stats are
    cached in `app_state` for 60 s, so the Refresh button is cheap.
11. ~~**Rate-limiting the new endpoints.**~~ **Decided:** add per-key
    rate limits for the spam-prone endpoints now, defer the rest:
    - `POST /api/account/regenerate-name` — **3/day per key**
    - `PATCH /api/account/me` — **10/hour per key**
    - Other account endpoints rely on existing per-IP limits for now.
    Implementation: extend `rate_limiter.py` with a per-key bucket
    keyed on the resolved API key.
12. ~~**In-game name uniqueness.**~~ **Decided:** **not unique**, but a
    **flagging mechanism** triggers when a new account sets an
    `in_game_name` that exactly matches the `in_game_name` of an existing
    **active** account. Behaviour:
    - On `PATCH /api/account/me` (or initial set), check for any other
      non-deleted user with the same normalised name.
    - If a collision exists, insert a row into a new `user_flags` table
      (`flagged_user`, `reason='duplicate_ingame_name'`,
      `related_user`, `created_at`, `resolved_at`, `resolved_by`,
      `resolution`).
    - The collision does **not** block the change — the user keeps the
      name, but they (and the original holder) appear in an admin
      "Flagged users" view.
    - Admin actions on a flag: **mark valid** (legitimate, e.g. same
      person on a second device — keep both, sets
      `resolution='valid'`), or **mark abuse** (e.g. impersonation —
      admin can then ban / force-rename / delete via existing actions).
    - The admin Users table needs a **"Flagged" filter** and a flag
      count badge per row. Stats banner gets an additional "Flagged"
      counter.
    - Normalisation for comparison: trim, casefold, collapse internal
      whitespace. Store the original spelling, compare on the
      normalised form (add a generated column or computed index).

---

## 4. Proposed data model

### 4.1 New table: `users`

```sql
CREATE TABLE users (
    api_key                TEXT PRIMARY KEY REFERENCES api_keys(key) ON DELETE CASCADE,
    display_name           TEXT NOT NULL UNIQUE,        -- auto-generated, unique
    in_game_name           TEXT,                        -- optional, user-provided
    is_hireable            BOOLEAN NOT NULL DEFAULT FALSE,
    is_leaderboard_visible BOOLEAN NOT NULL DEFAULT FALSE,  -- future opt-in (Q2)
    genesis_for_ip         BOOLEAN NOT NULL DEFAULT FALSE,  -- first account on this IP hash (Q3)
    joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    terms_accepted_at      TIMESTAMPTZ NOT NULL,
    terms_version          TEXT NOT NULL,
    deleted_at             TIMESTAMPTZ,                 -- soft delete (immediate, no grace)
    name_regen_count       INT NOT NULL DEFAULT 0,
    last_name_change_at    TIMESTAMPTZ
);

CREATE INDEX idx_users_joined_at         ON users (joined_at DESC);
CREATE INDEX idx_users_hireable          ON users (is_hireable) WHERE is_hireable;
CREATE INDEX idx_users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_users_ingame_trgm       ON users USING gin (in_game_name gin_trgm_ops);
```

`last_login_at` is **not** stored here — read from `api_keys.last_used_at`.

The synthetic admin user (Q4) is seeded at startup with
`api_key = ADMIN_API_KEY`, `display_name = '__admin__'`,
`terms_version = 'system'`.

### 4.2 New table: `ip_bans`

```sql
CREATE TABLE ip_bans (
    ip_hash      TEXT PRIMARY KEY,        -- HMAC-SHA256 of the IP
    reason_code  TEXT NOT NULL,           -- 'spam' | 'impersonation' | 'abuse' | 'harassment'
                                          -- | 'duplicate_account' | 'provocative_name' | 'other'
    reason       TEXT NOT NULL,           -- resolved label / custom text if reason_code='other'
    admin_notes  TEXT,                    -- optional free-text notes
    banned_by    TEXT NOT NULL,           -- admin api_key (FK to users via synthetic admin row)
    banned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL     -- default banned_at + 1 year
);

CREATE INDEX idx_ip_bans_expires_at ON ip_bans (expires_at);
```

When a ban is inserted, **all** API keys whose `bound_identity = ip_hash`
are also revoked in the same transaction (Q6: blast-radius ban).

### 4.3 New table: `user_flags`

Tracks moderation flags raised against a user (currently: duplicate
`in_game_name`; future: reports, profanity hits, etc.).

```sql
CREATE TABLE user_flags (
    id            BIGSERIAL PRIMARY KEY,
    flagged_user  TEXT NOT NULL REFERENCES users(api_key) ON DELETE CASCADE,
    related_user  TEXT REFERENCES users(api_key) ON DELETE SET NULL,
    reason        TEXT NOT NULL,           -- 'duplicate_ingame_name' | ...
    metadata      JSONB,                   -- e.g. { "name": "Seraph" }
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    resolved_by   TEXT,                    -- admin key
    resolution    TEXT                     -- 'valid' | 'abuse' | 'dismissed'
);

CREATE INDEX idx_user_flags_unresolved ON user_flags (flagged_user)
    WHERE resolved_at IS NULL;
CREATE INDEX idx_user_flags_created    ON user_flags (created_at DESC);
```

### 4.4 New table: `admin_audit_log`

```sql
CREATE TABLE admin_audit_log (
    id         BIGSERIAL PRIMARY KEY,
    admin_key  TEXT NOT NULL,
    action     TEXT NOT NULL,   -- 'delete_user' | 'ban_ip' | 'reveal_key' | ...
    target     TEXT,            -- api_key or ip_hash the action was taken against
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_created_at ON admin_audit_log (created_at DESC);
```

---

## 5. API surface

### 5.1 User-facing (auth: own API key)

| Method  | Path                             | Purpose                                                                              |
|---------|----------------------------------|--------------------------------------------------------------------------------------|
| `POST`  | `/api/account/register`          | After invite redemption + terms accept; creates `users` row, returns display name   |
| `GET`   | `/api/account/me`                | Returns account profile (display name, in-game name, hireable, dates, key)          |
| `PATCH` | `/api/account/me`                | Update `in_game_name`, `is_hireable`, `is_leaderboard_visible`                       |
| `POST`  | `/api/account/regenerate-name`   | Roll a new display name (rate-limited)                                               |
| `GET`   | `/api/account/export`            | Data export JSON (GDPR portability)                                                  |
| `DELETE`| `/api/account/me`                | Soft-delete, revoke key                                                              |

### 5.2 Admin-facing (auth: admin key)

| Method  | Path                                          | Purpose                                                                                  |
|---------|-----------------------------------------------|------------------------------------------------------------------------------------------|
| `GET`   | `/api/admin/users`                            | Keyset-paginated list; supports `q`, `sort`, `cursor`, filters: `flagged`, `banned`, `genesis` |
| `GET`   | `/api/admin/users/stats`                      | Banner counts (cached 60 s) — includes Flagged counter                                  |
| `GET`   | `/api/admin/users/{api_key}`                  | Full user detail incl. raw key (audit-logged)                                            |
| `GET`   | `/api/admin/users/{api_key}/siblings`         | List all `users` rows sharing the same `bound_identity` IP hash (Q3 investigation tool) |
| `DELETE`| `/api/admin/users/{api_key}`                  | Force soft delete                                                                        |
| `POST`  | `/api/admin/users/{api_key}/rekey`            | Recovery: bind the `users` row to a freshly issued API key, revoke old key (Q5)         |
| `POST`  | `/api/admin/users/{api_key}/reactivate`       | Clear `deleted_at`, un-revoke key (Q9 manual reactivation)                              |
| `POST`  | `/api/admin/users/{api_key}/ban`              | Body: `{ reason_code, reason?, admin_notes? }`. Bans the user's bound IP hash, revokes every key on that hash (Q6 blast-radius). Returns the affected-account list. |
| `GET`   | `/api/admin/users/{api_key}/ban-preview`      | Dry-run — returns the list of accounts that would be revoked, for the confirm modal    |
| `GET`   | `/api/admin/ip-bans`                          | Paginated list of active bans (for the Banned IPs UI)                                    |
| `DELETE`| `/api/admin/ip-bans/{ip_hash}`                | Unban                                                                                    |
| `GET`   | `/api/admin/flags`                            | List user_flags rows; filters: `unresolved`, `reason`                                    |
| `POST`  | `/api/admin/flags/{id}/resolve`               | Body: `{ resolution: 'valid'\|'abuse'\|'dismissed' }`                                    |

All admin endpoints write to `admin_audit_log`.

### 5.3 Middleware changes

- New dependency `require_active_user` that:
  1. Resolves the key (existing `verify_api_key_info`).
  2. Looks up the `users` row; 403 if `deleted_at IS NOT NULL`.
  3. Checks `ip_bans` for the current request's IP hash; 403 if banned.
- Applied to all non-public endpoints.

---

## 6. Frontend changes

- New route `/account` with sections: Identity, API Key, Preferences
  (Hireable, future Leaderboard opt-in), Data export, Danger Zone
  (typed-confirmation delete, no grace period).
- New admin route `/manage/users`:
  - Table with search, sort dropdown, infinite scroll (20/page).
  - Stats banner with **Refresh** button (server cache 60 s).
  - Filters: All / Flagged / Banned / Genesis-on-shared-IP.
  - Per-row badges: "Genesis", "Flagged (n)", "Banned", "Hireable".
  - Row actions behind confirm modals: View detail, Reveal API key,
    Delete, Reactivate, Rekey, Ban.
  - **Ban modal** captures: reason dropdown (predefined codes), custom
    reason if `other`, optional admin notes, **blast-radius preview**
    showing every account about to be revoked.
  - **User detail drawer** shows the user's `users` row plus a
    "Sibling accounts on same IP" panel (calls `/siblings`) so the
    admin can investigate alts.
- New admin route `/manage/banned-ips`:
  - List of active bans with reason, notes, banned_by, banned_at,
    expires_at, and an Unban button (confirm modal).
- New admin route `/manage/flags`:
  - List of unresolved `user_flags` with quick-resolve buttons
    (Valid / Abuse / Dismiss). Abuse links to the user detail drawer
    for follow-up actions.
- Terms acceptance modal on first load after invite redemption; writes
  `terms_accepted_at` / `terms_version` via `/api/account/register`.
- Recovery file download button on `/account` + warning text that
  there is no automated recovery.
- Update `README.md` and `TERMS_AND_PRIVACY_PLAN.md` to reflect new
  personal-data fields (in-game name, hireable flag, leaderboard
  opt-in, IP-ban retention, no deletion grace period).

---

## 7. Rollout order (suggested)

1. Schema migration (`users`, `ip_bans`, `user_flags`,
   `admin_audit_log`, trigram indexes, `pg_trgm` extension).
2. Backfill:
   - One `users` row per existing API key, auto-generated display name,
     `terms_accepted_at = now()`, `terms_version = 'backfill'`.
   - Mark the **earliest** account on each `bound_identity` as
     `genesis_for_ip = TRUE`.
   - Seed the synthetic `__admin__` user.
3. Account endpoints (`register`, `me`, `export`, `delete`,
   `regenerate-name`) + per-key rate limits on `regenerate-name` and
   `PATCH /me`.
4. `require_active_user` middleware: deleted check + IP-ban check.
5. Duplicate-name flag insertion on PATCH (writes to `user_flags`).
6. Account page UI + terms modal + recovery-file download.
7. Admin endpoints (`users` list/detail/siblings/stats, `ban` with
   blast-radius, `ban-preview`, `ip-bans` list, `unban`, `flags`,
   `rekey`, `reactivate`) + `admin_audit_log` writes.
8. Admin Users page UI + stats banner (with Refresh button) + ban modal
   with reason picker.
9. Admin Banned-IPs page UI + admin Flags page UI.
10. Nightly cleanup job for expired IP bans.
11. Docs + privacy-policy updates.
