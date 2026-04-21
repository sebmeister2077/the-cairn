# Architecture

## Overview

The project is a web toolkit for managing **Vintage Story** waypoints and map data. It consists of two independent services — a React frontend and a Python/FastAPI backend — deployed on separate hosting platforms and communicating over HTTP REST.

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser (User)                        │
│                                                              │
│   React + Vite SPA (TypeScript)                              │
│   Deployed on Vercel                                         │
└─────────────────────────┬────────────────────────────────────┘
                          │ HTTPS  (X-API-Key header)
                          │ REST JSON  /api/*
                          ▼
┌──────────────────────────────────────────────────────────────┐
│           FastAPI backend (Python 3.9)                       │
│           Deployed on Render (uvicorn)                       │
│                                                              │
│  ┌─────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │  Waypoint   │  │   Map rendering  │  │  Contribution  │  │
│  │  routes     │  │   routes         │  │  routes        │  │
│  └─────────────┘  └──────────────────┘  └───────┬────────┘  │
│                                                  │           │
└──────────────────────────┬───────────────────────┼───────────┘
                           │                       │
             ┌─────────────┘                       │
             ▼                                     ▼
┌────────────────────┐              ┌──────────────────────────┐
│  Cloudflare R2     │              │  Supabase PostgreSQL     │
│  (S3-compatible)   │              │                          │
│                    │              │  - contributions         │
│  globalservermap   │              │  - contribution_log      │
│  .db (community    │              │  - app_state             │
│  map)              │              └──────────────────────────┘
│  pending/{id}.db   │
│  pending/{id}.png  │
│  cache/tops-map-   │
│  *.png             │
└────────────────────┘
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
| Routing | React Router v7 |
| Data fetching | TanStack Query v5 |
| Deployment | Vercel (SPA, all routes rewrite to `index.html`) |
| Dev port | 5173 |

### Structure

```
src/
  pages/          — one component per tool page
  components/     — shared UI (ApiKeyDialog, FileUpload, WaypointTable, …)
  components/ui/  — primitive building blocks (Button, Badge, Dialog, …)
  lib/
    api.ts        — all fetch calls to the backend
    utils.ts      — Tailwind class helpers
    vs-icons.ts   — Vintage Story icon mappings
    identify-maps.ts — client-side map hash logic
```

### Backend Communication

All API calls go through `src/lib/api.ts`. Every request includes an `X-API-Key` header read from `localStorage`. In development, Vite's proxy forwards `/api/*` to `http://localhost:8001`, so the frontend never needs to know the backend URL directly. In production, `VITE_API_BASE` is set to the Render service URL.

### Admin Detection

After saving an API key, the frontend calls `GET /api/me`. If the response contains `"is_admin": true`, a gold **Admin** badge is displayed in the header and the status is persisted in `localStorage` across page refreshes.

---

## Backend

| Property | Detail |
|---|---|
| Language | Python 3.9 |
| Framework | FastAPI |
| Server | Uvicorn (ASGI) |
| Deployment | Render (Docker-less web service) |
| Port | 8001 (dev) / `$PORT` (Render) |
| Config | Environment variables (`.env` locally, Render dashboard in prod) |

### Authentication

Every protected route uses the `verify_api_key` FastAPI dependency (`app/auth.py`). It reads the `X-API-Key` header and checks it against the comma-separated `API_KEYS` env var. A separate `ADMIN_API_KEY` env var marks one key as admin-level; the `GET /api/me` endpoint compares the incoming key against it to return `is_admin`.

### Route Modules

| Router | Prefix | Purpose |
|---|---|---|
| `extract.py` | `/api/extract` | Parse a Vintage Story save file and extract waypoints |
| `import_wp.py` | `/api/import` | Merge waypoints back into a save file |
| `delete.py` | `/api/delete` | Remove waypoints from a save file |
| `commands.py` | `/api/commands` | Generate in-game `/waypoint` commands from waypoint data |
| `mapview.py` | `/api/mapview` | Render a client map `.db` file to PNG |
| `tops_map_r2.py` | `/api/tops-map` | Serve pre-rendered TOPS map tiles from R2 cache |
| `contribute_r2.py` | `/api/contribute` | Community map contribution workflow (upload → review → merge) |

### Core Modules

| Module | Responsibility |
|---|---|
| `core/waypoint.py` | Encode/decode Vintage Story waypoint protobuf messages |
| `core/protobuf.py` | Low-level protobuf varint parser/encoder (no generated code) |
| `core/mapdb.py` | Decode VS client map SQLite `.db` files → PNG via NumPy (vectorized, ~100× faster than pure Python) |
| `core/r2_storage.py` | Thin boto3 wrapper for Cloudflare R2 (S3-compatible) |
| `core/database.py` | psycopg2 connection pool for Supabase PostgreSQL |
| `core/gamedata.py` | Static Vintage Story game data lookups |
| `core/config_reader.py` | Parse VS save-file config format |
| `config.py` | Centralised `Settings` class reading all env vars |
| `auth.py` | `verify_api_key` FastAPI dependency |
| `rate_limiter.py` | In-memory per-IP rate limiting for public endpoints |

---

## External Services

### Cloudflare R2 (Object Storage)

R2 is used as the primary binary store. It holds:

- `globalservermap.db` — the combined community map database (SQLite)
- `pending/{id}.db` — individual pending contribution map databases
- `pending/{id}.png` — rendered preview images for pending contributions
- `cache/tops-map-*.png` — pre-rendered TOPS map viewer tiles

The backend accesses R2 via the S3-compatible API using boto3. For large user uploads, the backend can issue a **presigned upload URL** so the browser uploads directly to R2, bypassing the backend's memory entirely.

### Supabase PostgreSQL (Relational Database)

PostgreSQL (hosted on Supabase) stores structured metadata about the contribution workflow:

- `contributions` — one row per uploaded contribution (status: `pending` / `approved` / `rejected`)
- `contribution_log` — immutable log of approved merges with tile counts
- `app_state` — key/value pairs (e.g. cached total tile count)

The backend maintains a `psycopg2` connection pool (1–5 connections) initialised at startup.

---

## Contribution Workflow

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
   │                        │                      │                  │
   │ (admin) GET preview ──►│── render PNG ─────►  │                  │
   │◄── PNG ────────────────│                      │                  │
   │                        │                      │                  │
   │ (admin) POST approve ─►│── merge DBs ─────►   │                  │
   │                        │── UPDATE status ─────────────────────►  │
```

---

## Development Setup

```
# Backend
cd backend
pip install -r requirements.txt
cp .env.example .env   # fill in secrets
uvicorn app.main:app --reload --port 8001

# Frontend
cd frontend
npm install
npm run dev            # starts on :5173, proxies /api → :8001
```

## Environment Variables (Backend)

| Variable | Purpose |
|---|---|
| `API_KEYS` | Comma-separated list of valid API keys |
| `ADMIN_API_KEY` | The one key that grants admin access |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) |
| `ALLOWED_ORIGIN_REGEX` | CORS origin regex (e.g. `https://.*\.vercel\.app`) |
| `SUPABASE_DB_URL` | PostgreSQL DSN for Supabase |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | R2 bucket name (default: `vs-waypoints`) |
| `RATE_LIMIT_MAX` | Max requests per window (default: 5) |
| `RATE_LIMIT_WINDOW` | Rate limit window in seconds (default: 3600) |
| `MAX_UPLOAD_SIZE` | Max upload size in bytes (default: 4 GB) |
| `CONTRIBUTE_MAP_ID` | UUID identifying the community map |
| `CONTRIBUTE_DATA_DIR` | Local directory for contribution scratch space |
