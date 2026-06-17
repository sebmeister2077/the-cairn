# The Cairn

Online Vintage Story webmap viewer, manager, planner and other tools. Built with FastAPI and React.

## Features

- Internal and external map viewer
- User contributed map updates
- Route planner (route/rendezvous points)
- Waypoint manager (landmarks, lore points, translocators, Terminuses, Traders, etc.)
- Map region updates (Partially developed, not yet tested)
- Extra overlays (Oceans, rock strata, climate, etc)
- Useful tools(tunnel builder)
- QOL improvements on already existing features on the official webcartographer webmap

## Local Development

Run the backend and frontend in two separate terminals from the repository root.

### Backend (FastAPI)

```powershell
python -m uvicorn app.main:app --reload --app-dir backend --port 8001
```

The API will be available at http://localhost:8001.

### Frontend (Vite + React)

```powershell
cd frontend
npm install
npm start
```

The dev server will be available at the URL printed by Vite (typically http://localhost:5173).

## Contributing
Contributions are currently off, since the official webmap is up again, But feel free to fork and make your own version of the project. If you want to contribute, please open an issue or a pull request. or DM me on discord (vintagecreeper)