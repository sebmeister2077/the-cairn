"""POST /api/commands — Generate /waypoint addati commands from a .vcdbs or JSON."""

from fastapi import APIRouter, Depends, File, UploadFile, Form
from fastapi.responses import JSONResponse
from typing import Optional

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.config_reader import get_map_offsets
from ..core.gamedata import extract_waypoints_from_blob, read_gamedata_blob
from ..core.waypoint import filter_waypoints, generate_command

import json

router = APIRouter()


@router.post("/commands")
async def generate_commands(
    save_file: Optional[UploadFile] = File(None, description=".vcdbs save file"),
    waypoints_file: Optional[UploadFile] = File(None, description="waypoints JSON file"),
    config_file: Optional[UploadFile] = File(None, description="serverconfig.json (optional)"),
    title: Optional[str] = Form(None),
    icon: Optional[str] = Form(None),
    pinned: Optional[bool] = Form(None),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)

    if not save_file and not waypoints_file:
        return JSONResponse(
            status_code=400,
            content={"detail": "Provide either a .vcdbs save file or a waypoints JSON file"},
        )

    config_content = None
    if config_file:
        config_content = await config_file.read()

    offset_x, offset_z = get_map_offsets(config_content)

    waypoints = []

    if save_file:
        save_bytes = await save_file.read()
        gamedata_blob = read_gamedata_blob(save_bytes)
        if gamedata_blob is None:
            return JSONResponse(status_code=400, content={"detail": "No gamedata found in save file"})
        waypoints = extract_waypoints_from_blob(gamedata_blob, offset_x, offset_z)
    elif waypoints_file:
        try:
            wp_content = await waypoints_file.read()
            waypoints = json.loads(wp_content)
        except json.JSONDecodeError:
            return JSONResponse(status_code=400, content={"detail": "Invalid JSON in waypoints file"})
        if not isinstance(waypoints, list):
            return JSONResponse(status_code=400, content={"detail": "Waypoints JSON must be an array"})

    waypoints = filter_waypoints(waypoints, title=title, icon=icon, pinned=pinned)
    commands = [generate_command(wp) for wp in waypoints]

    return {"count": len(commands), "commands": commands}
