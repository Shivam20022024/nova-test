"""
MobileTestEngine — the golden-path orchestrator (section 184):

  device alloc -> health check -> Appium session -> for each step:
    execute -> on locator failure: AutoHeal -> validate -> re-execute ->
    evidence -> failure classification -> result -> cleanup

Runs synchronously in a worker thread (invoked via FastAPI BackgroundTasks,
which runs sync callables off the event loop) and owns its own DB session —
never share a SQLAlchemy session across threads.
"""
from __future__ import annotations

import datetime
import traceback
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from mobile import device_manager
from mobile.actions import ActionContext, ActionOutcome, execute_action
from mobile.appium_manager import (
    AppiumServerHandle,
    create_uiautomator2_session,
    quit_session,
    start_server,
    stop_server,
)
from mobile import evidence as evidence_module
from mobile import failure as failure_module
from mobile.healing import engine as healing_engine
from mobile.healing import memory as locator_memory
from mobile.live import FrameStreamer, event_bus
from mobile.video import ScreenRecorder
from mobile.locators import (
    ElementNotFoundError,
    build_screen_signature,
    capture_hierarchy_xml,
    get_current_activity,
    get_current_package,
    parse_hierarchy,
)
from mobile.models import (
    MobileApplication,
    MobileApplicationVersion,
    MobileDevice,
    MobileExecution,
    MobileHealingRecord,
    MobileStepResult,
    MobileTest,
)
from mobile.schemas import ExecutionPolicy, Locator, TestStep
from mobile.actions import LOCATOR_DEPENDENT_ACTIONS
from mobile.database import SessionLocal
from utils.logger import get_logger

logger = get_logger("mobile.engine")

NON_RETRYABLE_TERMINAL_STATUSES = {"PASSED", "FAILED", "BLOCKED", "CANCELLED", "REQUIRES_REVIEW", "INFRA_FAILURE"}


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _ms_between(start: datetime.datetime, end: datetime.datetime) -> int:
    return int((end - start).total_seconds() * 1000)


def _emit(execution_id: int, event: str, **fields) -> None:
    event_bus.emit(execution_id, {"event": event, **fields})


def _evidence_url(row) -> str:
    return f"/{row.storage_path.replace(chr(92), '/')}"


def execute_test_steps(db, driver, execution, test, ctx, policy, application, app_version, app_package):
    """The actual step-by-step run: execute -> heal on locator failure ->
    evidence -> failure classification -> stop at first unresolved hard
    failure. Pulled out of run_execution() so a suite run (mobile/
    suite_engine.py) can run several tests back-to-back on one already-open
    Appium session/device/recording instead of tearing all of that down and
    rebuilding it per test — this function is the only part that actually
    differs between "one test" and "one test out of many in a suite."
    Returns (overall_status, artifact_ids, failure_ids)."""
    execution_id = execution.id
    overall_status = "PASSED"
    artifacts = []
    failures = []

    for idx, step_dict in enumerate(test.steps):
        db.refresh(execution)
        if execution.cancel_requested:
            overall_status = "CANCELLED"
            break

        step = TestStep(**step_dict)
        pre_approved = (execution.environment_snapshot or {}).get("pre_approved_healing", {})
        original_locator_for_memory: Optional[Locator] = None
        if str(idx) in pre_approved:
            original_locator_for_memory = step.locator
            step = step.copy(update={"locator": Locator(**pre_approved[str(idx)])})

        step_row = MobileStepResult(
            execution_id=execution.id, step_index=idx, action=step.action, status="RUNNING",
            locator=step.locator.dict() if step.locator else None, started_at=_now(),
        )
        db.add(step_row)
        db.commit()
        db.refresh(step_row)
        _emit(execution_id, "step_started", step_index=idx, action=step.action,
              locator=step.locator.dict() if step.locator else None)

        outcome = _run_single_action(driver, step, ctx)
        healed = False

        if outcome.status == "PASSED" and original_locator_for_memory is not None and application is not None:
            # A human-approved healing candidate just ran clean on its first
            # try (the pipeline in _attempt_heal never triggered because the
            # substituted locator worked immediately) — commit it to memory
            # now so the *next* independent run reuses it automatically
            # instead of asking for approval again.
            xml = capture_hierarchy_xml(driver)
            screen_sig = build_screen_signature(get_current_package(driver) or "", get_current_activity(driver), parse_hierarchy(xml))
            locator_memory.record_success(
                db=db, application_id=application.id, package_name=app_package,
                screen_signature=screen_sig,
                element_signature=healing_engine.build_element_signature_stub(original_locator_for_memory),
                original_locator=original_locator_for_memory, successful_locator=step.locator,
                element_attributes=None, app_version=app_version.version_name if app_version else None,
                was_healing=True,
            )

        if (
            outcome.status == "FAILED"
            and outcome.error_code == "ELEMENT_NOT_FOUND"
            and step.action in LOCATOR_DEPENDENT_ACTIONS
            and step.locator is not None
            and policy.healing.enabled
        ):
            execution.status = "HEALING"
            db.commit()
            _emit(execution_id, "healing_started", step_index=idx, original_locator=step.locator.dict())
            outcome, healed, healing_id = _attempt_heal(
                db, driver, execution, idx, test, step, app_package, application, app_version, policy, ctx,
            )
            step_row.healing_id = healing_id
            execution.status = "RUNNING"
            db.commit()
            _emit(execution_id, "healing_result", step_index=idx, healing_id=healing_id,
                  healed=healed, status=outcome.status)

        step_row.status = "HEALED" if healed else outcome.status
        step_row.actual = outcome.actual
        step_row.resolved_locator = outcome.resolved_locator
        step_row.completed_at = _now()
        step_row.duration_ms = _ms_between(step_row.started_at, step_row.completed_at)
        db.commit()
        _emit(execution_id, "step_completed", step_index=idx, action=step.action,
              status=step_row.status, duration_ms=step_row.duration_ms,
              actual=outcome.actual, error=outcome.error)

        # Evidence capture per policy
        should_shot = (
            step.action == "TAKE_SCREENSHOT"
            or policy.evidence.screenshot_mode in ("EVERY_STEP", "FULL")
            or (outcome.status in ("FAILED", "BLOCKED") and policy.evidence.screenshot_mode != "NONE")
        )
        if should_shot:
            try:
                ev = evidence_module.capture_screenshot(db, execution.id, idx, driver)
                artifacts.append(ev.id)
                _emit(execution_id, "evidence", artifact_type="SCREENSHOT", step_index=idx, url=_evidence_url(ev))
            except Exception as exc:
                logger.warning("Screenshot capture failed for step %s: %s", idx, exc)

        if step.action == "CAPTURE_HIERARCHY" or (outcome.status in ("FAILED", "BLOCKED") and policy.evidence.capture_hierarchy_on_failure):
            try:
                ev = evidence_module.capture_hierarchy(db, execution.id, idx, driver)
                artifacts.append(ev.id)
                _emit(execution_id, "evidence", artifact_type="UI_HIERARCHY", step_index=idx, url=_evidence_url(ev))
            except Exception as exc:
                logger.warning("Hierarchy capture failed for step %s: %s", idx, exc)

        if outcome.status in ("FAILED", "BLOCKED"):
            failure_row = failure_module.classify_and_record(
                db, execution.id, idx, outcome.error, outcome.error_code, evidence_refs=artifacts[-2:],
            )
            step_row.failure_id = failure_row.id
            failures.append(failure_row.id)
            db.commit()
            _emit(execution_id, "failure", step_index=idx, category=failure_row.category,
                  error_code=failure_row.error_code, message=failure_row.message)

            if outcome.status == "BLOCKED":
                overall_status = "REQUIRES_REVIEW"
            else:
                overall_status = "FAILED"
            break  # sequential golden-path model: stop at first unresolved hard failure

    return overall_status, artifacts, failures


def run_execution(execution_id: int) -> None:
    """Entry point invoked from the API layer via BackgroundTasks."""
    db: Session = SessionLocal()
    driver = None
    appium_handle: Optional[AppiumServerHandle] = None
    device: Optional[MobileDevice] = None
    frame_streamer: Optional[FrameStreamer] = None
    recorder: Optional[ScreenRecorder] = None
    event_bus.clear(execution_id)

    try:
        execution = db.get(MobileExecution, execution_id)
        if execution is None:
            logger.error("run_execution: execution %s not found", execution_id)
            return

        test = db.get(MobileTest, execution.test_id)
        app_version = db.get(MobileApplicationVersion, execution.application_version_id) if execution.application_version_id else None
        application = db.get(MobileApplication, app_version.application_id) if app_version else None
        device = db.get(MobileDevice, execution.device_id) if execution.device_id else None

        policy = ExecutionPolicy()
        if execution.environment_snapshot and "execution_policy" in execution.environment_snapshot:
            try:
                policy = ExecutionPolicy(**execution.environment_snapshot["execution_policy"])
            except Exception:
                policy = ExecutionPolicy()

        execution.status = "ALLOCATING_DEVICE"
        db.commit()
        _emit(execution_id, "status", status="ALLOCATING_DEVICE")

        if device is None:
            from mobile import emulator_manager
            if emulator_manager.is_enabled():
                try:
                    device = emulator_manager.acquire_device(db)
                    execution.device_id = device.id
                    db.commit()
                    _emit(execution_id, "status", status="ALLOCATING_DEVICE", detail=f"provisioned {device.serial}")
                except Exception as exc:
                    _fail_infra(db, execution, f"On-demand device provisioning failed: {exc}", "DEVICE_UNAVAILABLE")
                    return
            else:
                _fail_infra(db, execution, "No device assigned to this execution.", "DEVICE_UNAVAILABLE")
                return
        try:
            device_manager.reserve_device(db, device.id, execution.execution_uid)
        except device_manager.DeviceUnavailableError as exc:
            _fail_infra(db, execution, str(exc), "DEVICE_UNAVAILABLE")
            return

        health = device_manager.health_check(device.serial)
        if not health["healthy"]:
            _fail_infra(db, execution, f"Device failed health check: {health}", "DEVICE_UNAVAILABLE")
            return

        execution.started_at = _now()
        execution.status = "STARTING_APPIUM"
        db.commit()
        _emit(execution_id, "status", status="STARTING_APPIUM")

        try:
            appium_handle = start_server()
        except Exception as exc:
            _fail_infra(db, execution, f"Appium server failed to start: {exc}", "APPIUM_SERVER_FAILURE")
            return

        execution.status = "STARTING_SESSION"
        db.commit()
        _emit(execution_id, "status", status="STARTING_SESSION")

        app_path = app_version.file_path if app_version else None
        app_package = application.package_name if application else None
        app_activity = app_version.launchable_activity if app_version else None

        try:
            driver = create_uiautomator2_session(
                appium_handle.base_url, device.serial,
                app_path=app_path, app_package=app_package, app_activity=app_activity,
                no_reset=False,
            )
        except Exception as exc:
            _fail_infra(db, execution, f"Appium session failed to start: {exc}", "APPIUM_SESSION_FAILURE")
            return

        execution.appium_session_id = getattr(driver, "session_id", None)
        execution.status = "RUNNING"
        db.commit()
        _emit(execution_id, "status", status="RUNNING")

        video_mode = policy.evidence.video_mode
        if video_mode != "OFF":
            recorder = ScreenRecorder(device.serial)
            if recorder.start():
                _emit(execution_id, "log", level="info", message="Screen recording started.")
            else:
                recorder = None
                _emit(execution_id, "log", level="warn", message="Screen recording could not be started (continuing without video).")

        frame_streamer = FrameStreamer(execution_id, device.serial)
        frame_streamer.start()

        ctx = ActionContext(expected_package=app_package)
        overall_status, artifacts, failures = execute_test_steps(
            db, driver, execution, test, ctx, policy, application, app_version, app_package,
        )

        if frame_streamer is not None:
            frame_streamer.stop()
            frame_streamer = None

        if recorder is not None:
            keep_video = video_mode == "FULL_TEST" or (
                video_mode == "FAILURE_ONLY" and overall_status in ("FAILED", "BLOCKED", "REQUIRES_REVIEW")
            )
            tmp_path = Path(evidence_module.VIDEO_DIR) / f"_pending_{execution_id}.mp4"
            pulled = recorder.stop_and_pull(tmp_path)
            recorder = None
            if pulled and keep_video:
                video_row = evidence_module.save_video(db, execution_id, tmp_path)
                if video_row is not None:
                    artifacts.append(video_row.id)
                    _emit(execution_id, "video_ready", url=_evidence_url(video_row))
            elif pulled and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

        execution.completed_at = _now()
        execution.duration_ms = _ms_between(execution.started_at, execution.completed_at)
        execution.status = overall_status
        execution.result_json = {
            "status": overall_status,
            "step_count": len(test.steps),
            "artifacts": artifacts,
            "failures": failures,
            "adapter_version": execution.adapter_version,
        }
        db.commit()
        _emit(execution_id, "execution_completed", status=overall_status, duration_ms=execution.duration_ms)

    except Exception as exc:
        logger.exception("Unhandled exception in mobile execution %s", execution_id)
        try:
            execution = db.get(MobileExecution, execution_id)
            if execution:
                execution.status = "INFRA_FAILURE"
                execution.completed_at = _now()
                execution.result_json = {"status": "INFRA_FAILURE", "error": str(exc), "trace": traceback.format_exc()[-3000:]}
                db.commit()
                _emit(execution_id, "execution_completed", status="INFRA_FAILURE", error=str(exc))
        except Exception:
            pass
    finally:
        try:
            if frame_streamer is not None:
                frame_streamer.stop()
        except Exception:
            pass
        try:
            if recorder is not None:
                # Safety net only — stop the remote recorder so it doesn't keep
                # running on the device; don't bother pulling/keeping the file
                # on this path (an exception already put us in an unknown state).
                recorder.stop_and_pull(Path(evidence_module.VIDEO_DIR) / f"_pending_{execution_id}.mp4")
                (Path(evidence_module.VIDEO_DIR) / f"_pending_{execution_id}.mp4").unlink(missing_ok=True)
        except Exception:
            pass
        try:
            quit_session(driver)
        except Exception:
            pass
        try:
            if appium_handle:
                stop_server(appium_handle)
        except Exception:
            pass
        try:
            if appium_handle and appium_handle.log_path:
                log_row = evidence_module.save_appium_log(db, execution_id, appium_handle.log_path)
                if log_row is not None:
                    _emit(execution_id, "evidence", artifact_type="APPIUM_LOG", step_index=None, url=_evidence_url(log_row))
        except Exception as exc:
            logger.warning("Appium log capture failed for execution %s: %s", execution_id, exc)
        try:
            if device:
                device_manager.release_device(db, device.id)
                from mobile import emulator_manager
                emulator_manager.release(device.serial)  # no-op unless we launched it
        except Exception:
            pass
        db.close()


def _fail_infra(db: Session, execution: MobileExecution, message: str, error_code: str) -> None:
    execution.status = "INFRA_FAILURE"
    execution.completed_at = _now()
    execution.result_json = {"status": "INFRA_FAILURE", "error": message, "error_code": error_code}
    db.commit()
    failure_module.classify_and_record(db, execution.id, None, message, error_code)
    _emit(execution.id, "execution_completed", status="INFRA_FAILURE", error=message, error_code=error_code)


def _run_single_action(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    try:
        return execute_action(driver, step, ctx)
    except ElementNotFoundError as exc:
        # Before treating this as "the app's UI changed" (AutoHeal's job),
        # check whether it's actually an OS-level interstitial in the way —
        # e.g. "System UI isn't responding" — which has nothing to do with
        # the app under test and would just burn through healing attempts
        # pointlessly. This check only runs on an actual failure, not on
        # every step, so it adds no overhead to the common case.
        recovered_outcome = _try_recover_from_system_dialog(driver, step, ctx)
        if recovered_outcome is not None:
            return recovered_outcome
        return ActionOutcome(status="FAILED", error=str(exc), error_code="ELEMENT_NOT_FOUND")
    except Exception as exc:
        if _is_stale_element_error(exc):
            # Genuine, well-known flakiness: the element reference we
            # resolved a moment ago is no longer attached to the current
            # view tree — almost always because the screen re-rendered
            # between resolving the element and acting on it (a RecyclerView
            # refresh, a layout pass, etc.), not because the app is actually
            # broken. The fix every mature framework uses is the same: throw
            # the stale reference away and re-resolve + retry once from
            # scratch, rather than either failing outright (false negative
            # on a perfectly fine app) or silently swallowing it. One retry
            # only — a second stale hit in a row means something else is
            # wrong and should surface as a real failure, not loop forever.
            logger.warning("Stale element reference on step action=%s — re-resolving and retrying once.", step.action)
            try:
                return execute_action(driver, step, ctx)
            except ElementNotFoundError as retry_exc:
                return ActionOutcome(status="FAILED", error=str(retry_exc), error_code="ELEMENT_NOT_FOUND")
            except Exception as retry_exc:
                return ActionOutcome(status="FAILED", error=str(retry_exc), error_code="UNKNOWN")
        return ActionOutcome(status="FAILED", error=str(exc), error_code="UNKNOWN")


def _is_stale_element_error(exc: Exception) -> bool:
    try:
        from selenium.common.exceptions import StaleElementReferenceException
        return isinstance(exc, StaleElementReferenceException)
    except ImportError:
        return False


def _try_recover_from_system_dialog(driver, step: TestStep, ctx: ActionContext) -> Optional[ActionOutcome]:
    """Returns a final ActionOutcome if a system dialog explains the failure
    (either recovered-and-retried, or a clear ANR/system-failure result), or
    None if no known system dialog was found (caller falls through to its
    normal ELEMENT_NOT_FOUND / AutoHeal path)."""
    from mobile.system_dialogs import detect_system_dialog

    try:
        xml = capture_hierarchy_xml(driver)
        nodes = parse_hierarchy(xml)
    except Exception:
        return None

    dialog = detect_system_dialog(nodes)
    if dialog is None:
        return None

    logger.warning("System dialog detected (%s, resource-id=%s) — attempting safe recovery.",
                    dialog["error_code"], dialog["matched_resource_id"])

    if dialog["recovery_resource_id"]:
        try:
            from mobile.schemas import Locator
            recovery_locator = Locator(strategy="resource_id", value=dialog["recovery_resource_id"], hint="system dialog recovery")
            from mobile.locators import resolve_element, tap_element
            el = resolve_element(driver, recovery_locator)
            tap_element(driver, el)
            import time as _time
            _time.sleep(1.5)  # let the device settle after dismissing the interstitial
        except Exception as exc:
            logger.warning("System dialog recovery tap failed: %s", exc)
            return ActionOutcome(status="FAILED", error=f"System dialog ({dialog['error_code']}) blocked the step and recovery failed: {exc}", error_code=dialog["error_code"])

        # One retry of the original action now that the dialog should be gone.
        try:
            return execute_action(driver, step, ctx)
        except ElementNotFoundError as exc:
            # Still failing after recovery — check if the SAME dialog is back
            # (a genuinely stuck app) vs. a normal locator issue post-recovery.
            try:
                still_present = detect_system_dialog(parse_hierarchy(capture_hierarchy_xml(driver)))
            except Exception:
                still_present = None
            if still_present:
                return ActionOutcome(status="FAILED", error=f"System dialog ({dialog['error_code']}) persisted after one recovery attempt.", error_code=dialog["error_code"])
            return ActionOutcome(status="FAILED", error=str(exc), error_code="ELEMENT_NOT_FOUND")
        except Exception as exc:
            return ActionOutcome(status="FAILED", error=str(exc), error_code="UNKNOWN")

    return ActionOutcome(status="FAILED", error=f"System dialog ({dialog['error_code']}) is blocking the app; no safe automatic recovery for this one.", error_code=dialog["error_code"])


def _semantic_want_role(action: str) -> str:
    if action in ("ENTER_TEXT", "REPLACE_TEXT", "APPEND_TEXT", "CLEAR_TEXT", "DELETE_TEXT"):
        return "input"
    if action in ("TAP", "DOUBLE_TAP", "LONG_PRESS"):
        return "button"
    return "any"


def _attempt_heal(db, driver, execution, idx, test, step, app_package, application, app_version, policy, ctx):
    # Fast path — live semantic re-grounding. The single most common cause of a
    # locator failure here is a *generated* locator string that never matched
    # the real app. Before the full scoring pipeline, just try to resolve the
    # step by its human hint against the screen that's actually on the device
    # right now, and if that works, swap in a "semantic" locator and re-run.
    # Generic: works for any app, needs no learned data, no OpenAI call.
    if step.locator is not None and step.locator.strategy != "semantic":
        hint = (step.locator.hint or step.locator.value or "").strip()
        if hint:
            try:
                from mobile.locators import resolve_by_hint
                resolve_by_hint(driver, hint, want_role=_semantic_want_role(step.action))
            except Exception:
                pass
            else:
                semantic = Locator(strategy="semantic", value=hint, hint=hint)
                healed_step = step.copy(update={"locator": semantic})
                try:
                    fast_outcome = execute_action(driver, healed_step, ctx)
                except Exception as exc:
                    fast_outcome = ActionOutcome(status="FAILED", error=str(exc), error_code="UNKNOWN")
                if fast_outcome.status == "PASSED":
                    record = MobileHealingRecord(
                        execution_id=execution.id, step_index=idx, test_id=test.id,
                        original_locator=step.locator.dict(),
                        candidate_locators=[{"locator": semantic.dict(), "score": 80.0, "signals": {"live_semantic_regrounding": True}}],
                        replacement_locator=semantic.dict(), confidence=80.0, risk_level=step.risk,
                        status="VALIDATED", reason="Resolved live by semantic hint against the current screen.",
                        resolved_at=_now(),
                    )
                    db.add(record)
                    db.commit()
                    db.refresh(record)
                    fast_outcome.resolved_locator = semantic.dict()
                    return fast_outcome, True, record.id

    analysis = healing_engine.analyze(
        db=db, driver=driver, execution_id=execution.id, step_index=idx, test_id=test.id,
        original_locator=step.locator, action=step.action, step_risk=step.risk,
        application_id=application.id if application else None,
        package_name=app_package,
        app_version=app_version.version_name if app_version else None,
        healing_policy=policy.healing,
    )

    if analysis.decision.decision != "AUTO_APPLY" or analysis.replacement_locator is None:
        status = "BLOCKED" if analysis.decision.decision == "PENDING_APPROVAL" else "FAILED"
        return (
            ActionOutcome(status=status, error=analysis.decision.reason, error_code="ELEMENT_NOT_FOUND"),
            False,
            analysis.healing_record.id,
        )

    healed_step = TestStep(
        action=step.action, locator=analysis.replacement_locator, value=step.value,
        timeout_ms=step.timeout_ms, risk=step.risk, expected=step.expected,
    )
    try:
        heal_outcome = execute_action(driver, healed_step, ctx)
        succeeded = heal_outcome.status == "PASSED"
    except Exception as exc:
        heal_outcome = ActionOutcome(status="FAILED", error=str(exc), error_code="UNKNOWN")
        succeeded = False

    xml = capture_hierarchy_xml(driver)
    nodes = parse_hierarchy(xml)
    screen_sig = build_screen_signature(get_current_package(driver) or "", get_current_activity(driver), nodes)

    record = healing_engine.finalize_after_execution(
        db=db, driver=driver, analysis=analysis, execution_succeeded=succeeded,
        expected_package=app_package, application_id=application.id if application else None,
        package_name=app_package, app_version=app_version.version_name if app_version else None,
        screen_signature=screen_sig,
    )

    if record.status == "VALIDATED":
        heal_outcome.status = "PASSED"
        heal_outcome.resolved_locator = analysis.replacement_locator.dict()
        return heal_outcome, True, record.id

    return (
        ActionOutcome(status="FAILED", error=f"Healing validation failed: {record.validation_result}", error_code="LOCATOR_TIMEOUT"),
        False,
        record.id,
    )
