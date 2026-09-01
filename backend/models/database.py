"""
SQLAlchemy database setup module.
Provides engine and session configuration for SQLite and PostgreSQL.
"""
from __future__ import annotations

import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Resolve base storage path
BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# Database URL resolution
# Default to SQLite local file for zero-configuration, switch to PostgreSQL if DATABASE_URL is set.
DEFAULT_SQLITE_URL = f"sqlite:///{STORAGE_DIR}/platform.db"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_SQLITE_URL)

# For PostgreSQL, ensure proper dialect format
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# SQLite-specific connection arguments (disable same thread check for multiple threads/async loops)
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# Build Engine and SessionMaker
engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,  # Test connections before executing queries
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI Dependency to yield db sessions and safely close them."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
