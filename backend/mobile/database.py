"""
Database for the Apptesting standalone Android testing engine.

Resolution order: MOBILE_DATABASE_URL -> DIRECT_URL -> DATABASE_URL ->
local SQLite. Nothing else in this module cares which backend is active
except the SQLite-only concurrency pragmas below, which are skipped entirely
on Postgres (it doesn't have SQLite's single-writer-lock problem in the
first place).

Set MOBILE_DATABASE_URL explicitly. In this project the other two are NOT
usable as-is: DATABASE_URL and DIRECT_URL both point at
db.<ref>.supabase.co, which resolves to an IPv6 address only (Supabase
dropped IPv4 on direct database connections). Anything without an IPv6 route
gets ENOTFOUND. They survive in .env because they are Prisma-era leftovers —
the rest of the platform reaches Supabase over the HTTPS REST API
(supabase.from(...)), never the Postgres wire protocol, so nothing noticed.
This engine is SQLAlchemy, so it cannot use REST and does need a real
reachable Postgres endpoint.

The endpoint that works over IPv4 is the Supabase *session* pooler
(aws-0-<region>.pooler.supabase.com:5432 — Dashboard > Connect > Session
pooler). Session mode, not transaction mode (:6543): this engine runs each
suite/execution on its own OS thread (suite_engine.run_suite,
engine.run_execution) holding one Session open for the whole run while
committing once per step, and transaction-mode pooling does not preserve
session state across those commits.

MOBILE_DATABASE_URL is also kept distinct from DATABASE_URL so re-pointing
one schema never silently re-points the other — backend/models/database.py
reads DATABASE_URL for a completely separate set of tables
(users/projects/suites/...).

If the resolved URL is unreachable, this engine fails loudly at startup
(main.py logs it and leaves mobile disabled) rather than quietly writing to
the SQLite fallback — check the log line before assuming data landed in
Supabase.
"""
from __future__ import annotations

import os
from pathlib import Path
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage" / "mobile"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_SQLITE_URL = f"sqlite:///{STORAGE_DIR / 'mobile.db'}"
DATABASE_URL = (
    os.environ.get("MOBILE_DATABASE_URL")
    or os.environ.get("DIRECT_URL")
    or os.environ.get("DATABASE_URL")
    or DEFAULT_SQLITE_URL
)
if DATABASE_URL.startswith("postgres://"):
    # Supabase (like Heroku before it) hands out "postgres://" connection
    # strings; SQLAlchemy 2.x's psycopg2 dialect only accepts "postgresql://".
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

IS_SQLITE = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
    pool_pre_ping=True,
)

if IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _set_sqlite_concurrency_pragmas(dbapi_connection, _record) -> None:
        """Parallel executions each hold their own DB session and commit
        frequently (once per step). Plain SQLite allows only one writer at a
        time and raises "database is locked" immediately on contention —
        under real concurrency that would surface as executions silently
        erroring out mid-run, which is exactly the kind of inaccurate/
        incomplete report this project can't afford. WAL lets readers and a
        writer work concurrently, and a busy_timeout makes a writer wait for
        the lock instead of failing immediately (rule: correctness over
        speed — a few hundred ms of wait beats a fabricated infra failure).
        Postgres has its own MVCC and doesn't need any of this."""
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columns added to an existing model after the DB file was first created.
# `Base.metadata.create_all` only creates missing TABLES, never missing
# columns on a table that already exists — without this, adding a column to
# a model silently does nothing on a dev machine that already has data.
# There's no Alembic here (single local SQLite file, no external DB — rule
# 98/101), so this is a minimal additive-only migration: ADD COLUMN never
# drops or alters existing data.
_ADDITIVE_COLUMNS = {
    "mobile_applications": [
        # Project scoping. Already applied to the shared Supabase database by
        # hand; this entry is what gives a fresh local SQLite dev DB the same
        # column without needing that migration run against it.
        ("project_uuid", "VARCHAR(64)"),
    ],
    "mobile_devices": [
        ("battery_level", "INTEGER"),
        ("battery_status", "VARCHAR(20)"),
    ],
    "mobile_application_versions": [
        ("screen_map", "JSON"),
        ("screen_map_captured_at", "TIMESTAMP"),
    ],
    "mobile_executions": [
        ("compatibility_run_id", "INTEGER"),
        ("suite_id", "INTEGER"),
        ("suite_video_offset_start_ms", "INTEGER"),
        ("suite_video_offset_end_ms", "INTEGER"),
        ("video_path", "TEXT"),
    ],
    "mobile_tests": [
        ("suite_id", "INTEGER"),
        ("source_meta", "JSON"),
    ],
}


def run_additive_migrations() -> None:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, columns in _ADDITIVE_COLUMNS.items():
            if table not in existing_tables:
                continue  # create_all will have made it with the column already present
            existing_cols = {c["name"] for c in inspector.get_columns(table)}
            for col_name, col_type in columns:
                if col_name not in existing_cols:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}"))
