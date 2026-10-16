# Architecture

## Overview

**The Cairn** is a full-stack web toolkit for **Vintage Story** — a community
webmap, save-file/waypoint utilities, a player-driven map-feature database, a
server-economy market analytics suite, and a full admin/moderation back office.
It consists of two independently deployed services — a React frontend and a
Python/FastAPI backend — that communicate over HTTP REST, backed by object
storage, a relational database, and a set of in-process background workers.

```
┌───────────────────────────────────────────────────────────────────────┐
│                           Browser (User)                              │
│   React 19 + Vite SPA (TypeScript) · Deployed on Vercel               │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTPS · REST JSON /api/*
                                │ X-API-Key header (admin: passkey session)
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│                 FastAPI backend (Python 3.12, Uvicorn)                 │
│                 Deployed on Render · ~55 API routers                   │
│                                                                       │
│  Waypoint/save-file · Map rendering · TOPS webmap · Contributions     │
│  Translocators · Traders · Landmarks · Map-features · Elk roads       │
│  Market/economy · Backups · Usage analytics · Admin/auth              │
│                                                                       │
│  Background workers (threads): validate · match-score · approve ·     │
│  revert · map regen · weekly backups · OCR · auction/feature rebuild  │
│  · history cleanup · leader election                                  │
└───────────────┬───────────────────────────────────────┬───────────────┘
                │                                       │
                ▼                                       ▼
┌────────────────────────────┐          ┌──────────────────────────────────┐
│   Cloudflare R2 (S3 API)   │          │     Supabase PostgreSQL          │
│                            │          │                                  │
│  globalservermap.db        │          │  contributions · contribution_log│
│  pending/{id}.db / .png    │          │  api_keys · users · invite_links │
│  backups/*.db · *.geojson  │          │  feature_flags · app_settings    │
│  cache/tops-map-*.png      │          │  webauthn_credentials · ip_bans  │
│  auction/* · map-features/*│          │  admin_audit_log · backup_* · …  │
└────────────────────────────┘          └──────────────────────────────────┘
```

---

## Frontend

| Property | Detail |
|---|---|
| Language | TypeScript |
| Framework | React 19 |
| Build tool | Vite 8 |
| Styling | Tailwind CSS v4 |
| Component library | shadcn/ui (Base UI primitives) |
| Routing | React Router v7 (SPA) |
| Server state | TanStack Query v5 (with localStorage persistence) |
| Client state | Redux Toolkit |
| Charts | Recharts |
| 3D | three.js via react-three-fiber / drei (tunnel previewer) |
| Auth (admin) | SimpleWebAuthn browser (passkeys) + TOTP (QR via `qrcode`) |
| i18n | Custom provider, English + Russian |
| Deployment | Vercel (SPA, all routes rewrite to `index.html`) |
| Dev port | 5173 |

### Structure

```
src/
  App.tsx           — query client, cache persistence, auth-rejection handling
  components/
    AppContent.tsx  — navigation shell + route table
    ui/             — shadcn/ui primitives (Button, Badge, Dialog, …)
    …               — feature modules (contribute-tls, usage, tops-map-viewer, …)
  pages/
    singleplayer/   — Extract, Import, Commands, Delete
    multiplayer/    — IdentifyMaps, MapView, TOPSMapView, Contribute{Map,TLs,Traders}
    tools/          — Tunnel, WaypointMacro, Alloy/Charcoal calculators
    market/         — Overview, Listings, Items, Players, Orders, Inflation, …
    rarity/         — Rocks, LootPools
    audit/          — admin moderation (Translocators, Traders, Landmarks, Backups, …)
    admin/          — Manage (ApiKeys, Users, BannedIps, FeatureFlags, Usage, …)
    blog/           — localized posts (EN + RU)
    public/, other/ — RoadWorkers, Account, Preferences, Download, Terms, Privacy
  lib/
    api.ts          — all fetch calls to the backend
    i18n/           — translation provider + dictionaries
    vs-icons.ts     — Vintage Story icon mappings
    identify-maps.ts— client-side map hash logic
  hooks/, store/, models/, workers/
```

### Backend Communication

All API calls go through `src/lib/api.ts`. Every request includes an `X-API-Key`
header read from `localStorage`. In development, Vite's proxy forwards `/api/*`
to `http://localhost:8001`, so the frontend never needs to know the backend URL
directly. In production, `VITE_API_BASE` is set to the Render service URL.

TanStack Query results are persisted to `localStorage` (opt-in per query via
`meta.persist`) so cached TOPS-map chunk URLs and WebCartographer overlays
survive reloads. A global `auth-rejected` event (dispatched by `api.ts` on a
`401`) purges both the in-memory and persisted caches.

### Admin Detection & Elevation

After saving an API key, the frontend calls `GET /api/me`. If the response marks
the key as admin, a gold **Admin** badge is shown and the status is persisted.
Sensitive admin actions additionally require an elevated **passkey session**
(WebAuthn) or **TOTP** step, negotiated through the admin dialogs.

---

## Backend

| Property | Detail |
|---|---|
| Language | Python 3.12 |
| Framework | FastAPI |
| Server | Uvicorn (ASGI) |
| Deployment | Render (web service) |
| Port | 8001 (dev) / `$PORT` (Render) |
| Config | Environment variables (`.env` locally, Render dashboard in prod) |
| DB access | psycopg2 connection pool → Supabase PostgreSQL |
| Object store | boto3 → Cloudflare R2 (S3-compatible) |

The app is assembled in `app/main.py`, which registers ~55 routers under the
`/api` prefix and manages the application **lifespan** — initialising the DB,
and starting/stopping the background workers (see
[Background Workers](#background-workers)).

### Authentication & Authorization

Auth lives in `app/auth.py` and is considerably richer than a single env-var
check:

- **API keys** are stored in the Supabase `api_keys` table (not just the
  `API_KEYS` env var) and resolved per-request by `verify_api_key`. Keys carry a
  coarse tier (`read` / `contribute`) plus **granular per-key permissions**
  (e.g. `region_overwrite`), enforced by `verify_permission` / `require_permission`.
- **Admin elevation** is layered:
  - `require_admin` — admin key,
  - `require_admin_passkey` — admin key **plus** an active WebAuthn passkey
    session,
  - `require_admin_critical` — the strictest path for destructive actions.
- **TOTP** (`pyotp`) enrolment/verification with encrypted secrets
  (Fernet), per-key throttling, and short-lived admin sessions.
- **WebAuthn passkeys** (`webauthn`) with credentials in
  `webauthn_credentials`; enforcement is controlled by `WEBAUTHN_ENFORCE`.
- **Publish tokens** (`require_publish_token` / `require_publisher`) gate the
  program-download and auction-webhook ingest paths.
- Per-IP **rate limiting** (`rate_limiter.py`) and **IP bans** (`ip_bans`).

### Route Modules

~55 routers, all mounted under `/api`. Grouped by domain:

| Domain | Routers (prefix) | Purpose |
|---|---|---|
| Save-file tools | `extract` `/extract`, `import_wp` `/import`, `delete` `/delete`, `commands` `/commands` | Extract/merge/delete waypoints; generate `/waypoint` commands |
| Map rendering | `mapview` `/mapview`, `tops_map_r2` `/tops-map` | Render client `.db` → PNG; serve cached TOPS tiles |
| Map contributions | `contribute_r2` `/contribute`, `contribute_region` | Community map upload → review → merge; region overwrite |
| Translocators | `contribute_tls`, `contribute_tls_screenshots` `/contribute-tls…`, `landmarks`, `boat_tls` | Chat-log / manual / screenshot submissions; landmarks; boat TLs |
| Traders | `contribute_traders`, `trader_claim_types`, `trader_claim_empty`, `contribute_map_features` | Trader + claim contributions and map-feature traders |
| Roads / routing | `elk_walkable`, `public_road_workers`, `route_analytics`, `grouping_library`, `webcartographer` | Elk-walkable roads, route planner analytics, overlay grouping |
| Market / economy | `contribute_auctions`, `contribute_auction_events`, `orders` | Auction ingest, order book |
| Accounts | `account`, `invite`, `licenses` | Registration, invites, signed licenses |
| Usage | `usage_ingest`, `admin_usage` `/usage` | Client telemetry ingest + dashboards |
| Backups | `admin_backups` `/admin/backups`, `admin_backups_extra`, `public_backup_download` `/public` | Snapshot create/restore/retention + public share links |
| Admin core | `admin`, `admin_users`, `admin_settings`, `admin_feature_flags`, `admin_heavy_compute`, `maintenance`, `resources` `/admin/resources`, `admin_program` | Users, flags, settings, maintenance, resources, program downloads |
| Admin audit | `admin_contributions`, `admin_translocators`(+`_screenshots`), `admin_traders`, `admin_landmarks`, `admin_map_features`, `admin_elk_walkable`, `admin_route_planner`, `admin_auction_sources` | Per-category moderation |
| Admin security | `admin_totp` `/admin/totp`, `admin_webauthn` `/admin/webauthn` | TOTP + passkey enrolment |
| Public | `public_program_download`, `public_road_workers` | Unauthenticated download/road endpoints |

### Core Modules

| Module | Responsibility |
|---|---|
| `core/waypoint.py` | Encode/decode Vintage Story waypoint protobuf messages |
| `core/protobuf.py` | Low-level protobuf varint parser/encoder (no generated code) |
| `core/mapdb.py` | Decode VS client map SQLite `.db` → PNG via NumPy (vectorized, ~100× faster than pure Python) |
| `core/mapdb_cache.py` | Cache layer for decoded map data |
| `core/config_reader.py` | Parse VS save-file config format |
| `core/gamedata.py` / `display_names.py` | Static VS game-data + label lookups |
| `core/r2_storage.py` | boto3 wrapper for Cloudflare R2 (presigned URLs, server-side copy) |
| `core/database.py` | psycopg2 connection pool, schema bootstrap, feature-flag seed |
| `core/accounts_db.py`, `orders_db.py`, `saved_routes_db.py`, `planned_routes_db.py`, `grouping_library_db.py` | Domain-specific DB access layers |
| `core/feature_flags.py` | Cached boolean/int flag reads + operational kill switches |
| `core/compression.py` | zstd compression for map DBs, backups, archives |
| `core/auction_*` / `map_features_*` (`raw_store`, `merge`, `rebuild`) | Economy + map-feature ingest/merge/rebuild engines |
| `core/boat_tls_store.py`, `elk_walkable_store.py` | GeoJSON stores for boat TLs / elk roads |
| `core/screenshot_pipeline.py` | OCR + minimap analysis for translocator screenshots |
| `core/license_signing.py` | Sign/verify license files (`cryptography`) |
| `core/leader_election.py`, `generation_tracker.py`, `upload_dedup.py`, `usage_events.py`, `api_key_cache.py` | Multi-instance coordination, caching, dedup, telemetry |
| `config.py` | Centralised `Settings` class reading all env vars |
| `auth.py` | API-key / admin / TOTP / passkey dependencies |
| `rate_limiter.py` | In-memory per-IP rate limiting |

### Background Workers

Started and stopped by the FastAPI lifespan (`app/main.py`) and living in
`app/tasks/`. On a multi-instance deploy, `leader_election` ensures only one
instance runs the singleton jobs.

| Worker | Role |
|---|---|
| `validate_uploads.py` | Validate newly uploaded contribution `.db` files |
| `match_score.py` | Score pending contributions against the combined map |
| `approve_contribution.py` / `revert_contribution.py` | Merge or roll back a contribution (resumable) |
| `generate_map_levels.py` | Re-render TOPS map tiles for changed chunks |
| `weekly_backup.py` | Scheduled + manual snapshots and retention (see below) |
| `process_tl_screenshot_request.py` | Run OCR/minimap pipeline on queued screenshots |
| `auction_rebuild` / `map_features_rebuild` | Debounced economy/map-feature rebuilds |
| `heavy_compute_poller.py` | Drain queued heavy jobs when `heavy_compute_enabled` |
| `cleanup_history.py` / `prune_layer_events.py` / `dedupe_archive.py` / `compress_workers.py` | Retention, telemetry pruning, archive dedup, compression |

---

## External Services

### Cloudflare R2 (Object Storage)

R2 is the primary binary store. It holds:

- `globalservermap.db` — the combined community map database (SQLite; optional
  `.zst` companion when `compress_artefacts` is ON)
- `pending/{id}.db` / `pending/{id}.png` — pending contribution DBs + previews
- `cache/tops-map-*.png` — pre-rendered TOPS map viewer tiles
- `backups/backup-*.db` and `backups/{landmarks,translocators,traders,…}-*.geojson`
  — scheduled/manual snapshots
- `auction/*` and `map-features/*` — economy and map-feature datasets

Access is via the S3-compatible API using boto3. For large uploads the backend
issues a **presigned PUT URL** so the browser uploads directly to R2, bypassing
backend memory; snapshots use R2 **server-side copy** (atomic, no download).

### Supabase PostgreSQL (Relational Database)

PostgreSQL stores all structured metadata. Tables are bootstrapped idempotently
by `core/database.py`. Key tables:

- **Contributions**: `contributions`, `contribution_log`
- **Auth / accounts**: `api_keys`, `users`, `invite_links`, `webauthn_credentials`,
  `ip_bans`, `user_flags`
- **Config / ops**: `feature_flags`, `app_settings`, `app_state`,
  `maintenance_notices`, `admin_audit_log`
- **Map pipeline**: `tops_map_chunk_urls`, `regen_queue`, `map_lock`,
  `geojson_lock`, `instance_leader`
- **Backups**: `backup_download_links`, `backup_download_log`
- **Resources**: `resources_upload_jobs`

The backend maintains a `psycopg2` connection pool initialised at startup, plus
Alembic migrations under `backend/alembic/`.

---

## Contribution Workflow

The map-contribution path (other categories follow an analogous
submit → validate → review → merge shape):

```
Browser                  Backend                  R2              PostgreSQL
   │                        │                      │                  │
   │── POST /contribute ────►│                      │                  │
   │   upload-url           │── presigned PUT URL ─►│                  │
   │◄── presigned URL ──────│                      │                  │
   │                        │                      │                  │
   │── PUT (direct) ────────────────────────────►  │                  │
   │                        │                      │                  │
   │── POST /contribute ────►│                      │                  │
   │   complete             │── validate .db ──────►│                  │
   │                        │── INSERT contribution ───────────────►  │
   │◄── contribution_id ────│                      │                  │
   │                        │ (worker) match-score + validate         │
   │ (admin) GET preview ──►│── render PNG ─────►  │                  │
   │◄── PNG ────────────────│                      │                  │
   │ (admin) POST approve ─►│ (worker) merge DBs ─► │                  │
   │                        │── UPDATE status ─────────────────────►  │
   │                        │ (worker) regen TOPS tiles for changed   │
   │                        │          chunks (if auto_regen enabled) │
```

Public submission endpoints are gated by feature flags (`uploads_enabled`,
`translocator_contributions`, `manual_translocators`,
`translocator_screenshot_contributions`, trader/claim flags, …) so a category
can be enabled/disabled at runtime from the admin **Feature Flags** page without
a redeploy. Audit and admin endpoints keep working regardless.

---

## Backup & Restore

A scheduler (`tasks/weekly_backup.py`) snapshots each community dataset into R2
under `backups/`:

- **Combined map `.db`** — `globalservermap.db`
- **Landmarks** and **translocators** — GeoJSON, fixed weekly cadence
- **Traders**, **map-feature traders**, **elk-walkable roads**, **rapids**, and
  **TOPS translocators** — per-category cadence (`weekly` / `biweekly` /
  `monthly` / `disabled`), stored under the `category_backup_schedule`
  app-setting

Capabilities: scheduled (ISO-week) + manual snapshots via R2 server-side copy;
configurable retention (`BACKUP_KEEP_SCHEDULED` / `BACKUP_KEEP_MANUAL`);
tokenized, TTL-limited **public share links** (`backup_download_links`);
**TOTP-gated restore** that reports orphaned contributions; and a full audit
trail. All backup activity respects the `weekly_backups` / `backup_restore`
feature flags.

---

## Development Setup

```
# Backend  (Python 3.12)
cd backend
pip install -r requirements.txt
cp .env.example .env   # fill in secrets
uvicorn app.main:app --reload --app-dir backend --port 8001

# Frontend
cd frontend
npm install
npm run dev            # starts on :5173, proxies /api → :8001
```

## Environment Variables (Backend)

A selection of the most important variables (see `config.py` for the full set):

| Variable | Purpose |
|---|---|
| `API_KEYS` | Comma-separated fallback API keys (keys also live in the DB) |
| `ADMIN_API_KEY` | The key that grants admin access |
| `ALLOWED_ORIGINS` / `ALLOWED_ORIGIN_REGEX` | CORS allow-list / regex |
| `SUPABASE_DB_URL` | PostgreSQL DSN for Supabase |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 credentials + bucket |
| `MAX_UPLOAD_SIZE` | Max upload size in bytes (default: 15 GiB) |
| `MAP_RENDER_MAX_DIM` | Max rendered map dimension (default: 8192) |
| `CONTRIBUTE_MAP_ID` / `CONTRIBUTE_DATA_DIR` | Community map UUID + scratch dir |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | Public rate-limit budget/window |
| `TOTP_ENCRYPTION_KEY` / `TOTP_ISSUER` | TOTP secret encryption + issuer label |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGINS` / `WEBAUTHN_ENFORCE` | Passkey relying-party config |
| `BACKUP_KEEP_SCHEDULED` / `BACKUP_KEEP_MANUAL` / `BACKUP_CHECK_INTERVAL_SECONDS` | Backup retention + scheduler cadence |
| `LICENSE_SIGNING_PRIVATE_KEY` / `PROGRAM_PUBLISH_TOKEN` | License signing + program-download publishing |
| `AUCTION_WEBHOOK_*` / `MAP_FEATURES_*` | Economy + map-feature ingest tuning |
| `RUN_SCHEDULED_JOBS` / `INSTANCE_LABEL` | Background-worker + multi-instance coordination |
| `IP_HASH_SALT` / `IP_BAN_DEFAULT_DAYS` | IP hashing + default ban duration |
