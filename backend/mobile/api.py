"""
FastAPI router for the Android Mobile Testing Engine.
Mounted under /api/v1/mobile in main.py.
"""
from __future__ import annotations

import datetime
import hmac
import os
import shutil
import threading
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session, selectinload

from mobile import device_manager
from mobile.live import event_bus
from mobile.apk_inspector import ApkValidationError, compute_sha256, extract_metadata, validate_apk_file
from mobile.engine import NON_RETRYABLE_TERMINAL_STATUSES, run_execution
from mobile.healing import memory as locator_memory
from mobile.models import (
    MobileApplication,
    MobileApplicationVersion,
    MobileCompatibilityRun,
    MobileDevice,
    MobileEvidence,
    MobileExecution,
    MobileHealingRecord,
    MobileTest,
    MobileTestSuite,
)
from mobile.schemas import (
    ApplicationOut,
    CompatibilityRunCreateRequest,
    DeviceOut,
    ExecutionCreateRequest,
    ExecutionOut,
    ExecutionPolicy,
    HealingRecordOut,
    TestCreateRequest,
)
from mobile.database import get_db
from utils.logger import get_logger

logger = get_logger("mobile.api")

def verify_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    """Gate every mobile route behind a shared secret set by the Node proxy.

    This engine has no user model of its own. The real authentication — the
    user's Supabase bearer token — is verified once, upstream, by
    backend-node's `authenticate` middleware; the proxy then attaches
    `x-internal-key` when it forwards. So this check is not "is this a valid
    user", it is "did this actually come through the authenticated proxy, and
    not straight at this port". That distinction matters because the backend
    container publishes its port directly in docker-compose, which would
    otherwise leave every route below reachable with no auth at all.

    Fails closed on purpose: if INTERNAL_PROXY_KEY is unset, every request is
    rejected rather than allowed through. An unconfigured deployment exposes
    nothing instead of exposing everything.

    Note: FastAPI applies router-level dependencies to the WebSocket route
    too. On the authorized path that is fine. On the rejected path the
    HTTPException surfaces less cleanly than a websocket close frame would,
    but it still denies the connection, which is the behaviour that matters.
    """
    expected = os.environ.get("INTERNAL_PROXY_KEY")
    if not expected:
        raise HTTPException(503, "Mobile API unavailable: INTERNAL_PROXY_KEY is not configured on this backend.")
    # compare_digest, not ==, so a wrong key can't be recovered by timing.
    if not x_internal_key or not hmac.compare_digest(x_internal_key, expected):
        raise HTTPException(401, "Missing or invalid x-internal-key.")


router = APIRouter(
    prefix="/api/v1/mobile",
    tags=["Mobile Testing (Android)"],
    dependencies=[Depends(verify_internal_key)],
)

APK_STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage" / "mobile" / "apks"


def scope_project(
    x_scope_project: Optional[str] = Header(default=None),
    project_uuid: Optional[str] = None,
) -> Optional[str]:
    """Resolves which project this request may see.

    The header wins. backend-node sets x-scope-project only after checking that
    the signed-in user actually owns that project, and strips any copy the
    client sent — so it is a server assertion, while `project_uuid` in the query
    string is merely the caller's claim.

    The query parameter still works when no header is present, which is the
    direct-API / CI path (already gated by x-internal-key). Through the proxy a
    real user always has the header, so a forged parameter is ignored.

    None means unscoped: every project. Only reachable without the proxy, or as
    the CI runner, which legitimately spans projects.
    """
    return x_scope_project or project_uuid


def _assert_in_scope(db: Session, scope: Optional[str], application_id: Optional[int]) -> None:
    """Guards a by-id endpoint. Scoping the list endpoints alone would still
    leave /applications/5 readable across projects by guessing an id.

    Raises 404 rather than 403 on a mismatch: 403 would confirm that the id
    exists and belongs to somebody else, which is itself a small leak.
    """
    if scope is None:
        return
    if application_id is None:
        raise HTTPException(404, "Not found.")
    app = db.get(MobileApplication, application_id)
    if app is None or app.project_uuid != scope:
        raise HTTPException(404, "Not found.")


def _artifact_url(storage_path: Optional[str]) -> Optional[str]:
    """Render a stored artifact location as something a browser can fetch.

    storage_path holds one of two forms since evidence moved to object storage:
    an absolute Supabase Storage URL, or the legacy repo-relative disk path.
    Absolute URLs pass through untouched; local paths keep their leading slash
    and backslash normalisation so historic rows still resolve through the
    /storage mount.
    """
    if not storage_path:
        return None
    if storage_path.startswith("http://") or storage_path.startswith("https://"):
        return storage_path
    return f"/{storage_path.replace(chr(92), '/')}"


def _application_id_for_execution(db: Session, execution: MobileExecution) -> Optional[int]:
    """Executions carry no application of their own; they reach one through
    their test. Returns None when that chain is broken, which _assert_in_scope
    treats as out of scope (fail closed)."""
    test = db.get(MobileTest, execution.test_id) if execution.test_id else None
    return test.application_id if test else None



# ── Capabilities ────────────────────────────────────────────────────────

@router.get("/capabilities")
def get_capabilities():
    from mobile.ai_gateway import is_enabled as _ai_enabled
    from mobile import emulator_manager
    return {
        "platform": "android",
        "automation": ["appium2", "uiautomator2", "adb"],
        "features": {
            "autoheal": True,
            "video": True,
            "live_view": True,
            "network_profiles": False,
            "gps": False,
            "ai_gateway": _ai_enabled(),
            "visual": False,
            "emulator_auto_start": emulator_manager.is_enabled(),
        },
        "adapter_version": "1.0.0",
    }


@router.post("/devices/provision", status_code=status.HTTP_202_ACCEPTED)
def provision_device(background_tasks: BackgroundTasks):
    """Warm up an on-demand emulator now (e.g. before a demo) so the first
    real run doesn't pay the cold-boot cost. Requires EMULATOR_AUTO_START=1."""
    from mobile import emulator_manager
    if not emulator_manager.is_enabled():
        raise HTTPException(400, "On-demand emulators are disabled. Set EMULATOR_AUTO_START=1.")
    if emulator_manager.managed_serials():
        return {"status": "already_running", "serials": emulator_manager.managed_serials()}
    background_tasks.add_task(emulator_manager.launch, None)
    return {"status": "provisioning", "avds": emulator_manager.list_avds()}


# ── Applications ────────────────────────────────────────────────────────

@router.post("/applications", status_code=status.HTTP_201_CREATED)
async def upload_application(
    file: UploadFile = File(...),
    project_id: Optional[int] = None,
    scope: Optional[str] = Depends(scope_project),
    db: Session = Depends(get_db),
):
    """Ingest an APK into the caller's project.

    The project comes from `scope` (the verified x-scope-project header, or the
    query parameter on the direct API path) — deliberately NOT a form field.
    backend-node cannot inspect a multipart body without buffering the whole
    upload, so a form field could not be ownership-checked and would be the one
    unverified way into this schema.
    """
    if not file.filename:
        raise HTTPException(400, "No filename provided.")

    APK_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = APK_STORAGE_DIR / f"_upload_{uuid.uuid4().hex}.apk"
    with tmp_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        validate_apk_file(str(tmp_path), file.filename)
        metadata = extract_metadata(str(tmp_path), file.filename)
    except ApkValidationError as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(422, f"APK validation failed: {exc}")

    final_path = APK_STORAGE_DIR / f"{metadata.sha256}.apk"
    if not final_path.exists():
        tmp_path.rename(final_path)
    else:
        tmp_path.unlink(missing_ok=True)

    existing_version = db.query(MobileApplicationVersion).filter(
        MobileApplicationVersion.sha256 == metadata.sha256
    ).first()
    def _claim(application: MobileApplication) -> None:
        """Settle which project an existing application row belongs to.

        Applications are keyed by package name, so two projects uploading the
        same package land on one row. Three cases, and the middle one is the
        reason this is a function rather than an inline check:

          unowned + we have a scope -> adopt it into this project
          owned by us               -> nothing to do
          owned by someone else     -> 409, never silently reassign

        Reassigning would rip the app, its tests and its whole run history out
        of the other project's view with no error shown to anybody. Returning
        success while quietly leaving the app in a project the uploader cannot
        see is just as bad in the other direction: they would upload, get a
        200, and then find nothing. So this fails loudly instead.
        """
        if not scope:
            return
        if application.project_uuid is None:
            application.project_uuid = scope
            db.commit()
            db.refresh(application)
        elif application.project_uuid != scope:
            raise HTTPException(
                409,
                f"The package '{application.package_name}' already belongs to a different project. "
                "An APK can only live in one project; remove it there first, or upload it under a different package name.",
            )

    if existing_version:
        application = db.get(MobileApplication, existing_version.application_id)
        _claim(application)
        return {
            "application": _application_out(application),
            "version_id": existing_version.id,
            "duplicate": True,
            "compatibility_warning": _framework_compatibility_warning(existing_version.framework_hint),
        }

    application = db.query(MobileApplication).filter(
        MobileApplication.package_name == metadata.package_name
    ).first()
    if application is None:
        application = MobileApplication(
            project_id=project_id, project_uuid=scope,
            name=metadata.package_name, package_name=metadata.package_name, platform="android",
        )
        db.add(application)
        db.commit()
        db.refresh(application)
    else:
        _claim(application)

    version = MobileApplicationVersion(
        application_id=application.id,
        version_name=metadata.version_name,
        version_code=metadata.version_code,
        sha256=metadata.sha256,
        size=metadata.size,
        file_path=str(final_path),
        original_filename=file.filename,
        min_sdk=metadata.min_sdk,
        target_sdk=metadata.target_sdk,
        permissions=metadata.permissions,
        activities=metadata.activities,
        launchable_activity=metadata.launchable_activity,
        framework_hint=metadata.framework_hint,
        status="VALID",
        uploaded_at=datetime.datetime.utcnow(),
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    db.refresh(application)

    return {
        "application": _application_out(application),
        "version_id": version.id,
        "duplicate": False,
        "compatibility_warning": _framework_compatibility_warning(metadata.framework_hint),
    }


# UiAutomator2 (this engine's automation driver) walks the native Android
# accessibility tree — it can only see and interact with real Android View
# objects. This holds regardless of which app is uploaded (rule: generic,
# not app-specific), which is exactly why it matters here: some frameworks
# render their entire UI as one opaque custom-drawn surface that never
# creates that tree at all, so locator-based automation has nothing to find
# no matter how well the test is written. Surfacing this at upload time — in
# advance, not mid-demo — is the only real mitigation available without a
# framework-specific driver integration this engine doesn't have.
_FRAMEWORK_WARNINGS = {
    "FLUTTER": (
        "This APK appears to be built with Flutter. Flutter renders its entire UI as one "
        "custom-drawn surface — UiAutomator2 cannot see individual widgets inside it at all, "
        "so resource-id/text/xpath locators will very likely find nothing and most steps will "
        "fail. This engine has no Flutter-specific driver integration. If this is for a live "
        "demo, confirm with whoever built the app, or have a native/React Native build ready "
        "as a fallback."
    ),
    "REACT_NATIVE": (
        "This APK appears to be built with React Native. It generally renders to real native "
        "Android views and works with this engine, but individual components without an "
        "explicit accessibility label/testID may still be hard to target precisely — worth a "
        "quick smoke test before a live demo, not a guarantee."
    ),
    "COMPOSE": (
        "This APK appears to use Jetpack Compose. Modern Compose exposes a real accessibility "
        "tree, but only for composables the developer gave a semantics label or testTag to — "
        "unlabeled custom composables can still be invisible to locators. Worth a quick smoke "
        "test before a live demo."
    ),
}


def _framework_compatibility_warning(framework_hint: Optional[str]) -> Optional[str]:
    return _FRAMEWORK_WARNINGS.get(framework_hint)


def _application_out(app: MobileApplication) -> dict:
    return ApplicationOut.model_validate(app).model_dump()


def _scoped_application_ids(db: Session, project_uuid: str):
    """Subquery of application ids belonging to one project.

    This is the single scoping anchor for the whole mobile schema — tests,
    suites and executions have no project column of their own and reach a
    project only through application_id. Returned as a scalar subquery so the
    filter stays one SQL round trip instead of loading ids into Python.

    Keep this ABOVE the @router.get below. A plain helper placed between a
    decorator and its function silently steals that decorator, and FastAPI
    then tries to register this signature as a route (it fails on `Session`
    not being a Pydantic type, which is a confusing way to learn it).
    """
    return (
        db.query(MobileApplication.id)
        .filter(MobileApplication.project_uuid == project_uuid)
        .scalar_subquery()
    )


@router.get("/applications", response_model=List[ApplicationOut])
def list_applications(scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    """Omitting project_uuid returns everything — that keeps direct API/CI
    callers working unchanged. The UI always sends it, so what a signed-in user
    sees is scoped to the project they have selected."""
    q = db.query(MobileApplication)
    if scope:
        q = q.filter(MobileApplication.project_uuid == scope)
    return q.all()


@router.get("/applications/{application_id}", response_model=ApplicationOut)
def get_application(application_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    app = db.get(MobileApplication, application_id)
    if not app:
        raise HTTPException(404, "Application not found.")
    _assert_in_scope(db, scope, app.id)
    return app


def _latest_valid_version(db: Session, application_id: Optional[int]) -> Optional[MobileApplicationVersion]:
    if not application_id:
        return None
    return (
        db.query(MobileApplicationVersion)
        .filter(MobileApplicationVersion.application_id == application_id, MobileApplicationVersion.status == "VALID")
        .order_by(MobileApplicationVersion.uploaded_at.desc())
        .first()
    )


def _screen_map_for(db: Session, application_id: Optional[int]) -> Optional[dict]:
    v = _latest_valid_version(db, application_id)
    return v.screen_map if v and v.screen_map else None


@router.get("/applications/{application_id}/screen-map")
def get_screen_map(application_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    _assert_in_scope(db, scope, application_id)
    v = _latest_valid_version(db, application_id)
    if not v:
        raise HTTPException(404, "No valid APK version for this application.")
    return {
        "application_version_id": v.id,
        "captured_at": v.screen_map_captured_at.isoformat() if v.screen_map_captured_at else None,
        "screen_map": v.screen_map,
    }


@router.post("/applications/{application_id}/explore", status_code=status.HTTP_202_ACCEPTED)
def explore_application(application_id: int, device_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Crawl the app on a device to build/refresh its ScreenMap — the real
    screens + elements + navigation that grounds AI test generation. Runs in
    the background (~1-3 min). Generic: no app-specific input required."""
    version = _latest_valid_version(db, application_id)
    if not version:
        raise HTTPException(404, "No valid APK version for this application.")
    device = db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(400, "device_id not found (see GET /devices).")
    if device.status == "RESERVED":
        raise HTTPException(409, f"Device {device.serial} is reserved by another run.")

    from mobile.explorer import run_exploration
    background_tasks.add_task(run_exploration, version.id, device_id)
    return {"status": "exploring", "application_version_id": version.id, "device_id": device_id}


# ── Devices ────────────────────────────────────────────────────────────

@router.get("/devices", response_model=List[DeviceOut])
def list_devices(db: Session = Depends(get_db)):
    devices = device_manager.sync_devices(db)
    out = []
    for d in devices:
        row = DeviceOut.model_validate(d).model_dump()
        row["last_health_check"] = d.last_health_check.isoformat() if d.last_health_check else None
        out.append(row)
    return out


@router.post("/devices/{device_id}/health")
def check_device_health(device_id: int, db: Session = Depends(get_db)):
    device = db.get(MobileDevice, device_id)
    if not device:
        raise HTTPException(404, "Device not found.")
    result = device_manager.health_check(device.serial)
    device.last_health_check = datetime.datetime.utcnow()
    device.last_health_detail = result
    if not result["healthy"] and device.status != "RESERVED":
        device.status = "UNHEALTHY"
    db.commit()
    return result


# ── Tests ──────────────────────────────────────────────────────────────

@router.post("/tests")
def create_test(payload: TestCreateRequest, db: Session = Depends(get_db)):
    test = MobileTest(
        name=payload.name,
        description=payload.description,
        application_id=payload.application_id,
        steps=[s.dict() for s in payload.steps],
        evidence_policy=payload.evidence_policy.dict() if payload.evidence_policy else None,
        healing_policy=payload.healing_policy.dict() if payload.healing_policy else None,
        risk_level=payload.risk_level,
    )
    db.add(test)
    db.commit()
    db.refresh(test)

    suite_id = None
    if _autorun_possible(payload.device_id):
        suite_id = _create_suite_and_run(
            db, name=payload.name, application_id=payload.application_id,
            device_id=payload.device_id, source="NL_GENERATE", tests=[test],
        )

    return {"id": test.id, "name": test.name, "suite_id": suite_id}


# ── Suites (a group of tests from one upload, run together) ──────────────

def _actual_result_summary(execution: MobileExecution) -> Optional[str]:
    """One-line 'what actually happened' for the client report, derived from
    the execution's own recorded outcome — not re-inferred."""
    if execution is None:
        return None
    rj = execution.result_json or {}
    if execution.status == "PASSED":
        return "All steps passed."
    if execution.status == "SKIPPED":
        return f"Skipped — {rj.get('skipped_reason') or 'not automatable'}."
    if rj.get("error"):
        return str(rj["error"])[:400]
    failed_steps = [s for s in sorted(execution.step_results, key=lambda x: x.step_index) if s.status in ("FAILED", "BLOCKED")]
    if failed_steps:
        s = failed_steps[0]
        return f"Step {s.step_index} ({s.action}) {s.status}: {(s.actual or '')[:300]}"
    return execution.status


def _suite_out(db: Session, suite: MobileTestSuite) -> dict:
    tests = db.query(MobileTest).filter(MobileTest.suite_id == suite.id).order_by(MobileTest.id).all()
    # selectinload is load-bearing, not a micro-optimisation. Further down,
    # _actual_result_summary() reads execution.step_results, which is a lazily
    # loaded relationship — so without this, rendering a suite fires one extra
    # SELECT per execution. On the local SQLite this engine was built against a
    # round trip is ~0.1ms and that was invisible; against Supabase over the
    # pooler it is ~500ms, and a 124-test suite took 65 SECONDS to return.
    # Eager-loading collapses those 124 queries into a single
    # "WHERE execution_id IN (...)". Same rows, same output.
    executions = (
        db.query(MobileExecution)
        .options(selectinload(MobileExecution.step_results))
        .filter(MobileExecution.suite_id == suite.id)
        .order_by(MobileExecution.id)
        .all()
    )
    exec_by_test = {e.test_id: e for e in executions}

    test_rows = []
    passed = failed = skipped = 0
    for t in tests:
        e = exec_by_test.get(t.id)
        st = e.status if e else "QUEUED"
        meta = t.source_meta or {}
        if st == "PASSED":
            passed += 1
        elif st == "SKIPPED":
            skipped += 1
        elif st in ("FAILED", "BLOCKED", "REQUIRES_REVIEW", "INFRA_FAILURE", "CANCELLED"):
            failed += 1
        result = (e.result_json or {}) if e else {}
        test_rows.append({
            "test_id": t.id, "name": t.name, "execution_id": e.id if e else None,
            "status": st, "duration_ms": e.duration_ms if e else None,
            "video_url": _artifact_url(e.video_path) if e else None,
            "test_case_id": meta.get("test_case_id"),
            "module": meta.get("module"),
            "priority": meta.get("priority"),
            "expected_result": meta.get("expected_result"),
            "actual_result": _actual_result_summary(e) if e else None,
            "not_automatable_reason": meta.get("not_automatable_reason") if meta.get("automatable") is False else None,
        })

    application = db.get(MobileApplication, suite.application_id) if suite.application_id else None
    return {
        "id": suite.id, "name": suite.name, "source": suite.source, "status": suite.status,
        "application_id": suite.application_id, "application_name": application.package_name if application else None,
        "device_id": suite.device_id,
        "test_count": len(tests), "passed_count": passed, "failed_count": failed, "skipped_count": skipped,
        "combined_video_url": _artifact_url(suite.combined_video_path),
        "created_at": suite.created_at.isoformat() if suite.created_at else None,
        "completed_at": suite.completed_at.isoformat() if suite.completed_at else None,
        "tests": test_rows,
    }


@router.get("/suites")
def list_suites(limit: int = 20, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    q = db.query(MobileTestSuite)
    if scope:
        q = q.filter(MobileTestSuite.application_id.in_(_scoped_application_ids(db, scope)))
    suites = q.order_by(MobileTestSuite.id.desc()).limit(limit).all()
    return [_suite_out(db, s) for s in suites]


@router.get("/suites/{suite_id}")
def get_suite(suite_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    suite = db.get(MobileTestSuite, suite_id)
    if not suite:
        raise HTTPException(404, "Suite not found.")
    _assert_in_scope(db, scope, suite.application_id)
    return _suite_out(db, suite)


@router.post("/suites/{suite_id}/run")
def run_suite_manually(suite_id: int, db: Session = Depends(get_db)):
    """Manual trigger for a suite that did NOT auto-run, or needs to run again:
    one that was created without a device, was interrupted by a backend
    restart, or already completed and you want a fresh run. Auto-run only ever
    happens once, at creation time — this is the explicit re-run path."""
    suite = db.get(MobileTestSuite, suite_id)
    if not suite:
        raise HTTPException(404, "Suite not found.")
    if suite.status == "RUNNING":
        raise HTTPException(409, "Suite is already running.")
    if not suite.device_id:
        raise HTTPException(400, "This suite has no device assigned — cannot run it.")
    if not db.query(MobileTest).filter(MobileTest.suite_id == suite.id).first():
        raise HTTPException(400, "This suite has no tests.")

    suite.status = "QUEUED"
    suite.completed_at = None
    suite.combined_video_path = None
    db.commit()

    from mobile.suite_engine import run_suite
    threading.Thread(target=run_suite, args=(suite.id,), daemon=True).start()
    return _suite_out(db, suite)


def _ground_from_recent_hierarchy(db: Session, application_id: Optional[int], max_screens: int = 8) -> Optional[List[Dict[str, str]]]:
    """Best-effort grounding for AI generation: a SINGLE stored hierarchy is
    just one screen mid-flow (e.g. a checkout form) and is a poor proxy for
    'what does this whole app look like' — it starves the model of the
    catalog/detail/etc. elements it actually needs. Aggregate elements across
    the last several distinct captures instead, so multi-screen objectives
    ("open a product, add to cart, check out") have a real chance of landing
    on the right resource-id for each step. No live device session required.
    Returns None if nothing has ever been captured for this app yet."""
    if not application_id:
        return None

    rows = (
        db.query(MobileEvidence)
        .join(MobileExecution, MobileEvidence.execution_id == MobileExecution.id)
        .join(MobileTest, MobileExecution.test_id == MobileTest.id)
        .filter(MobileTest.application_id == application_id, MobileEvidence.artifact_type == "UI_HIERARCHY")
        .order_by(MobileEvidence.captured_at.desc())
        .limit(max_screens)
        .all()
    )
    if not rows:
        return None

    storage_root = Path(__file__).resolve().parent.parent
    from mobile.locators import parse_hierarchy

    elements = []
    seen = set()
    for row in rows:
        xml_path = storage_root / row.storage_path
        if not xml_path.exists():
            continue
        try:
            nodes = parse_hierarchy(xml_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for n in nodes:
            rid = n.attrs.get("resource-id", "")
            text = n.attrs.get("text", "")
            desc = n.attrs.get("content-desc", "")
            if not (rid or text or desc):
                continue
            key = (rid, text, desc)
            if key in seen:
                continue
            seen.add(key)
            elements.append({
                "resource_id": rid, "text": text, "content_desc": desc,
                "class": n.attrs.get("class", ""), "clickable": n.attrs.get("clickable", ""),
            })
    return elements or None


@router.post("/tests/generate")
async def generate_test(
    text: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    application_id: Optional[int] = Form(None),
    device_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """AI-assisted draft generation from a natural-language objective, a pasted
    requirement/user story, or an uploaded PDF/DOCX/XLSX/TXT (a test-case
    sheet, a user-story doc, whatever the client hands over).

    Returns the generated steps as a DRAFT so the caller can review them
    (including any hallucination flags). If `device_id` is given, the draft
    is ALSO persisted as a test and auto-run as a suite-of-one against that
    device+APK immediately — no separate save/run step."""
    from mobile.ai_gateway import generate_test_steps, is_enabled

    if not is_enabled():
        raise HTTPException(503, "AI generation is disabled: set OPENAI_API_KEY in Apptesting/backend/.env to enable it.")
    if not text and not file:
        raise HTTPException(400, "Provide either 'text' or a 'file' (PDF/DOCX/XLSX/TXT).")

    objective_text = text or ""
    if file is not None:
        from mobile.document_ingest import DocumentExtractionError, extract_text
        raw = await file.read()
        try:
            extracted = extract_text(file.filename, raw)
        except DocumentExtractionError as exc:
            raise HTTPException(422, str(exc))
        objective_text = f"{objective_text}\n\n{extracted}".strip()

    # Ground on the app's real Screen Map. If we don't have one yet and a
    # device was given, crawl the app now so this generation is grounded —
    # generic, one-time per APK build.
    screen_map = _screen_map_for(db, application_id)
    if screen_map is None and device_id and application_id:
        version = _latest_valid_version(db, application_id)
        if version:
            try:
                from mobile.explorer import run_exploration
                screen_map = run_exploration(version.id, device_id)
            except Exception as exc:
                logger.warning("Auto-exploration before generation failed (continuing ungrounded): %s", exc)
    grounding = None if screen_map else _ground_from_recent_hierarchy(db, application_id)

    from mobile.automatability import classify
    verdict = classify(objective_text)

    try:
        result = generate_test_steps(objective_text, screen_map=screen_map, grounding_elements=grounding)
    except RuntimeError as exc:
        raise HTTPException(502, f"AI generation failed: {exc}")
    except Exception as exc:
        # Anything the OpenAI SDK itself raises (rate limit, exhausted
        # credits, auth failure, network error, ...) is not a RuntimeError —
        # without this it would surface as a raw, unhandled 500 with a stack
        # trace instead of an honest, actionable error message.
        raise HTTPException(502, f"AI generation failed: {exc}")

    suite_id = None
    test_id = None
    if _autorun_possible(device_id):
        persisted_steps = [{k: v for k, v in s.items() if k != "grounded"} for s in result["steps"]]
        name = (text or "").strip()[:60] or (file.filename if file else None) or "Generated test"
        test = MobileTest(
            name=name, description=objective_text[:2000] or None,
            application_id=application_id, steps=persisted_steps, risk_level="LOW_RISK",
            source_meta={
                "automatable": verdict["automatable"],
                "not_automatable_reason": verdict["reason"],
                "needs": verdict["needs"],
            },
        )
        db.add(test)
        db.commit()
        db.refresh(test)
        test_id = test.id
        suite_id = _create_suite_and_run(
            db, name=name, application_id=application_id,
            device_id=device_id, source="NL_GENERATE", tests=[test],
        )

    return {
        "steps": result["steps"],
        "warnings": result["warnings"],
        "grounded": screen_map is not None or grounding is not None,
        "screen_map_screens": screen_map["screen_count"] if screen_map else 0,
        "grounding_element_count": len(grounding) if grounding else 0,
        "automatable": verdict["automatable"],
        "not_automatable_reason": verdict["reason"],
        "test_id": test_id,
        "suite_id": suite_id,
    }


@router.post("/tests/import")
async def import_tests(
    files: List[UploadFile] = File(...),
    device_id: Optional[int] = Form(None),
    application_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Deterministic bulk import — CSV or JSON, one or many files at once.
    No AI involved; every row/object maps directly to a MobileTest. When
    device_id is given, everything imported is grouped into one suite and
    auto-run against that device immediately after import."""
    from mobile.test_import import ImportValidationError, parse_test_file

    created = []
    errors = []
    created_rows: List[MobileTest] = []
    for f in files:
        raw = await f.read()
        try:
            parsed_tests = parse_test_file(f.filename, raw)
        except ImportValidationError as exc:
            errors.append({"file": f.filename, "error": str(exc)})
            continue

        for t in parsed_tests:
            test = MobileTest(
                name=t["name"], description=t.get("description"),
                application_id=t.get("application_id") or application_id, steps=t["steps"],
                risk_level=t.get("risk_level", "LOW_RISK"),
            )
            db.add(test)
            db.commit()
            db.refresh(test)
            created_rows.append(test)
            created.append({"id": test.id, "name": test.name, "step_count": len(test.steps), "source_file": f.filename})

    if not created and errors:
        raise HTTPException(422, {"message": "No tests could be imported.", "errors": errors})

    suite_id = None
    if created_rows and _autorun_possible(device_id):
        suite_id = _create_suite_and_run(
            db, name=files[0].filename if len(files) == 1 else f"{len(files)} imported files",
            application_id=next((t.application_id for t in created_rows if t.application_id), None),
            device_id=device_id, source="CSV_IMPORT", tests=created_rows,
        )

    return {"created": created, "errors": errors, "suite_id": suite_id}


def _autorun_possible(device_id: Optional[int]) -> bool:
    """A suite can auto-run if a device was picked, or if the platform is
    allowed to provision one on demand (EMULATOR_AUTO_START)."""
    if device_id:
        return True
    from mobile import emulator_manager
    return emulator_manager.is_enabled()


def _create_suite_and_run(
    db: Session, name: str, application_id: Optional[int], device_id: Optional[int], source: str, tests: List[MobileTest],
) -> int:
    """Groups already-created tests into a suite and kicks off run_suite() in
    the background. Shared by every bulk/auto-run creation path so 'upload
    tests, they just run, grouped in the dashboard' behaves identically no
    matter which upload format got them there. `device_id` may be None when
    EMULATOR_AUTO_START is on — run_suite() provisions an emulator itself."""
    suite = MobileTestSuite(name=name, application_id=application_id, device_id=device_id, source=source)
    db.add(suite)
    db.commit()
    db.refresh(suite)
    for t in tests:
        t.suite_id = suite.id
    db.commit()

    from mobile.suite_engine import run_suite
    threading.Thread(target=run_suite, args=(suite.id,), daemon=True).start()
    return suite.id


@router.post("/tests/generate-batch", status_code=status.HTTP_201_CREATED)
async def generate_tests_batch(
    file: UploadFile = File(...),
    application_id: Optional[int] = Form(None),
    device_id: Optional[int] = Form(None),
):
    """Flexible bulk import for a real-world test-case tracker (CSV/XLSX)
    that doesn't match the strict deterministic schema — e.g. a QA team's
    manual test sheet with a Test Case / Steps / Expected Result layout.
    Column names can vary; this detects them rather than requiring one fixed
    format. Each row is generated independently through the same AI pipeline
    as a single-document generation (same grounding, same hallucination
    flagging), as a background job — a tracker can have 100+ rows and this
    would otherwise time out as a single blocking request. When device_id is
    given, every generated test is grouped into one suite and the whole
    suite auto-runs against that device the moment generation finishes —
    no separate "now click run on each of these" step."""
    from mobile.batch_generate import BatchValidationError, start_batch_job
    from mobile.ai_gateway import is_enabled

    if not is_enabled():
        raise HTTPException(503, "AI generation is disabled: set OPENAI_API_KEY in Apptesting/backend/.env to enable it.")

    raw = await file.read()
    try:
        job = start_batch_job(file.filename, raw, application_id, device_id)
    except BatchValidationError as exc:
        raise HTTPException(422, str(exc))
    return job


@router.get("/tests/generate-batch/{job_id}")
def get_batch_job(job_id: str):
    from mobile.batch_generate import get_job

    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Batch generation job not found.")
    return job


@router.get("/tests")
def list_tests(scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    q = db.query(MobileTest)
    if scope:
        q = q.filter(MobileTest.application_id.in_(_scoped_application_ids(db, scope)))
    tests = q.order_by(MobileTest.created_at.desc()).all()
    return [{"id": t.id, "name": t.name, "description": t.description, "application_id": t.application_id,
             "steps": t.steps, "risk_level": t.risk_level, "created_at": t.created_at.isoformat()} for t in tests]


@router.get("/tests/{test_id}")
def get_test(test_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    test = db.get(MobileTest, test_id)
    if not test:
        raise HTTPException(404, "Test not found.")
    _assert_in_scope(db, scope, test.application_id)
    return {"id": test.id, "name": test.name, "description": test.description, "application_id": test.application_id,
            "steps": test.steps, "risk_level": test.risk_level}


# ── Executions ─────────────────────────────────────────────────────────

@router.post("/executions", status_code=status.HTTP_201_CREATED)
def create_execution(
    payload: ExecutionCreateRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    if payload.idempotency_key:
        existing = db.query(MobileExecution).filter(MobileExecution.idempotency_key == payload.idempotency_key).first()
        if existing:
            return _execution_out(db, existing)

    test = db.get(MobileTest, payload.test_id)
    if not test:
        raise HTTPException(404, "Test not found.")

    device = None
    if payload.device_id:
        device = db.get(MobileDevice, payload.device_id)
    elif payload.device_serial:
        device = db.query(MobileDevice).filter(MobileDevice.serial == payload.device_serial).first()
    if not device:
        # No device named. If on-demand provisioning is enabled the run will
        # boot an emulator itself (run_execution → emulator_manager); otherwise
        # this is a hard error, same as before.
        from mobile import emulator_manager
        if not emulator_manager.is_enabled():
            raise HTTPException(400, "No available device: provide device_id or device_serial (see GET /devices), or set EMULATOR_AUTO_START=1.")
    elif device.status == "RESERVED":
        raise HTTPException(409, f"Device {device.serial} is currently reserved by another execution.")

    app_version_id = payload.application_version_id
    if app_version_id is None and test.application_id:
        latest = (
            db.query(MobileApplicationVersion)
            .filter(MobileApplicationVersion.application_id == test.application_id, MobileApplicationVersion.status == "VALID")
            .order_by(MobileApplicationVersion.uploaded_at.desc())
            .first()
        )
        app_version_id = latest.id if latest else None

    policy = payload.execution_policy or ExecutionPolicy()

    execution = MobileExecution(
        idempotency_key=payload.idempotency_key,
        test_id=test.id,
        application_version_id=app_version_id,
        device_id=device.id if device else None,
        environment=payload.environment,
        status="QUEUED",
        environment_snapshot={
            "execution_policy": policy.dict(),
            "data_set": payload.data_set or {},
        },
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    background_tasks.add_task(run_execution, execution.id)
    return _execution_out(db, execution)


def _execution_out(db: Session, execution: MobileExecution) -> dict:
    db.refresh(execution)
    return {
        "id": execution.id,
        "execution_uid": execution.execution_uid,
        "status": execution.status,
        "test_id": execution.test_id,
        "device_id": execution.device_id,
        "started_at": execution.started_at.isoformat() if execution.started_at else None,
        "completed_at": execution.completed_at.isoformat() if execution.completed_at else None,
        "duration_ms": execution.duration_ms,
        "result_json": execution.result_json,
        "step_results": [
            {
                "step_index": s.step_index, "action": s.action, "status": s.status,
                "locator": s.locator, "resolved_locator": s.resolved_locator,
                "actual": s.actual, "duration_ms": s.duration_ms,
                "failure_id": s.failure_id, "healing_id": s.healing_id,
            }
            for s in sorted(execution.step_results, key=lambda x: x.step_index)
        ],
    }


@router.get("/executions")
def list_executions(limit: int = 50, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    """Recent executions regardless of how they were started (UI or API) —
    lets the frontend show/reattach to any run, not just ones it initiated."""
    q = db.query(MobileExecution)
    if scope:
        # Two hops: execution -> test -> application -> project.
        scoped_tests = (
            db.query(MobileTest.id)
            .filter(MobileTest.application_id.in_(_scoped_application_ids(db, scope)))
            .scalar_subquery()
        )
        q = q.filter(MobileExecution.test_id.in_(scoped_tests))
    rows = q.order_by(MobileExecution.id.desc()).limit(limit).all()
    out = []
    for e in rows:
        test = db.get(MobileTest, e.test_id)
        out.append({
            "id": e.id, "status": e.status, "test_id": e.test_id,
            "test_name": test.name if test else None,
            "device_id": e.device_id,
            "started_at": e.started_at.isoformat() if e.started_at else None,
            "completed_at": e.completed_at.isoformat() if e.completed_at else None,
            "duration_ms": e.duration_ms,
        })
    return out


@router.get("/executions/{execution_id}")
def get_execution(execution_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    execution = db.get(MobileExecution, execution_id)
    if not execution:
        raise HTTPException(404, "Execution not found.")
    _assert_in_scope(db, scope, _application_id_for_execution(db, execution))
    return _execution_out(db, execution)


@router.post("/executions/{execution_id}/cancel")
def cancel_execution(execution_id: int, db: Session = Depends(get_db)):
    execution = db.get(MobileExecution, execution_id)
    if not execution:
        raise HTTPException(404, "Execution not found.")
    execution.cancel_requested = True
    db.commit()
    return {"status": "cancel_requested"}


# ── Compatibility runs (one test, many devices, run concurrently) ────────

@router.post("/compatibility-runs", status_code=status.HTTP_201_CREATED)
def create_compatibility_run(
    payload: CompatibilityRunCreateRequest,
    db: Session = Depends(get_db),
):
    test = db.get(MobileTest, payload.test_id)
    if not test:
        raise HTTPException(404, "Test not found.")

    device_ids = list(dict.fromkeys(payload.device_ids))  # dedupe, keep order
    if len(device_ids) != len(payload.device_ids):
        raise HTTPException(400, "device_ids contains duplicates — each device can only run this test once per compatibility run.")

    devices = db.query(MobileDevice).filter(MobileDevice.id.in_(device_ids)).all()
    devices_by_id = {d.id: d for d in devices}
    missing = [did for did in device_ids if did not in devices_by_id]
    if missing:
        raise HTTPException(404, f"Device id(s) not found: {missing}")
    unavailable = [d.serial for d in devices if d.status == "RESERVED"]
    if unavailable:
        raise HTTPException(409, f"Device(s) already reserved by another execution: {unavailable}")

    app_version_id = payload.application_version_id
    if app_version_id is None and test.application_id:
        latest = (
            db.query(MobileApplicationVersion)
            .filter(MobileApplicationVersion.application_id == test.application_id, MobileApplicationVersion.status == "VALID")
            .order_by(MobileApplicationVersion.uploaded_at.desc())
            .first()
        )
        app_version_id = latest.id if latest else None

    policy = payload.execution_policy or ExecutionPolicy()

    run = MobileCompatibilityRun(test_id=test.id, status="RUNNING")
    db.add(run)
    db.commit()
    db.refresh(run)

    execution_ids = []
    for device_id in device_ids:
        execution = MobileExecution(
            test_id=test.id,
            application_version_id=app_version_id,
            device_id=device_id,
            compatibility_run_id=run.id,
            environment=payload.environment,
            status="QUEUED",
            environment_snapshot={"execution_policy": policy.dict(), "data_set": {}},
        )
        db.add(execution)
        db.commit()
        db.refresh(execution)
        execution_ids.append(execution.id)

    # NOT background_tasks.add_task() in a loop: Starlette's BackgroundTasks
    # awaits each task in the list one at a time, so multiple tasks queued
    # from the SAME request run sequentially even though each executes in a
    # worker thread — that would silently turn "run on N devices at once"
    # into a hidden queue while still reporting RUNNING/QUEUED as if it were
    # parallel. Spawning independent OS threads is what actually makes every
    # device start immediately instead of waiting for the previous one.
    for execution_id in execution_ids:
        threading.Thread(target=run_execution, args=(execution_id,), daemon=True).start()

    return _compatibility_run_out(db, run)


def _compatibility_run_out(db: Session, run: MobileCompatibilityRun) -> dict:
    executions = db.query(MobileExecution).filter(MobileExecution.compatibility_run_id == run.id).all()
    device_rows = []
    all_terminal = True
    for e in executions:
        device = db.get(MobileDevice, e.device_id) if e.device_id else None
        if e.status not in NON_RETRYABLE_TERMINAL_STATUSES:
            all_terminal = False
        device_rows.append({
            "execution_id": e.id,
            "device_id": e.device_id,
            "device_label": f"{device.model} ({device.serial})" if device else None,
            "status": e.status,
            "duration_ms": e.duration_ms,
            "failure_summary": (e.result_json or {}).get("failures") if e.result_json else None,
        })

    if all_terminal and run.status != "COMPLETED":
        run.status = "COMPLETED"
        run.completed_at = datetime.datetime.utcnow()
        db.commit()
        db.refresh(run)

    test = db.get(MobileTest, run.test_id)
    passed = sum(1 for d in device_rows if d["status"] == "PASSED")
    return {
        "id": run.id,
        "test_id": run.test_id,
        "test_name": test.name if test else None,
        "status": run.status,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "device_count": len(device_rows),
        "passed_count": passed,
        "devices": device_rows,
    }


@router.get("/compatibility-runs")
def list_compatibility_runs(limit: int = 20, db: Session = Depends(get_db)):
    runs = db.query(MobileCompatibilityRun).order_by(MobileCompatibilityRun.id.desc()).limit(limit).all()
    return [_compatibility_run_out(db, r) for r in runs]


@router.get("/compatibility-runs/{run_id}")
def get_compatibility_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(MobileCompatibilityRun, run_id)
    if not run:
        raise HTTPException(404, "Compatibility run not found.")
    return _compatibility_run_out(db, run)


@router.get("/executions/{execution_id}/evidence")
def get_execution_evidence(execution_id: int, scope: Optional[str] = Depends(scope_project), db: Session = Depends(get_db)):
    _execution = db.get(MobileExecution, execution_id)
    if _execution is None:
        raise HTTPException(404, "Execution not found.")
    _assert_in_scope(db, scope, _application_id_for_execution(db, _execution))
    rows = db.query(MobileEvidence).filter(MobileEvidence.execution_id == execution_id).order_by(MobileEvidence.captured_at).all()
    return [
        {
            "id": r.id, "step_index": r.step_index, "artifact_type": r.artifact_type,
            "url": _artifact_url(r.storage_path), "sha256": r.sha256,
            "mime_type": r.mime_type, "size": r.size, "redaction_status": r.redaction_status,
            "captured_at": r.captured_at.isoformat(),
        }
        for r in rows
    ]


# ── Healing ────────────────────────────────────────────────────────────

@router.get("/healing/history", response_model=List[HealingRecordOut])
def healing_history(
    test_id: Optional[int] = None, execution_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    q = db.query(MobileHealingRecord)
    if test_id:
        q = q.filter(MobileHealingRecord.test_id == test_id)
    if execution_id:
        q = q.filter(MobileHealingRecord.execution_id == execution_id)
    return q.order_by(MobileHealingRecord.created_at.desc()).limit(200).all()


@router.post("/healing/{healing_id}/approve")
def approve_healing(
    healing_id: int, background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    record = db.get(MobileHealingRecord, healing_id)
    if not record:
        raise HTTPException(404, "Healing record not found.")
    if record.status not in ("PENDING_APPROVAL", "REQUIRES_REVIEW"):
        raise HTTPException(409, f"Healing record is in status '{record.status}', not awaiting approval.")

    # replacement_locator is only pre-populated on the AUTO_APPLY path; a human
    # approving a PENDING_APPROVAL/REQUIRES_REVIEW record is authorizing the
    # top-scored candidate the engine already surfaced (never a locator we
    # invent here — it must be one of the candidates that was actually shown).
    approved_locator = record.replacement_locator or (
        record.candidate_locators[0]["locator"] if record.candidate_locators else None
    )
    if not approved_locator:
        raise HTTPException(422, "Healing record has no candidate locator to apply.")

    record.replacement_locator = approved_locator
    record.status = "APPROVED"
    record.resolved_at = datetime.datetime.utcnow()
    db.commit()

    prior_execution = db.get(MobileExecution, record.execution_id)
    if prior_execution is None:
        return {"status": "approved", "note": "Original execution not found; no re-run triggered."}

    new_execution = MobileExecution(
        test_id=prior_execution.test_id,
        application_version_id=prior_execution.application_version_id,
        device_id=prior_execution.device_id,
        environment=prior_execution.environment,
        status="QUEUED",
        environment_snapshot={
            **(prior_execution.environment_snapshot or {}),
            "pre_approved_healing": {str(record.step_index): record.replacement_locator},
            "triggered_by_healing_approval": healing_id,
        },
    )
    db.add(new_execution)
    db.commit()
    db.refresh(new_execution)
    background_tasks.add_task(run_execution, new_execution.id)

    return {"status": "approved", "rerun_execution_id": new_execution.id}


@router.post("/healing/{healing_id}/reject")
def reject_healing(healing_id: int, db: Session = Depends(get_db)):
    record = db.get(MobileHealingRecord, healing_id)
    if not record:
        raise HTTPException(404, "Healing record not found.")
    record.status = "REJECTED"
    record.resolved_at = datetime.datetime.utcnow()
    db.commit()
    return {"status": "rejected"}


@router.post("/healing/{healing_id}/rollback")
def rollback_healing(healing_id: int, db: Session = Depends(get_db)):
    record = db.get(MobileHealingRecord, healing_id)
    if not record:
        raise HTTPException(404, "Healing record not found.")

    execution = db.get(MobileExecution, record.execution_id)
    app_version = db.get(MobileApplicationVersion, execution.application_version_id) if execution and execution.application_version_id else None
    application = db.get(MobileApplication, app_version.application_id) if app_version else None
    if application:
        from mobile.schemas import Locator
        original = Locator(**record.original_locator)
        mem = locator_memory.find_by_original_locator(db, application.id, application.package_name, original)
        if mem:
            locator_memory.invalidate(db, mem)

    record.status = "ROLLED_BACK"
    record.resolved_at = datetime.datetime.utcnow()
    db.commit()
    return {"status": "rolled_back"}


# ── Live streaming ─────────────────────────────────────────────────────

@router.websocket("/executions/{execution_id}/ws")
async def execution_live_socket(websocket: WebSocket, execution_id: int):
    """Live event/frame feed for one execution: step_started/step_completed,
    healing_*, evidence, failure, status, video_ready, and periodic `frame`
    (base64 device screenshot) events. New connections replay recent history
    so a late-opening tab still sees what already happened."""
    await event_bus.connect(execution_id, websocket)
    try:
        while True:
            await websocket.receive_text()  # client sends nothing meaningful; just detect disconnect
    except WebSocketDisconnect:
        pass
    finally:
        event_bus.disconnect(execution_id, websocket)
