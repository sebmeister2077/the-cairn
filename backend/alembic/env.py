"""Alembic environment.

This project uses raw psycopg2 in the application code; SQLAlchemy is only
present so Alembic can run. Migrations should write raw SQL via
``op.execute(...)`` rather than reflecting model metadata.
"""

from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make the backend package importable regardless of the cwd Alembic was
# invoked from (so ``from app.config import settings`` works).
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.config import settings  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Resolve the database URL. Prefer the live settings value; fall back to the
# raw env var so ``alembic`` can be invoked in environments where
# ``app.config`` cannot import (e.g. minimal CI). Alembic / SQLAlchemy expect
# the ``postgresql+psycopg2://`` scheme; rewrite the bare ``postgres://`` and
# ``postgresql://`` schemes Supabase / Render hand out.
def _resolve_db_url() -> str:
    url = settings.SUPABASE_DB_URL or os.environ.get("SUPABASE_DB_URL", "")
    if not url:
        raise RuntimeError(
            "SUPABASE_DB_URL is not configured; cannot run Alembic migrations."
        )
    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url[len("postgres://") :]
    elif url.startswith("postgresql://") and "+psycopg2" not in url.split("://", 1)[0]:
        url = "postgresql+psycopg2://" + url[len("postgresql://") :]
    return url


config.set_main_option("sqlalchemy.url", _resolve_db_url())

# No declarative models — migrations are hand-written raw SQL.
target_metadata = None


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emits SQL to stdout)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live database connection."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
