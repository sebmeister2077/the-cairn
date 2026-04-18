"""POST /api/extract — Extract waypoints from a .vcdbs save file."""

from fastapi import APIRouter, Depends, File, UploadFile, Form
from fastapi.responses import JSONResponse
from typing import Optional

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.config_reader import get_map_offsets
from ..core.gamedata import extract_waypoints_from_blob, read_gamedata_blob
from ..core.waypoint import filter_waypoints

router = APIRouter()


@router.post("/extract")
async def extract(
    save_file: UploadFile = File(..., description=".vcdbs save file"),
    config_file: Optional[UploadFile] = File(None, description="serverconfig.json (optional)"),
    title: Optional[str] = Form(None),
    icon: Optional[str] = Form(None),
    owner: Optional[str] = Form(None),
    pinned: Optional[bool] = Form(None),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)

    save_bytes = await save_file.read()

    config_content = None
    if config_file:
        config_content = await config_file.read()

    offset_x, offset_z = get_map_offsets(config_content)

    gamedata_blob = read_gamedata_blob(save_bytes)
    if gamedata_blob is None:
        return JSONResponse(status_code=400, content={"detail": "No gamedata found in save file"})

    waypoints = extract_waypoints_from_blob(gamedata_blob, offset_x, offset_z)

    waypoints = filter_waypoints(
        waypoints, title=title, icon=icon, owner=owner, pinned=pinned
    )

    return {"count": len(waypoints), "waypoints": waypoints}
