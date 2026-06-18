# Plan: Global Library for TL Groupings (Community Sharing)

Turn the local-only TL groupings feature on the TOPS map into a community **library**:
users publish their groupings, others browse / search / **fork or subscribe**, upvote,
tag, and report. Backend-backed, feature-flagged, **post-moderated**. Built TL-first but
with a `content_type` + JSONB payload so it can hold landmark/waypoint collections later.

## Decisions (locked)

- **Import model**: BOTH fork (editable local copy) and subscribe (auto-syncs on publisher
  update, read-only locally).
- **Moderation**: POST-moderation — publish live, report button + admin takedown + audit log.
- **Attribution**: REQUIRE a user account AND the account must be **≥ 1 day old**
  (`users.joined_at`) to publish.
- **Discovery v1**: upvotes/likes, install/usage count, tags/categories, official/verified
  badge, search by name.
- **Scope**: TL groupings only now; `content_type` field + JSONB payload so it extends later.
- **Edit cap**: a published grouping can be changed at most **once per day** (per-grouping
  scoped rate limit; admins bypass).
- **Reputation**: each user has an activity-based reputation score shown on author cards.
- **Version history**: every publish/edit snapshots a version (append-only); users can VIEW
  history and FORK ANY past version.
- **Owner unpublish vs admin takedown** (migration `0026`): owner DELETE soft-retires to
  `status='deprecated'` (visible to existing subscribers, hidden from browse, optional
  `successor_id` pointer); admin takedown is the only path to `status='removed'`. Voluntary
  retirement does NOT lower reputation; admin takedown does.
- **Duplicate-publish detection** (migration `0026`): each grouping stores a SHA-256
  `payload_hash` of its sorted tlIds. POST publish + PATCH edit return `409 duplicate_payload`
  with `{existing: {id, name}}` when the same author already has a published grouping with
  the same TL set; the publish dialog surfaces "Edit existing / Publish a copy anyway". Pass
  `allowDuplicate: true` to override.
- **Tag normalisation + autocomplete**: tags are lower-cased, regex-validated, deduped on
  the server. The publish dialog uses a chip input with a popular-tags dropdown
  (`GET /api/groupings/library/tags/popular?q=`) so users converge on canonical tags.
- **Reputation update strategy**: hot paths (vote, install, uninstall) apply a cheap inline
  delta to `user_reputation` so the click feels instant; slow paths (publish, edit, unpublish,
  admin takedown, official toggle) schedule a full `recompute_reputation` aggregate via
  FastAPI `BackgroundTasks` so the response returns immediately.

## Architecture grounding (existing patterns reused)

- Auth: `X-API-Key` header; `require_active_user(request)` (IP-ban aware) for user writes;
  `require_admin` for admin. Author identity stored as the `api_keys.id` UUID (text), no FK
  (matches `saved_routes` / audit tables); display names resolved live via JOIN on
  `users.api_key_id`.
- Feature flags: `app.core.feature_flags` — gate whole feature → 404 when off; int flags for caps.
- Rate limiting: `check_scoped_rate_limit(key, scope, max, window)`.
- Schema via **Alembic** (head was `0024_elk_walkable_audit`); CRUD helper module mirrors
  `accounts_db.py` / `saved_routes_db.py`. Audit-style admin actions → `admin_audit_log`.
- Frontend API client: [frontend/src/lib/api.ts](../frontend/src/lib/api.ts)
  (`API_BASE`, `authHeaders()`, `handleResponse`, `ApiError`).
- Server-state fetch hooks pattern: [useElkWalkable.ts](../frontend/src/hooks/useElkWalkable.ts),
  [useTLRoute.ts](../frontend/src/hooks/useTLRoute.ts) (plain fetch, not Redux).

## Backend

### Migration `0025_grouping_library` (tables + flags)

- `shared_groupings` (head row per grouping): `id TEXT PK (uuid)`, `content_type DEFAULT
  'tl_grouping'`, `name`, `description`, `color`, `payload JSONB ({version, tlIds})`,
  `tags JSONB`, `author_api_key_id`, `is_official`, `status (published|deprecated|removed|hidden)`,
  `version`, `install_count`, `upvote_count`, `last_edited_at`, timestamps, `removed_*`.
  Indexes: `(status, upvote_count DESC)`, `(status, install_count DESC)`,
  `(status, created_at DESC)`, `(author_api_key_id)`, `(status, is_official)`, GIN on `tags`,
  trigram on `name`.
- `shared_grouping_versions` (append-only history): `id BIGSERIAL`, `grouping_id`, `version`,
  `name`, `description`, `color`, `payload`, `tags`, `edited_by_api_key_id`, `change_note`,
  `created_at`; `UNIQUE(grouping_id, version)`.
- `shared_grouping_votes`: `PK(grouping_id, voter_api_key_id)`.
- `shared_grouping_installs`: `PK(grouping_id, api_key_id)`, `mode (fork|subscribe)`,
  `forked_from_version`, `synced_version`. Index `(api_key_id, mode)` so the per-user
  subscriptions endpoint is a single index lookup. `install_count` = distinct rows.
- `shared_grouping_reports`: `id BIGSERIAL`, `grouping_id`, `reporter_api_key_id`, `reason`,
  `details`, `status (open|resolved|dismissed)`, `created_at`, `resolved_*`.
- `user_reputation` (cached aggregate): `api_key_id PK`, `reputation_score`,
  `published_count`, `total_upvotes_received`, `total_installs_received`, `official_count`,
  `updated_at`. Score = `published*2 + upvotes*3 + installs*1 + official*25` (tunable in code).
  `published_count` includes both `published` and `deprecated` (voluntary retirement doesn't
  penalise the author).

### Migration `0026_grouping_library_dedup` (dedup + soft retire)

- Adds `shared_groupings.payload_hash` (text, SHA-256 of sorted `payload.tlIds`) and a
  partial index `(author_api_key_id, payload_hash) WHERE status='published'` so duplicate
  detection is O(1).
- Adds `shared_groupings.successor_id` (text, no FK) so a deprecated grouping can point at
  its replacement.
- Backfills `payload_hash` for existing rows in Python (no `pgcrypto` dependency).
- The new `'deprecated'` status value uses the existing `status` column — no schema change.

### Feature flags

`grouping_library_enabled` (bool kill switch), `grouping_library_publish_daily_cap`
(int, default 5), `grouping_library_max_tls` (int, default 500), `grouping_library_max_tags`
(int, default 5).

### `backend/app/core/grouping_library_db.py` (new CRUD helpers)

`publish_grouping`, `edit_grouping` (+ version snapshot), `unpublish_grouping` (soft to
`deprecated`, optional `successor_id`), `set_successor`, `find_duplicate_for_author`
(payload_hash lookup), `popular_tags` (autocomplete source), `get_head`, `get_version`,
`list_history`, `browse` (q/tag/sort/official/pagination), `list_mine`, `list_subscriptions`,
`add_vote`/`remove_vote` (return author id, apply delta), `record_install`/`remove_install`
(return author id, apply delta), `_bump_reputation_delta` (cheap inline aggregate update),
`add_report`, `list_open_reports`, `resolve_report`, `admin_remove`, `set_official`,
`recompute_reputation(api_key_id)` (full aggregate — scheduled via `BackgroundTasks` from
slow-path routes), `get_reputation(api_key_id)`.

### `backend/app/routes/grouping_library.py` (gate: `grouping_library_enabled`)

Read:
- `GET /api/groupings/library` — q, tag, sort(popular|installs|recent|official),
  official_only, page, page_size → cards (id, name, desc, color, tags, author + reputation,
  tl_count, install_count, upvote_count, is_official, viewer_voted, viewer_subscribed).
- `GET /api/groupings/library/{id}` — full detail incl payload.tlIds + current version.
- `GET /api/groupings/library/{id}/history` — version list.
- `GET /api/groupings/library/{id}/versions/{version}` — full snapshot of a past version.
- `GET /api/groupings/library/mine` — viewer's published groupings.
- `GET /api/groupings/library/subscriptions` — subscribed groupings + which have newer version,
  plus `successor_id` when the publisher retired the grouping.
- `GET /api/groupings/library/tags/popular?q=` — popular tags for the publish-dialog
  autocomplete dropdown.
- `GET /api/users/{api_key_id}/reputation` — public reputation summary.

User write (`require_publisher` = active user + account ≥ 1 day; per-action rate limits;
slow paths use FastAPI `BackgroundTasks` to schedule `recompute_reputation` after the
response is sent so the UI feels instant):
- `POST /api/groupings/library` — publish (validate name/desc/tags/tlIds caps + dedupe; checks
  `payload_hash` against the author's published rows and returns `409 duplicate_payload`
  with `{existing: {id, name}}` unless `allowDuplicate: true`); writes head + version 1;
  scoped cap `grouping-library-publish`; recompute reputation in BG.
- `PATCH /api/groupings/library/{id}` — owner/admin edit. EDIT CAP via
  `check_scoped_rate_limit(key, f"grouping-edit:{id}", 1, 86400)` (admins bypass); bumps
  version + appends snapshot (optional change_note); updates head + last_edited_at +
  `payload_hash`. Same duplicate check as POST when `tlIds` changes (excluding self).
- `DELETE /api/groupings/library/{id}` — owner soft-retire → `status='deprecated'`. Body
  accepts optional `{successorId}` pointing at a replacement; subscribers see this on
  `subscriptions`. Voluntary retirement does NOT lower reputation.
- `POST/DELETE /api/groupings/library/{id}/vote` — upvote / remove (one per user). Hot path:
  inline reputation delta + BG full recompute.
- `POST /api/groupings/library/{id}/install` — `{mode, version?}`; fork copies chosen version
  (default current; any past allowed) recording forked_from_version; subscribe tracks
  synced_version=current; dedup install_count. Allowed for `published` AND `deprecated`
  groupings so existing subscribers can re-sync after a retirement. Hot path: inline
  reputation delta + BG full recompute.
- `DELETE /api/groupings/library/{id}/install` — uninstall/unsubscribe.
- `POST /api/groupings/library/{id}/report` — `{reason, details}`; rate-limited.

Admin (`require_admin`, log to `admin_audit_log`):
- `GET /api/admin/groupings/reports` — open reports queue.
- `POST /api/admin/groupings/{id}/remove` — takedown → action `grouping.remove`.
- `POST /api/admin/groupings/{id}/official` — toggle badge → `grouping.official`.
- `POST /api/admin/groupings/reports/{id}/resolve` → `grouping.report.resolve`.

### Account-age gate

`require_publisher(request)` in `auth.py` = `require_active_user` + check
`users.joined_at <= now() - 1 day`, else 403 code `account_too_new`.

### Wiring

Register router in [backend/app/main.py](../backend/app/main.py); add open-report count to the
admin pending-counts badge.

## Frontend

- **Types** — extend `TLGrouping` in [tl-groupings.ts](../frontend/src/lib/tl-groupings.ts)
  with optional `source?: { libraryId, author?, version, mode: "fork" | "subscribe" }`.
  Subscribe-mode groupings are read-only in the drawer and refreshed on load.
- **API client** — add library functions to [api.ts](../frontend/src/lib/api.ts): browse,
  detail, history, version, mine, subscriptions, reputation, publish, update, unpublish,
  vote/unvote, install(mode, version?)/uninstall, report; admin: reports, remove, official,
  resolve.
- **Hook** — new `frontend/src/hooks/useGroupingLibrary.ts` (fetch pattern, not Redux):
  browse/search/sort state, pagination, viewer vote/subscription state, history fetch.
- **Components** — new `frontend/src/components/tops-map/library/`:
  - `GroupingLibraryDialog.tsx` — search bar, tag chips, sort dropdown, official toggle,
    paginated cards (name, author + reputation badge, tags, counts, official badge,
    Import(fork)/Subscribe, vote, overflow: report, View history). Mine + Subscriptions tabs
    show a "Deprecated" badge for retired groupings and surface `successor_id` when present.
  - `PublishGroupingDialog.tsx` — name/description/color + chip-based tag input with
    autocomplete (`TagInput`) + optional change_note on edits; eligibility +
    once-per-day edit-cap cooldown states; dedicated 409-`duplicate_payload` UI offering
    "Edit existing" / "Publish a copy anyway" (retries with `allowDuplicate: true`).
  - `TagInput.tsx` — chip editor with popular-tags dropdown (driven by `usePopularTags`).
  - `GroupingHistoryDialog.tsx` — version timeline with "Fork this version" + added/removed-TL
    diff summary.
  - `ReputationBadge.tsx` — score + tier label.
- **Integrate into** [TLGroupingsDrawer.tsx](../frontend/src/components/tops-map/TLGroupingsDrawer.tsx):
  "Browse library" button; per-grouping "Publish to library"; fork → editable local grouping
  with `source.mode='fork'`; subscribe → read-only synced grouping; on load, refresh
  subscriptions whose version is newer.
- **Feature gating** — hide library UI when flag off (endpoint 404 / `checkAuthStatus`); show
  Publish CTA only when eligible.

## Community-benefit highlights

1. Official/verified curated collections (admin badge): "Main TL Highway", "Spawn Network".
2. Subscribable auto-updating community-maintained networks (publisher edits propagate).
3. Fork-to-customize without losing the original.
4. Discovery via upvotes + install counts; tags for Spawn/Trade/Region/Elk-friendly.
5. Attribution builds maker reputation, aided by the account-age gate against spam.
6. Report + admin takedown + audit log keeps content clean with low friction.
7. Synergy: "Elk-friendly" tag + future link to elk-walkable attestations; Traverse-mode
   (todos) can consume library groupings directly.
8. Edit cap (1/day per grouping) keeps subscribers stable, discourages vandalism, and makes
   version history meaningful (one deliberate update/day, not spammy micro-edits).
9. Activity-based reputation rewards quality contributors and adds a light gamification loop.
10. Full version history + fork-any-version: nothing is ever lost; roll back, compare, or fork
    an older state if a maintainer's update doesn't suit you.

## Verification

1. Backend: flag on + account ≥ 1 day → publish 200; new account → 403 `account_too_new`;
   flag off → 404; over daily cap → 429.
2. Browse: search by name, tag filter, sorts (popular/installs/recent), official_only.
3. Vote toggles upvote_count; fork install increments install_count once per user; subscribe
   records version. Reputation visibly updates without a perceptible delay (delta inline,
   full recompute deferred via `BackgroundTasks`).
4. PATCH bumps version; subscriber's subscriptions endpoint shows update; client sync replaces
   payload.
5. Edit cap: second PATCH on same grouping within 24h → 429; admin PATCH bypasses.
6. History: each publish/edit appends a row; history lists versions; versions/{n} returns the
   snapshot; fork-with-version creates a local grouping from that past version.
7. Reputation: publishing + upvotes/installs raise score; admin takedown lowers it; voluntary
   unpublish (deprecate) does NOT lower it.
8. Report → admin queue; admin remove → status removed, hidden, `admin_audit_log` row.
9. Admin official toggle → badge shows; audited; author official_count + reputation update.
10. Frontend: lint + build clean; full manual flow (publish → fork in another browser →
    subscribe → edit → subscriber auto-updates → history fork → report → takedown).
11. Privacy: author name respects `use_in_game_name` / display settings.
12. **Duplicate publish**: same author + same `tlIds` → 409 `duplicate_payload` with existing
    `{id, name}`; dialog shows the conflict UI; "Publish a copy anyway" succeeds.
13. **Tag autocomplete**: typing a prefix returns the most-used matching tags ordered by
    count; clicking adds a chip; Enter / comma also commits; backspace on empty input
    removes the last chip; over-cap / invalid input is silently ignored.
14. **Owner unpublish**: DELETE flips status to `deprecated`; row disappears from `browse`
    but is still readable via `/{id}` and surfaces on `subscriptions` with `status` and
    optional `successor_id`. Existing subscribers keep working; admin takedown still flips
    to `removed`.

## Out of scope (v1)

- Comments/discussion, author profile pages.
- Landmark/waypoint collections (schema-ready but not wired).
- Collaborative multi-maintainer groupings; URL-token shares; in-library diff/merge tooling.

## Further considerations

1. Author name resolved live (privacy-aware), snapshot fallback.
2. Install count dedups by distinct user via the installs table.
3. Opaque uuid ids now; add short slug later if URL-sharing is wanted.
4. Reputation recompute is synchronous per activity; formula kept in code/flags for retuning;
   tier labels (Newcomer/Contributor/Trusted/Expert).
5. Keep ALL versions (cheap JSONB); prune to last N only if size ever matters (always keep v1 +
   current).
6. Subscribers auto-apply latest with an "updated to vN" toast (the 1-edit/day cap reduces
   surprise).

## Relevant files

- [backend/alembic/versions/0025_grouping_library.py](../backend/alembic/versions/0025_grouping_library.py) — base migration.
- [backend/alembic/versions/0026_grouping_library_dedup.py](../backend/alembic/versions/0026_grouping_library_dedup.py) — payload_hash + successor_id.
- `backend/app/core/grouping_library_db.py` — CRUD helpers (dup detect, soft-deprecate,
  delta reputation, popular tags).
- `backend/app/routes/grouping_library.py` — user + admin routes (BackgroundTasks,
  duplicate-payload check, popular-tags endpoint).
- [backend/app/auth.py](../backend/app/auth.py) — `require_publisher` account-age gate.
- [backend/app/main.py](../backend/app/main.py) — register router.
- [backend/app/routes/admin.py](../backend/app/routes/admin.py) — open-report count in pending badge.
- [frontend/src/lib/tl-groupings.ts](../frontend/src/lib/tl-groupings.ts) — `source` field.
- [frontend/src/lib/api.ts](../frontend/src/lib/api.ts) — library API functions + `popularTags`.
- `frontend/src/hooks/useGroupingLibrary.ts` — server-state hooks + `usePopularTags`.
- `frontend/src/components/tops-map/library/TagInput.tsx` — chip-based tag input with autocomplete.
- `frontend/src/components/tops-map/library/PublishGroupingDialog.tsx` — chip tag input + duplicate UI.
- `frontend/src/components/tops-map/library/GroupingLibraryDialog.tsx` — deprecated badge + successor link.
- [frontend/src/components/tops-map/TLGroupingsDrawer.tsx](../frontend/src/components/tops-map/TLGroupingsDrawer.tsx) — Browse/Publish + sync.
- [docs/multiplayer/groupings-library.md](../docs/multiplayer/groupings-library.md) — feature documentation.
