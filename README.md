# The Cairn

**The Cairn** is a full-stack web toolkit for the sandbox survival game
[Vintage Story](https://www.vintagestory.at/). It bundles a community webmap
viewer, waypoint/save-file utilities, a player-driven map-feature database, a
server-economy market analytics suite, and a full admin/moderation back office
into a single React + FastAPI application.

It is **not** a single-purpose script — it is a production web service with
dozens of user-facing tools, a multi-stage community contribution pipeline,
object storage, a relational database, background workers, OCR, feature-flag
kill switches, and a versioned backup/restore system. This README enumerates
what the project actually does so its scope is clear at a glance.

> For a deeper technical breakdown (data-flow diagrams, module responsibilities,
> external services, env vars), see [Architecture.md](./Architecture.md).

---

## What's inside

| Layer | Stack |
|---|---|
| **Frontend** | TypeScript, React 19, Vite 8, Tailwind CSS v4, shadcn/ui (Base UI), React Router v7, TanStack Query v5, Redux Toolkit, Recharts, react-three-fiber/three.js, SimpleWebAuthn |
| **Backend** | Python 3.9, FastAPI, Uvicorn (ASGI), NumPy, Pillow, boto3, psycopg2, SQLAlchemy/Alembic, RapidOCR + OpenCV, pyotp, WebAuthn, zstandard |
| **Data & infra** | Cloudflare R2 (S3-compatible object storage), Supabase PostgreSQL, Vercel (frontend), Render (backend) |
| **Custom parsing** | Hand-rolled protobuf varint codec and Vintage Story save-file / map-`.db` decoders (no generated code) |

---

## Features

### Save-file & waypoint tools (singleplayer)
- **Extract** waypoints from a Vintage Story save file
- **Import / merge** waypoints back into a save file
- **Delete** waypoints from a save file
- **Generate commands** — turn waypoint data into in-game `/waypoint` commands
- Full support for VS waypoint types (landmarks, lore points, translocators,
  terminuses, traders, base markers, etc.) via a custom protobuf codec

### Webmap viewer (multiplayer)
#### 1. Map viewer 
— render a client map `.db` file straight to PNG
  (vectorized NumPy decoder, ~100× faster than naive pure-Python)
#### 2. TOPS community webmap 
— tiled, multi-zoom map viewer served from a
  pre-rendered R2 tile cache, with live waypoint/feature overlays. 

##### Additional overlays
- **Player claims** — visualize player-claimed areas on the map (density, search and all mode)
- **Temporal stability** — display the stability in all regions based on Y level
- **Climate** — display climate zones and related data (including finding all year-round farming zones)
- **Geologic activity** — show areas of geological interest or activity
- **Precipitation** — overlay rainfall and other precipitation data
- **Oceans** — highlight ocean regions
- **Rapids** — indicate locations of rapids
- **Recorded broken translocators** — mark broken translocator locations
- **Rock strata** — display geological top-rock layers

##### Route planner & translocator management
- **Route planner** — plan complex routes across the map with multiple waypoints
- **Translocator grouping** — share and highlight translocator networks among players to reduce TL bloating


#### 3. Identify maps
 — client-side map-hash fingerprinting

### Community contribution pipeline
A multi-stage **upload → validate → review → merge** workflow, all gated behind
admin feature flags (see [Toggleable features](#toggleable-features)):
- **Map contributions** — the browser uploads a client map `.db` *directly to R2*
  via a presigned URL, the backend validates it, an admin previews a rendered
  diff, then approves/reverts to merge it into the combined community map
- **Translocator contributions** — chat-log paste, manual coordinate entry, or
  **screenshot upload with OCR + minimap analysis** (RapidOCR + OpenCV)
- **Trader contributions** — chat-log and manual entry with dedupe, claim
  typing, and authoritative-overlay support
- **Landmark, map-feature, rapids, and region contributions**
- Per-category submission quotas, cooldowns, dedupe radii, and daily caps —
  all admin-tunable at runtime

### Market & economy analytics
A complete analytics suite for server auction/trade data:
- Market overview, listings, items & per-item pages, player directory & player
  pages, orders & order detail, leaderboards
- **Inflation tracking**, price **insights**, a currency **converter**, and a
  market **map**
- Backed by a raw-data ingestion + rebuild pipeline

### Rarity & reference tools
- **Rock rarity** and **loot-pool rarity** browsers
- **Alloy calculator**, **charcoal calculator**, **tunnel previewer**, and a
  **waypoint macro** generator

### Admin & operations back office
- **Audit** pages for every contribution category (translocators, traders,
  map-feature traders, landmarks, elk-walkable roads, TL screenshots, waypoints,
  route planner)
- **Backups** overview (see [Backup system](#backup-system))
- **Manage**: API keys, users, banned IPs, flags, feature flags, maintenance
  mode, resources, licenses, program downloads
- **Usage analytics** dashboards (page views, item/player activity)
- A **blog** with per-post English/Russian localization

### Platform features
- API-key auth with coarse (read/contribute) tiers and granular per-key
  permissions
- Admin elevation via **TOTP** and **WebAuthn passkeys**
- Per-IP rate limiting, IP bans, invite codes, registration toggle
- Optional **zstd compression** for map DBs, backups, and archives
- Signed license files and program-download distribution
- i18n (English + Russian) and light/dark theming

---

## Toggleable features

Several capabilities ship **off by default** and are flipped on at runtime from
the admin **Feature Flags** page — no redeploy required. Flags live in the
Supabase `feature_flags` table with a short in-process cache
([`core/feature_flags.py`](./backend/app/core/feature_flags.py)).

Notable flags include:

| Flag | Effect when ON |
|---|---|
| `uploads_enabled` | Community map uploads accepted (kill switch, default ON) |
| `translocator_contributions` | Chat-log translocator submissions merge live |
| `manual_translocators` | Manual typed-coordinate translocator entry |
| `translocator_screenshot_contributions` | Screenshot → OCR translocator path |
| `trader_claims_viewer` / `_manual` / `_authoritative` | Trader-claim overlay + entry |
| `weekly_backups` | Scheduled snapshot creation/retention |
| `backup_restore` | Admin restore-from-backup workflow |
| `heavy_compute_enabled` | Background validation/preview/match workers run |
| `maintenance_mode` / `registration_enabled` | Operational kill switches |

Because the combined community map and contribution endpoints are feature-flag
gated, **map contributions are currently disabled but can be turned back on**
at any time from the admin panel. Audit and admin tooling keeps working
regardless of the public contribution flags.

---

## Backup system

Every community-maintained dataset has a versioned, retained backup so a bad
merge can always be rolled back. A background scheduler
([`tasks/weekly_backup.py`](./backend/app/tasks/weekly_backup.py)) snapshots
each category into R2 under `backups/`:

- **Combined map `.db`** — the map-disabled community map (`globalservermap.db`)
- **Landmarks** and **translocators** (GeoJSON, fixed weekly cadence)
- **Traders**, **map-feature traders**, **elk-walkable roads**, **rapids**, and
  **TOPS translocators** (per-category cadence: weekly / biweekly / monthly /
  disabled, configurable per category by admins)

Capabilities:
- **Scheduled** (ISO-week) and **manual** snapshots, created via R2 server-side
  copy (atomic, no download)
- Configurable **retention** for scheduled vs. manual snapshots
- **Share links** — tokenized, TTL-limited public download URLs for any snapshot
- **TOTP-gated restore** that reports orphaned contributions after a rollback
- All backup operations are written to an immutable audit trail

---

## Architecture at a glance

```
Browser (React + Vite SPA, Vercel)
      │  HTTPS · REST /api/* · X-API-Key
      ▼
FastAPI backend (Uvicorn, Render)
      ├── Waypoint / save-file routes      (protobuf codec)
      ├── Map rendering routes             (NumPy .db → PNG)
      ├── Contribution routes              (upload → review → merge)
      ├── Market / analytics routes        (ingest → rebuild)
      ├── Admin / audit / backup routes    (TOTP + WebAuthn)
      └── Background workers               (validation, OCR, map regen, backups)
      │                              │
      ▼                              ▼
Cloudflare R2                  Supabase PostgreSQL
(map DBs, tiles, previews,     (contributions, feature flags,
 backups, uploads)             users/keys, market data, app state)
```

See [Architecture.md](./Architecture.md) for the full diagrams, route/module
tables, external-service details, and the contribution-workflow sequence.

### Repository layout

```
backend/            FastAPI service
  app/
    routes/         ~55 API routers (public + admin)
    core/           protobuf, map decoder, R2, DB, merge engines, feature flags
    tasks/          background workers (backups, OCR, map regen, validation …)
    db/, migrations.py, auth.py, rate_limiter.py, config.py
  alembic/          database migrations
  *.py              operational / data-processing scripts
frontend/           React + Vite SPA
  src/
    pages/          singleplayer, multiplayer, tools, market, rarity,
                    audit, admin, blog, public, other
    components/     shared UI + feature modules + shadcn/ui primitives
    lib/            api client, i18n, VS icon maps, map identification
    hooks/, store/, models/, workers/
docs/, plans/, ideas.md, todos.md   design notes & planning
```

---

## Local development

Run the backend and frontend in two separate terminals from the repository root.

### Backend (FastAPI)

```powershell
cd backend
pip install -r requirements.txt
Copy-Item .env.example .env   # then fill in secrets
python -m uvicorn app.main:app --reload --app-dir backend --port 8001
```

The API is served at http://localhost:8001. See
[Architecture.md](./Architecture.md#environment-variables-backend) for the full
list of environment variables (`API_KEYS`, `ADMIN_API_KEY`, `SUPABASE_DB_URL`,
`R2_*`, rate-limit and upload settings, etc.).

### Frontend (Vite + React)

```powershell
cd frontend
npm install
npm run dev
```

Vite serves the SPA (typically http://localhost:5173) and proxies `/api/*` to
the backend on `:8001`, so the frontend never needs the backend URL directly.
In production, `VITE_API_BASE` points at the Render service.

---

## Contributing

Public contributions are currently **off** (the official webmap is live again),
but you're welcome to **fork and run your own instance** — the contribution
pipeline can be re-enabled from the admin Feature Flags page. If you'd like to
contribute upstream, open an issue or pull request, or DM me on Discord
(**vintagecreeper**).

## License

See [LICENSE](./LICENSE).
