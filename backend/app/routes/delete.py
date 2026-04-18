"""POST /api/delete — Delete matching waypoints from a .vcdbs save file."""

from fastapi import APIRouter, Depends, File, UploadFile, Form
from fastapi.responses import Response, JSONResponse
from typing import Optional

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.config_reader import get_map_offsets
from ..core.gamedata import delete_waypoints_from_blob

router = APIRouter()


@router.post("/delete")
async def delete_waypoints(
    save_file: UploadFile = File(..., description=".vcdbs save file"),
    config_file: Optional[UploadFile] = File(None, description="serverconfig.json (optional)"),
    title: Optional[str] = Form(None),
    icon: Optional[str] = Form(None),
    owner: Optional[str] = Form(None),
    pinned_only: bool = Form(False),
    unpinned_only: bool = Form(False),
    color: Optional[str] = Form(None),
    guid: Optional[str] = Form(None),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)

    save_bytes = await save_file.read()

    config_content = None
    if config_file:
        config_content = await config_file.read()

    offset_x, offset_z = get_map_offsets(config_content)

    try:
        modified_save, deleted_count, remaining_count, deleted, remaining = \
            delete_waypoints_from_blob(
                save_bytes, offset_x, offset_z,
                title=title, icon=icon, owner=owner,
                pinned_only=pinned_only, unpinned_only=unpinned_only,
                color=color, guid=guid,
            )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    if deleted_count == 0:
        return JSONResponse(
            status_code=200,
            content={
                "message": "No matching waypoints found",
                "deleted": 0,
                "remaining": remaining_count,
            },
        )

    return Response(
        content=modified_save,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": "attachment; filename=modified.vcdbs",
            "X-Deleted-Count": str(deleted_count),
            "X-Remaining-Count": str(remaining_count),
        },
    )
