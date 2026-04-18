"""POST /api/import — Import waypoints into a .vcdbs save file."""

from fastapi import APIRouter, Depends, File, UploadFile, Form
from fastapi.responses import Response, JSONResponse
from typing import Optional

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.config_reader import get_map_offsets
from ..core.gamedata import import_waypoints_into_blob

import json

router = APIRouter()


@router.post("/import")
async def import_waypoints(
    save_file: UploadFile = File(..., description=".vcdbs save file"),
    waypoints_file: UploadFile = File(..., description="waypoints JSON file"),
    config_file: Optional[UploadFile] = File(None, description="serverconfig.json (optional)"),
    mode: str = Form("append", description="'append' or 'replace'"),
    owner: Optional[str] = Form(None, description="Override owner UID"),
    new_guids: bool = Form(False, description="Generate new GUIDs"),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)

    if mode not in ("append", "replace"):
        return JSONResponse(status_code=400, content={"detail": "mode must be 'append' or 'replace'"})

    save_bytes = await save_file.read()
    wp_content = await waypoints_file.read()

    config_content = None
    if config_file:
        config_content = await config_file.read()

    try:
        waypoints = json.loads(wp_content)
    except json.JSONDecodeError:
        return JSONResponse(status_code=400, content={"detail": "Invalid JSON in waypoints file"})

    if not isinstance(waypoints, list):
        return JSONResponse(status_code=400, content={"detail": "Waypoints JSON must be an array"})

    offset_x, offset_z = get_map_offsets(config_content)

    try:
        modified_save, existing, imported = import_waypoints_into_blob(
            save_bytes, waypoints, offset_x, offset_z,
            mode=mode, owner=owner, new_guids=new_guids,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return Response(
        content=modified_save,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": "attachment; filename=modified.vcdbs",
            "X-Existing-Count": str(existing),
            "X-Imported-Count": str(imported),
        },
    )
