"""Admin endpoints for non-boolean runtime settings.

Today this only exposes the zstd compression knobs (level + thread preset)
that govern :doc:`/plans/zstd-compression-plan`. The shape is:

* ``GET    /api/admin/settings/compression``
* ``PATCH  /api/admin/settings/compression``
* ``POST   /api/admin/settings/compression/estimate``
* ``GET    /api/admin/settings/compression/status``
* ``GET    /api/admin/settings/compression/migration-status``
* ``GET    /api/admin/system/cpu-info``

Settings are read through a small in-process cache that mirrors the one
used for feature flags so repeated reads on the write hot-path don't
hammer Postgres.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import accounts_db, database as db
from ..core import compression as comp
from ..core import r2_storage


router = APIRouter(prefix="/admin", tags=["admin-settings"])


# ---------------------------------------------------------------------------
# Settings cache (mirrors feature_flags.py)
# ---------------------------------------------------------------------------

_SETTINGS_CACHE_TTL = 30.0
_settings_lock = threading.Lock()
_settings_cache: dict = {}  # key -> (value: dict, fetched_at: float)


def get_compression_settings() -> dict:
    """Return the validated compression settings dict, using a 30-second
    in-process cache. Public helper imported by the write-path callers
    (combined-DB worker, archive worker, backup worker)."""
    now = time.monotonic()
    with _settings_lock:
        cached = _settings_cache.get("compression_settings")
        if cached and (now - cached[1]) < _SETTINGS_CACHE_TTL:
            return dict(cached[0])
    raw_row = None
    try:
        raw_row = db.get_app_setting("compression_settings")
    except Exception:
        # On DB hiccup keep serving the previous value rather than reverting
        # to defaults mid-flight.
        with _settings_lock:
            cached = _settings_cache.get("compression_settings")
            if cached:
                return dict(cached[0])
    raw_value = raw_row["value"] if raw_row else None
    value = comp.normalise_settings(raw_value)
    with _settings_lock:
        _settings_cache["compression_settings"] = (value, now)
    return dict(value)


def _invalidate_compression_settings() -> None:
    with _settings_lock:
        _settings_cache.pop("compression_settings", None)


# ---------------------------------------------------------------------------
# Background-job status snapshot
#
# Populated by ``compress_workers`` (combined DB job) and the migration
# runner. Kept in this module so the read endpoint has a stable place to
# import from regardless of which worker last updated it.
# ---------------------------------------------------------------------------

_status_lock = threading.Lock()
_last_compress_run: dict = {
    "kind": None,           # "combined" | "archive" | "backup"
    "started_at": None,     # epoch seconds
    "finished_at": None,
    "input_bytes": 0,
    "output_bytes": 0,
    "elapsed_seconds": 0.0,
    "error": None,
}

_migration_status: dict = {
    "phase": "idle",        # "idle" | "running" | "done" | "error"
    "total": 0,
    "processed": 0,
    "skipped": 0,
    "failed": 0,
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def record_compress_run(**fields) -> None:
    """Update the compression-status snapshot (used by background workers).
    Overwrites any keys provided in ``fields``."""
    with _status_lock:
        _last_compress_run.update(fields)


def get_compress_status() -> dict:
    with _status_lock:
        return dict(_last_compress_run)


def update_migration_status(**fields) -> None:
    with _status_lock:
        _migration_status.update(fields)


def get_migration_status() -> dict:
    with _status_lock:
        return dict(_migration_status)


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

class CompressionSettingsPatch(BaseModel):
    level: int = Field(..., ge=1, le=22)
    threads_preset: str = Field(..., pattern="^(single|half|all)$")


class EstimateRequest(BaseModel):
    level: int = Field(..., ge=1, le=22)
    threads_preset: str = Field(..., pattern="^(single|half|all)$")
    # Optional override for the input size; defaults to the live combined-DB
    # size so the UI's "live preview" reflects production reality.
    input_bytes: Optional[int] = Field(default=None, ge=0)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/system/cpu-info")
async def cpu_info(_: str = Depends(require_admin)):
    cpu = os.cpu_count() or 1
    return {
        "cpu_count": cpu,
        "presets": {
            "single": comp.resolve_threads("single"),
            "half": comp.resolve_threads("half"),
            "all": comp.resolve_threads("all"),
        },
    }


def _settings_payload(value: dict) -> dict:
    return {
        "level": value["level"],
        "threads_preset": value["threads_preset"],
        "resolved_threads": comp.resolve_threads(value["threads_preset"]),
        "cpu_count": os.cpu_count() or 1,
    }


@router.get("/settings/compression")
async def get_compression(_: str = Depends(require_admin)):
    value = get_compression_settings()
    return _settings_payload(value)


@router.patch("/settings/compression")
async def patch_compression(
    body: CompressionSettingsPatch,
    admin_key: str = Depends(require_admin),
):
    value = comp.normalise_settings({
        "level": body.level,
        "threads_preset": body.threads_preset,
    })
    db.set_app_setting("compression_settings", value, updated_by_key=admin_key)
    _invalidate_compression_settings()
    accounts_db.audit_log(
        admin_key,
        "settings.compression.set",
        target="compression_settings",
        metadata=value,
    )
    return _settings_payload(value)


def _live_combined_db_size() -> int:
    try:
        return r2_storage.get_object_size(r2_storage.COMBINED_DB_KEY)
    except FileNotFoundError:
        return 0


@router.post("/settings/compression/estimate")
async def estimate_compression(
    body: EstimateRequest,
    _: str = Depends(require_admin),
):
    db_size = body.input_bytes if body.input_bytes is not None else _live_combined_db_size()
    threads = comp.resolve_threads(body.threads_preset)
    est = comp.estimate_cost(db_size, body.level, threads)
    return {
        "db_size_bytes": db_size,
        "threads": threads,
        **est,
    }


@router.get("/settings/compression/status")
async def compression_status(_: str = Depends(require_admin)):
    return get_compress_status()


@router.get("/settings/compression/migration-status")
async def compression_migration_status(_: str = Depends(require_admin)):
    return get_migration_status()
