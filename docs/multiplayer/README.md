# Multiplayer — Functional Documentation

The **Multiplayer** section of the app is everything built around the `.db` map files that the Vintage Story client writes when you connect to a multiplayer server. It's the original purpose of the project — extracting and visualising the map data the game caches client-side — and now wraps four user-facing pages plus the backend pipeline that turns individual contributions into a single shared "TOPS map".

This folder is the operational reference. Other pages explain what each frontend tool does, how the backend processes uploads, why the architecture is shaped the way it is, and what to watch out for as an admin.

## Index

| Page | What's in it |
|------|--------------|
| [Map database format](./map-database-format.md) | What's actually inside a Vintage Story `.db`, how positions and tiles are encoded, why we decode the way we do |
| [Identify Maps](./identify-maps.md) | Matching `.db` files to the servers they came from using the client logs, entirely in the browser |
| [Local Map Viewer](./local-map-viewer.md) | Server-side rendering of an arbitrary user-supplied `.db` to a PNG, including the fast-preview path |
| [Contribute](./contribute.md) | Upload pipeline, validation, preview, cooldown rules, approval/merge, withdraw/reject, archive, audit trail |
| [TOPS Map](./tops-map.md) | The shared community map — multi-resolution chunked cache, presigned URLs, partial regeneration, overlays |
| [Storage & data flow](./storage-and-data-flow.md) | Where each blob lives (R2 vs Supabase vs game client), why it's split that way |

## Quick mental model

- The four routes under `/multiplayer/*` in the frontend (`identify`, `map-viewer`, `tops-map`, `contribute`) are **independent tools** that share one underlying concept: the Vintage Story client map cache `.db`.
- Two of them are **purely local** to the user's browser — Identify Maps doesn't touch the backend at all, and Local Map Viewer only sends a single `.db` round-trip for rendering and never persists anything.
- The other two — Contribute and TOPS Map — are the **public/shared pipeline**: users upload their map cache, an admin approves it, the new tiles get merged into a single canonical `globalservermap.db`, and that combined DB is what backs the TOPS map page.
- The combined `globalservermap.db` is the single source of truth for the shared map. Every piece of TOPS-map serving infrastructure (multi-resolution caches, chunk grid, presigned URLs) is downstream of it.
- Storage is split: **`.db` files and rendered PNG chunks live in Cloudflare R2**, **metadata, presigned URL caches and progress tracking live in Supabase Postgres**. The split is in [Storage & data flow](./storage-and-data-flow.md).

## Honest caveats

- "TOPS map" is treated as a single canonical map for one specific server (`CONTRIBUTE_MAP_ID` from settings). The system is **not** designed to host multiple servers' maps side-by-side — there's exactly one `globalservermap.db`. Identify Maps is the only place that handles multiple servers, and only as a client-side correlation tool.
- Identify Maps is intentionally **not authoritative**: it's a "best guess" pairing of log timestamps to file mtimes. See [Identify Maps > Heuristic & limitations](./identify-maps.md#heuristic--limitations).
- `globalservermap.db` is downloaded to a temp file on every approve/preview/recount because all the SQLite work needs a real path. R2 is the storage of record; the local temp file is ephemeral. If you see "DB temp" in code, that's why.
- A merged contribution is **never un-merged**. There is no rollback. The only way to "undo" an approval is to manually edit `globalservermap.db` and rebuild the cache.
- The legacy local-disk versions of the contribute and tops-map routes (`contribute.py`, `tops_map.py`) still exist in the codebase but are **not mounted** — `main.py` imports the `_r2` versions under the same names. Don't be fooled by the file list.
