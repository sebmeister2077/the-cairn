"""SQLAlchemy ORM models registered with the shared ``Base`` metadata.

The application code still talks to the database via raw psycopg2 — these
classes exist only so Alembic can render new tables/columns from a single
source of truth (``op.create_table(...)`` with typed columns) instead of
hand-written DDL strings. To add a new table:

1. Add a model module under ``app/db/models/`` and import it from
   ``app/db/base_all.py`` so its tables register with ``Base.metadata``.
2. Run ``alembic revision --autogenerate -m "..."`` to generate the
   migration. Review the generated file before committing.
"""
