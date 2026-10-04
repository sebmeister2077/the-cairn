"""drop obsolete webauthn_credentials dual-write trigger

Revision ID: 0046_drop_webauthn_trigger
Revises: 0045_api_keys_is_admin
Create Date: 2026-10-04

Migration 0006 installed a BEFORE INSERT/UPDATE trigger on
``webauthn_credentials`` that stamped the transitional ``user_id`` column by
resolving the legacy ``api_key`` text column to ``users.id`` via
``SELECT id FROM users WHERE api_key = NEW.api_key``.

Migration 0010 then dropped the ``users.api_key`` column (the raw key now lives
on ``api_keys.key``, reachable through ``users.api_key_id``). Migration 0012
dropped the other now-broken dual-write triggers but deliberately **kept** the
``webauthn_credentials`` one — reasoning only about its *source* ``api_key``
column still existing and overlooking that the trigger body also referenced the
now-dropped *target* ``users.api_key`` column. As a result every INSERT into
``webauthn_credentials`` (registering a passkey) failed with::

    psycopg2.errors.UndefinedColumn: column "api_key" does not exist
    HINT: Perhaps you meant to reference the column "users.api_key_id".

The ``user_id`` column is unused by the application: every passkey read/write
(``add``/``list``/``delete``/``count``/``get_by_id``) keys off the ``api_key``
text column, and the rekey flow never touches passkeys. The dual-write trigger
therefore serves no purpose, so we drop it (and its helper function) outright —
the same treatment 0012 gave the other obsolete triggers. New inserts simply
leave ``user_id`` NULL, which is already the documented orphaned-passkey state
from revision 0005.

Reversible: ``downgrade()`` recreates the trigger with a body resolving the
user through the *current* schema path (``users.api_key_id`` -> ``api_keys``),
so it is at least not broken against today's schema if ever reinstated.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0046_drop_webauthn_trigger"
down_revision: Union[str, None] = "0045_api_keys_is_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "webauthn_credentials"
_FUNCTION = "trg_dualwrite_webauthn_credentials_ids"
_TRIGGER = "trg_dualwrite_webauthn_credentials_ids_biu"


def upgrade() -> None:
    op.execute(f"DROP TRIGGER IF EXISTS {_TRIGGER} ON {_TABLE}")
    op.execute(f"DROP FUNCTION IF EXISTS {_FUNCTION}()")


def downgrade() -> None:
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {_FUNCTION}()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.user_id IS NULL AND NEW.api_key IS NOT NULL THEN
                NEW.user_id := (
                    SELECT u.id
                      FROM users u
                      JOIN api_keys ak ON ak.id = u.api_key_id
                     WHERE ak.key = NEW.api_key
                     LIMIT 1
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(f"DROP TRIGGER IF EXISTS {_TRIGGER} ON {_TABLE}")
    op.execute(
        f"""
        CREATE TRIGGER {_TRIGGER}
            BEFORE INSERT OR UPDATE ON {_TABLE}
            FOR EACH ROW
            EXECUTE FUNCTION {_FUNCTION}();
        """
    )
