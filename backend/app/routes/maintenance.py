"""Maintenance notices.

Public:
    GET    /api/maintenance/notices
        Returns the currently active maintenance notices so the frontend
        can render a chip on the affected page. Unauthenticated and
        intentionally lightweight.

Admin:
    GET    /api/admin/maintenance/notices
        List every known notice (active or not).
    PUT    /api/admin/maintenance/notices/{component}
        Create or update a notice. Pass ``active=true`` and either
        ``eta_at`` (ISO timestamp) or ``duration_hours`` (float) so the
        backend can compute the ETA from "now".
    DELETE /api/admin/maintenance/notices/{component}
        Turn the notice off (sets ``active=false`` but keeps the row).

Component identifiers are free-form strings, but the frontend only knows
about the ones listed in ``KNOWN_COMPONENTS`` below.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import accounts_db, database as db


# Whitelisted component identifiers. Keeping this server-side prevents an
# admin from typo-ing a key that the frontend never reads.
KNOWN_COMPONENTS = {
    "tops_map_viewer": "TOPS Map Viewer",
}


public_router = APIRouter(tags=["maintenance"])
admin_router = APIRouter(prefix="/admin", tags=["admin-maintenance"])


def _serialise(row: dict) -> dict:
    out = dict(row)
    for k in ("started_at", "eta_at", "updated_at"):
        v = out.get(k)
        if v and hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


class MaintenanceNoticeUpsert(BaseModel):
    active: bool = True
    message: str = ""
    # Either eta_at OR duration_hours (one of them required when active=True).
    eta_at: Optional[datetime] = None
    duration_hours: Optional[float] = Field(default=None, ge=0)


@public_router.get("/maintenance/notices")
async def list_active_notices():
    """Return the active maintenance notices. Public; no auth required."""
    rows = db.list_maintenance_notices(active_only=True)
    return {"notices": [_serialise(r) for r in rows]}


@admin_router.get("/maintenance/notices")
async def admin_list_notices(_: str = Depends(require_admin)):
    rows = db.list_maintenance_notices(active_only=False)
    return {
        "notices": [_serialise(r) for r in rows],
        "known_components": [
            {"id": cid, "label": label} for cid, label in KNOWN_COMPONENTS.items()
        ],
    }


@admin_router.put("/maintenance/notices/{component}")
async def admin_upsert_notice(
    component: str,
    body: MaintenanceNoticeUpsert,
    admin_key: str = Depends(require_admin),
):
    if component not in KNOWN_COMPONENTS:
        raise HTTPException(status_code=404, detail=f"Unknown component: {component}")

    eta_at: Optional[datetime] = body.eta_at
    if body.active:
        if eta_at is None and body.duration_hours is not None:
            eta_at = datetime.now(timezone.utc) + timedelta(hours=body.duration_hours)
        if eta_at is None:
            raise HTTPException(
                status_code=400,
                detail="active notice requires eta_at or duration_hours",
            )
        if eta_at.tzinfo is None:
            eta_at = eta_at.replace(tzinfo=timezone.utc)

    row = db.upsert_maintenance_notice(
        component=component,
        active=body.active,
        message=body.message,
        eta_at=eta_at,
        updated_by_key=admin_key,
    )
    accounts_db.audit_log(
        admin_key,
        "maintenance.upsert",
        target=component,
        metadata={
            "active": body.active,
            "eta_at": eta_at.isoformat() if eta_at else None,
            "message": body.message,
        },
    )
    return {"notice": _serialise(row)}


@admin_router.delete("/maintenance/notices/{component}")
async def admin_clear_notice(
    component: str,
    admin_key: str = Depends(require_admin),
):
    if component not in KNOWN_COMPONENTS:
        raise HTTPException(status_code=404, detail=f"Unknown component: {component}")
    row = db.clear_maintenance_notice(component, updated_by_key=admin_key)
    accounts_db.audit_log(admin_key, "maintenance.clear", target=component)
    return {"notice": _serialise(row) if row else None}
