"""
FastAPI router for test execution endpoints, authentication, and SaaS resource CRUD.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime
import traceback

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status, Depends
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from execution.runner import run_test
from execution.live import event_bus
from execution.multi_executor import run_cross_platform_parallel
from models.database import get_db
from models.db_models import User, Project, Suite, TestCase, TestRun, Schedule
from models.schemas import TestRequest, TestRunResult, RunConfig, TestStep
from services.project_service import (
    create_project, get_projects, get_project_by_id, delete_project,
    create_suite, get_suites, get_suite_by_id, delete_suite,
    create_test_case, get_test_cases, get_test_case_by_id, delete_test_case, update_test_case
)
from services.run_service import (
    get_dashboard_summary, 
    get_execution_trend, 
    get_browser_distribution, 
    get_recent_executions,
    get_test_runs
)
from utils.auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, require_admin, require_engineer, require_viewer
)
from utils.logger import get_logger
from playwright.async_api import async_playwright
from pydantic import BaseModel, Field

logger = get_logger("routes")

router = APIRouter(prefix="/api/v1", tags=["Enterprise Test Manager"])

REPORTS_DIR = Path(__file__).resolve().parent.parent / "storage" / "reports"
EXECUTIONS_DIR = Path(__file__).resolve().parent.parent / "storage" / "executions"


# ── SaaS Pydantic Schemas ───────────────────────────────────────────────────

class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    role: Optional[str] = "QA Engineer"


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    role: str
    full_name: str


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None


class SuiteCreate(BaseModel):
    name: str
    description: Optional[str] = None


class TestCaseCreate(BaseModel):
    name: str
    description: Optional[str] = None
    steps: List[Dict[str, Any]]


class TestCaseUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    steps: List[Dict[str, Any]]


class ScheduleCreate(BaseModel):
    name: str
    cron_expression: str
    project_id: int
    suite_id: int
    environment: str = "Production"
    browsers: List[str] = Field(default_factory=list)
    devices: List[str] = Field(default_factory=list)


class MultiRunRequest(BaseModel):
    test_name: str
    base_url: str
    steps: List[Dict[str, Any]]
    browsers: List[str]
    devices: List[str]
    environment: str = "Production"
    project_id: int
    suite_id: Optional[int] = None
    test_case_id: Optional[int] = None
    execution_id: Optional[str] = None


# ── JWT Authentication ───────────────────────────────────────────────────────

@router.post("/auth/signup", response_model=Dict[str, str], summary="User signup")
async def signup(req: SignupRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == req.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed = hash_password(req.password)
    user = User(
        email=req.email,
        hashed_password=hashed,
        full_name=req.full_name,
        role=req.role or "QA Engineer"
    )
    db.add(user)
    db.commit()
    return {"message": "User created successfully"}


@router.post("/auth/login", response_model=TokenResponse, summary="User login")
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Invalid username or password")
    
    token = create_access_token({"sub": user.email})
    return {
        "access_token": token,
        "token_type": "bearer",
        "role": user.role,
        "full_name": user.full_name or user.email
    }


@router.get("/auth/me", summary="Get current user details")
async def get_me(user: User = Depends(get_current_user)):
    return {
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "created_at": user.created_at.isoformat() if user.created_at else None
    }


# ── Projects CRUD ────────────────────────────────────────────────────────────

@router.post("/projects", summary="Create new project")
async def add_project(req: ProjectCreate, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    return create_project(db, name=req.name, description=req.description, owner_id=user.id)


@router.get("/projects", summary="List all projects")
async def list_projects_endpoint(db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_projects(db)


@router.delete("/projects/{project_id}", summary="Delete a project")
async def remove_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    success = delete_project(db, project_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"message": "Project deleted successfully"}


# ── Suites CRUD ──────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/suites", summary="Create new test suite in project")
async def add_suite(project_id: int, req: SuiteCreate, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    return create_suite(db, project_id=project_id, name=req.name, description=req.description)


@router.get("/projects/{project_id}/suites", summary="List suites in project")
async def list_project_suites(project_id: int, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_suites(db, project_id=project_id)


@router.delete("/suites/{suite_id}", summary="Delete test suite")
async def remove_suite(suite_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    success = delete_suite(db, suite_id)
    if not success:
        raise HTTPException(status_code=404, detail="Suite not found")
    return {"message": "Suite deleted successfully"}


# ── Test Cases CRUD ──────────────────────────────────────────────────────────

@router.post("/suites/{suite_id}/cases", summary="Create test case in suite")
async def add_test_case(suite_id: int, req: TestCaseCreate, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    return create_test_case(db, suite_id=suite_id, name=req.name, steps=req.steps, description=req.description)


@router.get("/suites/{suite_id}/cases", summary="List test cases in suite")
async def list_suite_cases(suite_id: int, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_test_cases(db, suite_id=suite_id)


@router.put("/cases/{case_id}", summary="Update test case details/steps")
async def edit_test_case(case_id: int, req: TestCaseUpdate, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    case = update_test_case(db, case_id=case_id, steps=req.steps, name=req.name, description=req.description)
    if not case:
        raise HTTPException(status_code=404, detail="TestCase not found")
    return case


@router.delete("/cases/{case_id}", summary="Delete a test case")
async def remove_test_case(case_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    success = delete_test_case(db, case_id)
    if not success:
        raise HTTPException(status_code=404, detail="TestCase not found")
    return {"message": "TestCase deleted successfully"}


# ── Dashboard & Test Runs Analytics ──────────────────────────────────────────

@router.get("/dashboard/summary", summary="Get dashboard metrics summary")
async def dashboard_summary(db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_dashboard_summary(db)


@router.get("/dashboard/execution-trend", summary="Get dashboard execution trend")
async def execution_trend(days: int = 7, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_execution_trend(db, days=days)


@router.get("/dashboard/browser-distribution", summary="Get dashboard browser distribution")
async def browser_distribution(db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_browser_distribution(db)


@router.get("/dashboard/recent-executions", summary="Get dashboard recent executions")
async def recent_executions(limit: int = 15, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_recent_executions(db, limit=limit)


@router.get("/runs", summary="Get historical test run details")
async def list_runs(limit: int = 50, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return get_test_runs(db, limit=limit)

@router.get("/runs/{run_id}", summary="Get detailed test run information")
async def get_run_details(run_id: str, db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    from services.run_service import get_run_by_id
    run = get_run_by_id(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run



# ── Schedules CRUD ───────────────────────────────────────────────────────────

@router.post("/schedules", summary="Create execution schedule")
async def add_schedule(req: ScheduleCreate, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    sched = Schedule(
        name=req.name,
        cron_expression=req.cron_expression,
        project_id=req.project_id,
        suite_id=req.suite_id,
        environment=req.environment,
        browsers=req.browsers,
        devices=req.devices,
        active=True
    )
    db.add(sched)
    db.commit()
    db.refresh(sched)
    return sched


@router.get("/schedules", summary="List all execution schedules")
async def list_schedules(db: Session = Depends(get_db), user: User = Depends(require_viewer)):
    return db.query(Schedule).all()


@router.delete("/schedules/{schedule_id}", summary="Delete schedule")
async def remove_schedule(schedule_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    sched = db.query(Schedule).filter(Schedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    db.delete(sched)
    db.commit()
    return {"message": "Schedule deleted successfully"}


# ── Cross-Browser Parallel Runner Endpoint ───────────────────────────────────

@router.post("/run-multi-test", summary="Run test case across browsers & devices in parallel")
async def run_multi_test(req: MultiRunRequest, db: Session = Depends(get_db), user: User = Depends(require_engineer)):
    """Orchestrates parallel Playwright sessions via multi_executor."""
    try:
        results = await run_multi_test_internal(
            suite={
                "test_suite": {
                    "name": req.test_name,
                    "base_url": req.base_url,
                    "tests": [
                        {
                            "test_name": req.test_name,
                            "test_type": "positive",
                            "steps": req.steps
                        }
                    ]
                }
            },
            browsers=req.browsers,
            devices=req.devices,
            environment=req.environment,
            db=db,
            project_id=req.project_id,
            suite_id=req.suite_id,
            test_case_id=req.test_case_id,
            execution_id=req.execution_id
        )
        return results
    except Exception as exc:
        logger.exception("Error in run-multi-test: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


async def run_multi_test_internal(
    suite: Dict[str, Any],
    browsers: List[str],
    devices: List[str],
    environment: str,
    db: Session,
    project_id: int = 1,
    suite_id: Optional[int] = None,
    test_case_id: Optional[int] = None,
    execution_id: Optional[str] = None
) -> Dict[str, Any]:
    """Internal helper to orchestrate parallel asyncio runs for routers and schedulers."""
    tests = suite.get("test_suite", {}).get("tests") or []
    if not tests:
        raise ValueError("Suite has no tests")
    
    test = tests[0]
    steps = test.get("steps") or []
    test_name = test.get("test_name") or "scheduled_run"
    base_url = suite.get("test_suite", {}).get("base_url") or "https://example.com"

    results = await run_cross_platform_parallel(
        test_name=test_name,
        base_url=base_url,
        steps=steps,
        browsers=browsers,
        devices=devices,
        environment=environment,
        project_id=project_id,
        db=db,
        suite_id=suite_id,
        test_case_id=test_case_id,
        execution_id=execution_id
    )
    return results


# ── Preserved Core MVP Endpoints ─────────────────────────────────────────────

# Include AI routes
from . import ai_routes  # noqa: E402
router.include_router(ai_routes.router)


@router.post(
    "/run-test",
    response_model=TestRunResult,
    status_code=status.HTTP_200_OK,
    summary="Execute a test suite (Single Run Legacy)",
)
async def run_test_endpoint(request: TestRequest) -> TestRunResult:
    logger.info(
        "Received legacy test run request: name='%s' steps=%d browser=%s",
        request.test_name,
        len(request.steps),
        request.browser,
    )
    try:
        result = await run_test(request)
        return result
    except Exception as exc:
        logger.exception("Unexpected error in /run-test: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal server error: {exc}",
        ) from exc


@router.get("/health", summary="Health check", tags=["Monitoring"])
async def health_check() -> JSONResponse:
    return JSONResponse(content={"status": "ok", "service": "ai-test-execution-engine"})


@router.get("/suites", summary="List saved suite JSON files", tags=["Artifacts"])
async def list_suites() -> JSONResponse:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    suites = []
    for file in sorted(REPORTS_DIR.glob("suite_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = file.stat()
        suites.append(
            {
                "name": file.name,
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
                "url": f"/storage/reports/{file.name}",
            }
        )
    return JSONResponse(content={"items": suites})


@router.get("/reports", summary="List saved HTML reports", tags=["Artifacts"])
async def list_reports() -> JSONResponse:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    reports = []
    for file in sorted(REPORTS_DIR.glob("report_*.html"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = file.stat()
        reports.append(
            {
                "name": file.name,
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
                "url": f"/storage/reports/{file.name}",
            }
        )
    return JSONResponse(content={"items": reports})


@router.get("/executions", summary="List saved execution JSON artifacts", tags=["Artifacts"])
async def list_executions() -> JSONResponse:
    EXECUTIONS_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for file in sorted(EXECUTIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = file.stat()
        items.append(
            {
                "name": file.name,
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
                "url": f"/storage/executions/{file.name}",
            }
        )
    return JSONResponse(content={"items": items})


@router.get("/executions/{execution_name}", summary="Get execution replay artifact", tags=["Artifacts"])
async def get_execution(execution_name: str) -> JSONResponse:
    target = EXECUTIONS_DIR / execution_name
    if not target.exists():
        raise HTTPException(status_code=404, detail="Execution artifact not found")
    import json
    data = json.loads(target.read_text(encoding="utf-8"))
    return JSONResponse(content=data)


@router.websocket("/ws/executions/{execution_id}")
async def execution_ws(websocket: WebSocket, execution_id: str) -> None:
    await event_bus.connect(execution_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await event_bus.disconnect(execution_id, websocket)


@router.get("/diagnostics/screenshots", summary="Run screenshot diagnostics probe", tags=["Diagnostics"])
async def diagnostics_screenshots() -> JSONResponse:
    screenshots_dir = Path(__file__).resolve().parent.parent / "storage" / "screenshots" / "diagnostics"
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    shot_path = screenshots_dir / f"probe_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"

    payload = {
        "ok": False,
        "target_path": str(shot_path),
        "target_url": f"/storage/screenshots/diagnostics/{shot_path.name}",
        "playwright_launch": False,
        "page_navigation": False,
        "screenshot_attempted": False,
        "file_exists": False,
        "file_size": 0,
        "error": None,
        "traceback": None,
    }

    pw = None
    browser = None
    context = None
    try:
        pw = await async_playwright().start()
        payload["playwright_launch"] = True
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 800}, ignore_https_errors=True)
        page = await context.new_page()
        await page.goto("https://example.com/", wait_until="domcontentloaded", timeout=30000)
        payload["page_navigation"] = True
        payload["screenshot_attempted"] = True
        await page.screenshot(path=str(shot_path), full_page=True)
        payload["file_exists"] = shot_path.exists()
        payload["file_size"] = shot_path.stat().st_size if shot_path.exists() else 0
        payload["ok"] = payload["file_exists"] and payload["file_size"] > 0
        if not payload["ok"]:
            payload["error"] = "Screenshot file missing or zero bytes after capture"
    except Exception as exc:
        payload["error"] = str(exc)
        payload["traceback"] = traceback.format_exc()
        logger.exception("Screenshot diagnostics probe failed: %s", exc)
    finally:
        try:
            if context:
                await context.close()
        except Exception:
            pass
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        try:
            if pw:
                await pw.stop()
        except Exception:
            pass

    status_code = 200 if payload["ok"] else 500
    return JSONResponse(content=payload, status_code=status_code)
