"""Programmatic Alembic runner used by the FastAPI startup hook.

Replaces the legacy ``database.ensure_schema()`` inline DDL execution with
``alembic upgrade head`` so all schema changes are version-controlled and
reversible. Activation is gated by the ``USE_ALEMBIC`` env var so the
rollout can be performed in two safe steps:

  1. Deploy this code with ``USE_ALEMBIC`` unset / "false". Behaviour is
     identical to before (``ensure_schema()`` still runs).
  2. On the production database, run ``alembic stamp 0001_baseline`` once
     (no DDL executed; just records the version row).
  3. Set ``USE_ALEMBIC=true`` and redeploy. From now on every startup runs
     ``alembic upgrade head`` and the inline DDL blocks are bypassed.

Set ``USE_ALEMBIC=auto`` to let the runner stamp the baseline itself when
the ``alembic_version`` table is missing — convenient for local dev and
fresh deployments. Production should stay on explicit ``true`` so a
mis-configured DB cannot be auto-stamped at the wrong revision.
"""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine

from .config import settings

# ``backend/alembic.ini`` lives one level above ``backend/app/``.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
_ALEMBIC_INI = _BACKEND_DIR / "alembic.ini"


def _alembic_config() -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("script_location", str(_BACKEND_DIR / "alembic"))
    return cfg


def _normalise_url(url: str) -> str:
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg2" not in url.split("://", 1)[0]:
        return "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def _current_alembic_version() -> str | None:
    """Return the rev id stored in ``alembic_version`` or ``None`` if the
    table does not yet exist (i.e. Alembic has never touched this DB)."""
    engine = create_engine(_normalise_url(settings.SUPABASE_DB_URL), poolclass=None)
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn)
            return ctx.get_current_revision()
    finally:
        engine.dispose()


def is_enabled() -> bool:
    return os.environ.get("USE_ALEMBIC", "").strip().lower() in {"true", "1", "yes", "auto"}


def upgrade_to_head() -> None:
    """Run ``alembic upgrade head``. In ``auto`` mode, stamp the baseline
    first if no version row exists (so a freshly-built DB skips re-running
    the baseline DDL the legacy ``ensure_schema()`` already produced)."""
    cfg = _alembic_config()
    mode = os.environ.get("USE_ALEMBIC", "").strip().lower()
    if mode == "auto" and _current_alembic_version() is None:
        # Existing schema but never stamped — record baseline without DDL.
        # If the DB is truly empty this still works because the baseline
        # DDL is fully idempotent (CREATE TABLE IF NOT EXISTS, etc.).
        command.stamp(cfg, "0001_baseline")
    command.upgrade(cfg, "head")
