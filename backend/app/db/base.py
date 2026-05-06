"""Shared SQLAlchemy declarative base.

Kept in its own module so model files can import ``Base`` without pulling
in the full model registry (which would create import cycles). The
``base_all`` module is the one Alembic env.py imports — it re-exports
``Base`` and side-effect-imports every model module so all tables are
attached to ``Base.metadata`` at autogenerate time.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
