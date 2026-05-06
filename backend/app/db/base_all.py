"""Aggregate model registry imported by Alembic ``env.py``.

Every new model module MUST be imported here (even if unused) so its
tables are registered on ``Base.metadata`` before autogenerate runs.
"""

from __future__ import annotations

from app.db.base import Base  # noqa: F401  (re-exported)

# Side-effect imports — registers tables with Base.metadata.
from app.db.models import landmarks  # noqa: F401
