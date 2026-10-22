"""admin-pushed runtime parameter overrides per license

Revision ID: 0050_license_parameter_overrides
Revises: 0049_license_api_key_id
Create Date: 2026-10-22

Admins can now push a set of runtime parameter overrides to a license. The
overrides are signed into the license token on the next ``activate``/``validate``
call and the VSProxy client applies them (minus licensing secrets) before it
starts. ``overrides_updated_at`` records the last change for the admin UI.

See ``app/routes/licenses.py``, ``app/core/database.py`` and the VSProxy
client's ``src/Licensing/LicenseGate.cs`` + ``src/Config/ProxyConfig.cs``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0050_license_parameter_overrides"
down_revision: Union[str, None] = "0049_license_api_key_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "licenses",
        sa.Column("parameter_overrides", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "licenses",
        sa.Column("overrides_updated_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("licenses", "overrides_updated_at")
    op.drop_column("licenses", "parameter_overrides")
