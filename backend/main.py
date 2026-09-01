"""
AI Test Execution Platform — FastAPI application entry point.
"""
from __future__ import annotations

import asyncio
import ast
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
env_path = Path(__file__).resolve().parent / '.env'
load_dotenv(dotenv_path=env_path)

# ── Windows event loop setup ────────────────────────────────────────────────
# Python 3.8+ defaults to ProactorEventLoop on Windows, which is required
# by Playwright to support subprocesses (create_subprocess_exec).
# We ensure the proper Windows policy is active for any win* platform.
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
# ────────────────────────────────────────────────────────────────────────────

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from api.routes import router
from utils.logger import app_logger, get_logger

logger = get_logger("main")


def assert_no_wait_for_function() -> None:
    """Startup guard: reject workspace code containing direct wait_for_function calls."""
    root = Path(__file__).resolve().parent
    for py_file in root.rglob("*.py"):
        if ".venv" in py_file.parts or "__pycache__" in py_file.parts:
            continue
        try:
            source = py_file.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            tree = ast.parse(source, filename=str(py_file))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr == "wait_for_function":
                    raise RuntimeError(
                        f"Forbidden Playwright API call detected in {py_file}:{node.lineno}"
                    )
                if isinstance(func, ast.Name) and func.id == "wait_for_function":
                    raise RuntimeError(
                        f"Forbidden Playwright API call detected in {py_file}:{node.lineno}"
                    )


assert_no_wait_for_function()


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("=== AI Test Execution Engine starting up ===")

    # Ensure storage directories exist at startup
    from pathlib import Path
    for sub in ("screenshots", "logs", "artifacts", "reports"):
        (Path(__file__).parent / "storage" / sub).mkdir(parents=True, exist_ok=True)

    # Auto-migrate database schemas
    from models.database import engine, Base, SessionLocal
    from models.db_models import User
    from utils.auth import hash_password
    try:
        Base.metadata.create_all(bind=engine)
        logger.info("Database schemas initialized successfully.")
        
        # Auto-provision sandbox admin account
        with SessionLocal() as db:
            if not db.query(User).filter(User.email == "admin@testplatform.ai").first():
                admin_user = User(
                    email="admin@testplatform.ai",
                    hashed_password=hash_password("admin123"),
                    full_name="Sandbox Admin",
                    role="Admin"
                )
                db.add(admin_user)
                db.commit()
                logger.info("Sandbox Admin account automatically provisioned.")
    except Exception as db_exc:
        logger.error("Failed to initialize database schemas: %s", db_exc)

    # Initialize scheduling engine
    from services.scheduler import start_scheduler
    try:
        start_scheduler()
        logger.info("Async scheduling background poller started.")
    except Exception as sched_exc:
        logger.error("Failed to initialize scheduling engine: %s", sched_exc)

    # ── Mobile testing engine (Android) ─────────────────────────────────
    # Everything here is best-effort. The engine's dependencies (Appium,
    # selenium, PyMuPDF, ...) and its Android toolchain are NOT required for
    # the rest of this backend to work, so any failure below must degrade to
    # "mobile routes unavailable" and never to a backend that refuses to boot.
    try:
        import asyncio as _asyncio

        for sub in ("apks", "screenshots", "hierarchy", "evidence", "appium_logs"):
            (Path(__file__).parent / "storage" / "mobile" / sub).mkdir(parents=True, exist_ok=True)

        from mobile.database import (
            IS_SQLITE as MOBILE_IS_SQLITE,
            engine as mobile_engine,
            Base as MobileBase,
            run_additive_migrations as mobile_run_additive_migrations,
        )
        from mobile import models as mobile_models  # noqa: F401 — registers tables on MobileBase

        # Schema creation is deliberately NOT automatic on a real database.
        # On SQLite this is a throwaway local file, so creating tables is free
        # and convenient. On Postgres it is a schema change against the shared
        # Supabase instance the whole platform runs on — that is a reviewed,
        # deliberate migration (migrations/001_supabase_mobile_schema.sql), not
        # something a process restart should perform on its own. Opt in with
        # MOBILE_DB_AUTO_CREATE=1 if you really want create_all() there.
        auto_create = MOBILE_IS_SQLITE or os.getenv("MOBILE_DB_AUTO_CREATE", "").lower() in ("1", "true", "yes")
        if auto_create:
            MobileBase.metadata.create_all(bind=mobile_engine)
            mobile_run_additive_migrations()
            logger.info("Mobile engine schema ensured (%s).", "sqlite" if MOBILE_IS_SQLITE else "postgres, explicitly opted in")
        else:
            logger.info("Mobile engine schema NOT auto-created (non-SQLite target); apply the SQL migration explicitly.")

        # The engine's worker threads publish live events onto this loop.
        from mobile.live import event_bus as mobile_event_bus
        mobile_event_bus.bind_loop(_asyncio.get_running_loop())

        # Runs interrupted by a previous restart are dead — their worker
        # threads did not survive. Mark them, never silently auto-resume.
        from mobile.suite_engine import reap_interrupted_runs
        reap_interrupted_runs()

        logger.info("Mobile testing engine initialized.")
    except Exception as mobile_exc:
        logger.warning("Mobile testing engine unavailable (%s: %s). The rest of the backend is unaffected.",
                       type(mobile_exc).__name__, mobile_exc)

    yield

    # Teardown scheduling engine
    from services.scheduler import stop_scheduler
    try:
        await stop_scheduler()
        logger.info("Async scheduling background poller stopped.")
    except Exception:
        pass

    logger.info("=== AI Test Execution Engine shutting down ===")



# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Test Execution Engine",
        description=(
            "A production-ready Playwright-powered test execution backend. "
            "Accepts structured JSON test steps, executes them reliably, and "
            "returns detailed per-step results with logs and screenshots."
        ),
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    # ---- CORS ----
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],          # tighten in production
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- Global exception handler ----
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception on %s: %s", request.url, exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "An unexpected error occurred. Please check server logs."},
        )

    # ---- Routes ----
    from api import discovery_routes
    app.include_router(router)
    app.include_router(discovery_routes.router)

    # Mobile testing engine (Android), served under /api/v1/mobile. Guarded for
    # the same reason as its startup block: importing it pulls in Appium and
    # friends, and this backend must still come up without them installed.
    # Its own routes sit behind an x-internal-key check (mobile/api.py) — the
    # user's real auth is verified upstream by backend-node before proxying.
    try:
        from mobile.api import router as mobile_router
        app.include_router(mobile_router)
        logger.info("Mobile testing routes mounted at /api/v1/mobile.")
    except Exception as mobile_exc:
        logger.warning("Mobile testing routes not mounted (%s: %s).",
                       type(mobile_exc).__name__, mobile_exc)

    # Serves both the existing artifacts and the mobile engine's evidence,
    # which is stored under storage/mobile/** and referenced by the API as
    # root-relative /storage/... URLs.
    app.mount("/storage", StaticFiles(directory=Path(__file__).parent / "storage"), name="storage")

    return app


app = create_app()


# ---------------------------------------------------------------------------
# Dev server entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
