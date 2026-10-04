"""fix webauthn_credentials dual-write trigger after users.api_key drop

Revision ID: 0046_fix_webauthn_dualwrite_trigger
Revises: 0045_api_keys_is_admin
Create Date: 2026-10-04

Migration 0006 installed a BEFORE INSERT/UPDATE trigger on
``webauthn_credentials`` that resolves the legacy ``api_key`` text column to
``users.id`` and stamps ``user_id``. Its original body looked up the user via
``SELECT id FROM users WHERE api_key = NEW.api_key``.

Migration 0010 then dropped the ``users.api_key`` column and moved the raw key
text onto ``api_keys.key`` (``users`` now references it through
``users.api_key_id``). Migration 0012 dropped the other now-broken dual-write
triggers but deliberately **kept** the ``webauthn_credentials`` one because its
*source* ``api_key`` column still exists — overlooking that the trigger's body
still referenced the now-dropped *target* ``users.api_key`` column.

The result: every INSERT into ``webauthn_credentials`` (i.e. registering a
passkey) fails with::

    psycopg2.errors.UndefinedColumn: column "api_key" does not exist
    HINT: Perhaps you meant to reference the column "users.api_key_id".

This migration redefines the trigger function to resolve the user via the
current schema path (``users.api_key_id`` -> ``api_keys.id`` -> ``api_keys.key``),
matching how revision 0010 backfilled every other ``*_id`` column. When no
matching user exists (e.g. the bootstrap env-var admin, which has no ``users``
row) the subquery yields NULL and ``user_id`` stays NULL — the orphaned-passkey
semantics already documented in revision 0005 — so the INSERT succeeds.

Reversible: ``downgrade()`` restores the original (broken-against-current-schema)
body for strict symmetry.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0046_fix_webauthn_dualwrite_trigger"
down_revision: Union[str, None] = "0045_api_keys_is_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_FUNCTION = "trg_dualwrite_webauthn_credentials_ids"


def upgrade() -> None:
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


def downgrade() -> None:
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {_FUNCTION}()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.user_id IS NULL AND NEW.api_key IS NOT NULL THEN
                NEW.user_id := (
                    SELECT id FROM users
                     WHERE api_key = NEW.api_key
                     LIMIT 1
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
