# Vintage Story Waypoint Tools

Web application for extracting, importing, deleting, and generating commands for Vintage Story waypoints.

## Project Structure

```
├── backend/         FastAPI backend + CLI tools
│   ├── app/         Web API (FastAPI)
│   │   ├── core/    Shared protobuf, waypoint, gamedata modules
│   │   └── routes/  API endpoints (extract, import, delete, commands)
│   ├── *.py         Original CLI scripts (still functional)
│   └── README.md    CLI documentation
├── frontend/        React + TypeScript + Tailwind + shadcn/ui
└── LICENSE          Proprietary — all rights reserved
```

## Quick Start

### Backend

```bash
pip install -r backend/requirements.txt
```

Copy the example `.env` file and set your API keys:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your own API keys
```

```bash
# Run (from project root)
python -m uvicorn app.main:app --reload --app-dir backend
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server proxies `/api` requests to `http://localhost:8000`.

## API Endpoints

All endpoints require an `X-API-Key` header. Rate limited to 5 requests per hour per key.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/extract` | Extract waypoints from a .vcdbs file |
| POST | `/api/import` | Import waypoints into a .vcdbs file |
| POST | `/api/delete` | Delete matching waypoints from a .vcdbs file |
| POST | `/api/commands` | Generate `/waypoint addati` commands |
| GET | `/api/health` | Health check |

## Environment Variables

Set these in `backend/.env` (see `backend/.env.example`). Environment variables also work and take precedence over the `.env` file.

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEYS` | *(required)* | Comma-separated valid API keys |
| `RATE_LIMIT_MAX` | `5` | Max requests per window |
| `RATE_LIMIT_WINDOW` | `3600` | Window in seconds |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS allowed origins |
| `MAX_UPLOAD_SIZE` | `104857600` | Max upload size (bytes) |

## License

Proprietary. All rights reserved by the operator. The source code is provided
for reference only; you may not copy, modify, distribute, or use it to operate
a competing service without the operator's prior written permission. See the
`LICENSE` file for full terms.
