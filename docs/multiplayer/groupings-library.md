# Groupings Library

> Frontend route: part of `/multiplayer/tops-map`
> Page: [frontend/src/pages/TOPSMapViewPage.tsx](../../frontend/src/pages/TOPSMapViewPage.tsx)
> Drawer: [frontend/src/components/tops-map/TLGroupingsDrawer.tsx](../../frontend/src/components/tops-map/TLGroupingsDrawer.tsx)
> Library UI: [frontend/src/components/tops-map/library/](../../frontend/src/components/tops-map/library/)
> Local model: [frontend/src/lib/tl-groupings.ts](../../frontend/src/lib/tl-groupings.ts)
> Backend routes: [backend/app/routes/grouping_library.py](../../backend/app/routes/grouping_library.py)
> Backend CRUD: [backend/app/core/grouping_library_db.py](../../backend/app/core/grouping_library_db.py)
> Migration: [backend/alembic/versions/0025_grouping_library.py](../../backend/alembic/versions/0025_grouping_library.py)
> Plan: [plans/global-groupings-library-plan.prompt.md](../../plans/global-groupings-library-plan.prompt.md)

## What it is

A **translocator (TL) grouping** is a named set of translocators a user curates on the TOPS
map — e.g. "Spawn Network", "N/S Highway", "My trade run". Groupings start out **local only**
(stored in the browser's `localStorage`, see [tl-groupings.ts](../../frontend/src/lib/tl-groupings.ts))
and can be used to filter the map down to just those TLs or to highlight them while still
rendering everything.

The **Groupings Library** is the community layer on top of that. It lets a user **publish** a
local grouping so anyone can discover it, and lets others bring a published grouping into their
own map in one of two ways:

- **Fork** — a one-time editable copy. The user owns it locally; later changes by the original
  author do *not* reach the fork.
- **Subscribe** — a read-only copy that **auto-updates** whenever the author publishes a new
  version.

Everything is gated behind the `grouping_library_enabled` feature flag. When the flag is off the
endpoints return 404 and the library UI is hidden — local groupings keep working exactly as before.

## Why a backend at all

The base groupings feature is deliberately local and account-free. The library is the one part
that needs server state because it is inherently shared: discovery, search, install/upvote
counts, attribution, moderation and the subscribe-and-sync flow can't live in one browser. So the
library is the only piece that touches Postgres; an un-published local grouping never leaves the
device.

## Identity of a TL

A grouping stores TLs by a **coordinate-tuple key**: `` `${x1},${z1},${x2},${z2}` `` (built by
`tlIdFor()` after the same geojson-load z-negation the page already applies). This key is stable
across reloads and shareable between users because everyone renders the same canonical
`translocators.geojson`. It is only fragile if the underlying TL is actually edited upstream —
handled gracefully by a "**N missing**" indicator in the drawer rather than by deleting members.

## Data model

All tables are created by migration `0025_grouping_library`. Author identity is stored as the
`api_keys.id` UUID (as text) with **no foreign key** — matching the `saved_routes` / audit-table
convention so a re-key never orphans rows. Display names are resolved **live** via a JOIN on
`users.api_key_id`, so they always respect the author's current privacy settings
(`use_in_game_name`, etc.).

| Table | Purpose |
|-------|---------|
| `shared_groupings` | The **head** (current) row per published grouping. `payload` JSONB = `{version, tlIds}`; `tags` JSONB is a string array. Denormalised `install_count` / `upvote_count`. `status` ∈ `published \| removed \| hidden`. |
| `shared_grouping_versions` | **Append-only history** — one snapshot row per publish/edit. `UNIQUE(grouping_id, version)`. Enables view-history and fork-any-version. |
| `shared_grouping_votes` | One upvote per user. `PK(grouping_id, voter_api_key_id)`. |
| `shared_grouping_installs` | One row per user who forked/subscribed. `mode` ∈ `fork \| subscribe`; `forked_from_version` (fork) / `synced_version` (subscribe). `install_count` = distinct rows. |
| `shared_grouping_reports` | Post-moderation queue. `status` ∈ `open \| resolved \| dismissed`. |
| `user_reputation` | Cached per-author activity score so browse cards can show a reputation badge without a heavy aggregate. |

### Reputation score

A small activity-derived integer, recomputed synchronously whenever a relevant event happens
(publish, edit, vote, install, takedown). The formula lives in code so it can be retuned without a
migration:

```
reputation_score = published_count * 2
                 + total_upvotes_received * 3
                 + total_installs_received * 1
                 + official_count * 25
```

The frontend maps the score to a tier label (Newcomer / Contributor / Trusted / Expert) in
`ReputationBadge`.

## Publishing rules

Publishing requires a **user account** that is **at least 1 day old** (`users.joined_at`). This is
enforced by the `require_publisher` auth dependency, which returns `403` with code
`account_too_new` otherwise. The age gate is a cheap, effective spam deterrent that also makes the
attribution + reputation system meaningful.

Other guards on publish:

- Per-key daily publish cap (`grouping_library_publish_daily_cap`, default 5/day) via
  `check_scoped_rate_limit`.
- Validation: name/description length, max tags (`grouping_library_max_tags`, default 5), max TLs
  per grouping (`grouping_library_max_tls`, default 500), tag sanitisation, member dedupe.

### The once-per-day edit cap

A published grouping can be **changed at most once every 24 hours**, enforced per grouping with
`check_scoped_rate_limit(key, f"grouping-edit:{id}", 1, 86400)`. Admins bypass it. This:

- keeps subscribers stable (no churn from rapid-fire edits),
- discourages vandalism, and
- makes each version-history entry a deliberate, meaningful update rather than spam.

A second edit inside the window returns `429`. The drawer surfaces the cooldown so users know when
they can next edit.

## Versioning & forking history

Every publish and every edit appends a full snapshot to `shared_grouping_versions` and bumps the
head `version`. Nothing is ever lost:

- `GET /api/groupings/library/{id}/history` lists all versions (version, change_note, editor, date,
  TL count).
- `GET /api/groupings/library/{id}/versions/{version}` returns a specific past snapshot.
- A user can **fork any past version** — `POST …/install` with `{mode: "fork", version: N}` copies
  that version into a new local grouping and records `forked_from_version`. This is the escape hatch
  if a maintainer's latest update doesn't suit you.

The history dialog also shows an added/removed-TL **diff summary** between the chosen version and
the current head.

## Subscribe & sync

A subscribe creates a **read-only** local grouping tagged with
`source = { libraryId, author, version, mode: "subscribe" }`. On page/app load the frontend calls
`GET /api/groupings/library/subscriptions`, and for any subscription whose head `version` is newer
than the locally synced one it replaces the local payload and shows an "updated to vN" toast.
Because of the 1-edit/day cap, these updates are infrequent and predictable.

Forks, by contrast, are normal editable local groupings tagged `source.mode = "fork"` — they never
auto-update.

## Discovery

Browse (`GET /api/groupings/library`) supports:

- **Search by name** (trigram index on `shared_groupings.name`).
- **Tags / categories** (GIN index on the `tags` JSONB) — e.g. Spawn, Trade, Region, Elk-friendly.
- **Sort**: `popular` (upvotes), `installs`, `recent`, `official`.
- **Official filter** — admin-curated verified collections carry an `is_official` badge.
- Pagination.

Each card shows the author + reputation badge, tag chips, TL count, install + upvote counts, the
official badge, and per-card actions (Import/fork, Subscribe, upvote, ⋯ → Report, View history).

## Moderation

The library is **post-moderated**: groupings go live immediately, and abuse is handled reactively.

- Any signed-in user can **report** a grouping (`POST …/report`, rate-limited).
- Reports land in an admin queue (`GET /api/admin/groupings/reports`) and feed the admin
  pending-counts badge.
- Admins can **take down** a grouping (`POST …/{id}/remove` → status `removed`, hidden from browse),
  toggle the **official** badge (`POST …/{id}/official`), and **resolve/dismiss** reports.
- Every admin action is written to `admin_audit_log` (`grouping.remove`, `grouping.official`,
  `grouping.report.resolve`), consistent with the rest of the admin surface.

## API surface

### Read

| Method & path | Returns |
|---------------|---------|
| `GET /api/groupings/library` | Paginated browse cards (q, tag, sort, official_only, page) |
| `GET /api/groupings/library/{id}` | Full detail incl. `payload.tlIds` + current version |
| `GET /api/groupings/library/{id}/history` | Version list |
| `GET /api/groupings/library/{id}/versions/{version}` | A specific past snapshot |
| `GET /api/groupings/library/mine` | Viewer's published groupings |
| `GET /api/groupings/library/subscriptions` | Viewer's subscriptions + which have a newer version |
| `GET /api/users/{api_key_id}/reputation` | Public reputation summary |

### User write (`require_publisher`)

| Method & path | Effect |
|---------------|--------|
| `POST /api/groupings/library` | Publish (writes head + v1) |
| `PATCH /api/groupings/library/{id}` | Owner/admin edit (1/day cap, bumps version + snapshot) |
| `DELETE /api/groupings/library/{id}` | Owner unpublish (status=removed) |
| `POST` / `DELETE /api/groupings/library/{id}/vote` | Upvote / remove upvote |
| `POST /api/groupings/library/{id}/install` | Fork (`{mode:"fork", version?}`) or subscribe |
| `DELETE /api/groupings/library/{id}/install` | Uninstall / unsubscribe |
| `POST /api/groupings/library/{id}/report` | File a moderation report |

### Admin (`require_admin`, audited)

| Method & path | Effect |
|---------------|--------|
| `GET /api/admin/groupings/reports` | Open reports queue |
| `POST /api/admin/groupings/{id}/remove` | Takedown |
| `POST /api/admin/groupings/{id}/official` | Toggle verified badge |
| `POST /api/admin/groupings/reports/{id}/resolve` | Resolve / dismiss a report |

## Feature flags

| Flag | Type | Default | Effect |
|------|------|---------|--------|
| `grouping_library_enabled` | bool | OFF | Kill switch — endpoints 404 + UI hidden when off |
| `grouping_library_publish_daily_cap` | int | 5 | Max publishes per key per 24h |
| `grouping_library_max_tls` | int | 500 | Max TLs per grouping |
| `grouping_library_max_tags` | int | 5 | Max tags per grouping |

## Honest caveats

- TL identity is a coordinate tuple, so a grouping can drift if the canonical
  `translocators.geojson` is edited upstream. We surface a "missing" count rather than silently
  pruning members, so the user notices without losing data.
- Reputation is recomputed synchronously on each activity. That's fine at the current scale; if it
  ever gets hot it can move to a periodic batch job without changing the public shape.
- Out of scope for v1: comments/discussion, author profile pages, collaborative multi-maintainer
  groupings, URL-token shares, and landmark/waypoint collections (the schema's `content_type` field
  is ready for the latter, but only `tl_grouping` is wired today).
