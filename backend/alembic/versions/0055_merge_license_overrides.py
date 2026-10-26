"""merge 0050_license_parameter_overrides into main line

Revision ID: 0055_merge_license_overrides
Revises: 0050_license_parameter_overrides, 0054_promo
Create Date: 2026-10-26 19:35:13.355225

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # noqa: F401  (kept for op.execute / future use)


# revision identifiers, used by Alembic.
revision: str = '0055_merge_license_overrides'
down_revision: Union[str, None] = ('0050_license_parameter_overrides', '0054_promo')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
