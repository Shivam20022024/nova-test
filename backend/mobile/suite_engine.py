"""
Suite runner — executes every test created from one upload (a CSV/XLSX
sheet, a bulk JSON import, a saved AI-generated test) back-to-back against
one device, sharing ONE Appium server/session/device-reservation across all
of them instead of tearing all of that down and rebuilding it per test. That
sharing is what makes "upload 124 tests, they just run" tractable instead of
124x the per-test startup overhead (device health-check + Appium boot +
session create, each ~15-30s alone).

Per-test video capture is unchanged (mobile/video.py, exactly as
run_execution uses it) — what's new here is stitching every test's clip
into one whole-suite video afterward with ffmpeg, so the dashboard can offer
both "the whole run" and "just this one test" without ever running two
screen recorders on the device at once (Android doesn't reliably support
that).
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

from mobile import device_manager
from mobile import evidence as evidence_module
from mobile import failure as failure_module
from mobile.actions import ActionContext
from mobile.appium_manager import (
    AppiumServerHandle,
    create_uiautomator2_session,
    quit_session,
    start_server,
    stop_server,
)
from mobile.database import SessionLocal
from mobile.engine import _emit, _fail_infra, _ms_between, _now, execute_test_steps
from mobile.live import FrameStreamer, event_bus
from mobile.models import (
    MobileApplication,
    MobileApplicationVersion,
    MobileDevice,
    MobileExecution,
    MobileTest,
    MobileTestSuite,
)
from mobile.schemas import ExecutionPolicy
from mobile.video import ScreenRecorder
from utils.logger import get_logger

logger = get_logger("mobile.suite_engine")

FFMPEG_BIN = shutil.which("ffmpeg")


def run_suite(suite_id: int) -> None:
    """Entry point invoked from the API layer via a background thread —
    mirrors run_execution()'s BackgroundTasks pattern but for a whole suite."""
    db = SessionLocal()
    driver = None
    appium_handle: Optional[AppiumServerHandle] = None
    device: Optional[MobileDevice] = None

    try:
        suite = db.get(MobileTestSuite, suite_id)
        if suite is None:
            logger.error("run_suite: suite %s not found", suite_id)
            return

        tests = db.query(MobileTest).filter(MobileTest.suite_id == suite_id).order_by(MobileTest.id).all()
        if not tests:
            suite.status = "COMPLETED"
            suite.completed_at = _now()
            db.commit()
            return

        device = db.get(MobileDevice, suite.device_id) if suite.device_id else None
        if device is None:
            from mobile import emulator_manager
            if emulator_manager.is_enabled():
                try:
                    device = emulator_manager.acquire_device(db)
                    suite.device_id = device.id
                    db.commit()
                except Exception as exc:
                    logger.error("Suite %s: on-demand device provisioning failed: %s", suite_id, exc)
                    device = None  # falls through to the "no device" branch below

        application = db.get(MobileApplication, suite.application_id) if suite.application_id else None
        app_version = None
        if application:
            app_version = (
                db.query(MobileApplicationVersion)
                .filter(MobileApplicationVersion.application_id == application.id, MobileApplicationVersion.status == "VALID")
                .order_by(MobileApplicationVersion.uploaded_at.desc())
                .first()
            )

        policy = ExecutionPolicy()

        # Every test gets its execution row up front — so a whole-suite setup
        # failure (device/Appium) has somewhere honest to record itself
        # against every single test, not just silently produce an empty suite.
        # Inserted in ONE commit, not one-per-row: against a remote Postgres a
        # 124-row suite otherwise spends ~2 min here before anything visibly
        # starts.
        executions: List[MobileExecution] = [
            MobileExecution(
                test_id=test.id, application_version_id=app_version.id if app_version else None,
                device_id=device.id if device else None, suite_id=suite.id,
                environment="DEV", status="QUEUED",
                environment_snapshot={"execution_policy": policy.dict()},
            )
            for test in tests
        ]
        db.add_all(executions)
        db.commit()
        for execution in executions:
            db.refresh(execution)

        suite.status = "RUNNING"
        db.commit()

        if device is None:
            for execution in executions:
                _fail_infra(db, execution, "No device assigned to this suite.", "DEVICE_UNAVAILABLE")
            _finish_suite(db, suite)
            return

        try:
            device_manager.reserve_device(db, device.id, suite.name)
        except device_manager.DeviceUnavailableError as exc:
            for execution in executions:
                _fail_infra(db, execution, str(exc), "DEVICE_UNAVAILABLE")
            _finish_suite(db, suite)
            return

        health = device_manager.health_check(device.serial)
        if not health["healthy"]:
            for execution in executions:
                _fail_infra(db, execution, f"Device failed health check: {health}", "DEVICE_UNAVAILABLE")
            device_manager.release_device(db, device.id)
            _finish_suite(db, suite)
            return

        try:
            appium_handle = start_server()
        except Exception as exc:
            for execution in executions:
                _fail_infra(db, execution, f"Appium server failed to start: {exc}", "APPIUM_SERVER_FAILURE")
            device_manager.release_device(db, device.id)
            _finish_suite(db, suite)
            return

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
            for execution in executions:
                _fail_infra(db, execution, f"Appium session failed to start: {exc}", "APPIUM_SESSION_FAILURE")
            device_manager.release_device(db, device.id)
            _finish_suite(db, suite)
            return

        ctx = ActionContext(expected_package=app_package)
        per_test_video_paths: List[Path] = []
        per_test_video_storage_paths: List[str] = []

        for test, execution in zip(tests, executions):
            # Test cases the platform genuinely can't drive from the UI
            # (TLS/MITM inspection, clipboard, process-death, ...) are recorded
            # as SKIPPED with the reason, never executed, never counted as a
            # failure. The classification is on the test's source_meta, set at
            # import/generation time (mobile/automatability.py).
            meta = test.source_meta or {}
            if meta.get("automatable") is False:
                execution.started_at = _now()
                execution.completed_at = _now()
                execution.status = "SKIPPED"
                execution.result_json = {
                    "status": "SKIPPED", "step_count": 0, "artifacts": [], "failures": [],
                    "skipped_reason": meta.get("not_automatable_reason") or meta.get("reason"),
                    "needs": meta.get("needs"),
                }
                db.commit()
                _emit(execution.id, "execution_completed", status="SKIPPED",
                      reason=execution.result_json["skipped_reason"])
                continue

            # Start each test from a known clean state so one test's failure
            # (a stuck modal, a half-filled form, a wrong screen) can't cascade
            # into every test after it. Generic: terminate + relaunch via the
            # driver, optionally clearing app data.
            if policy.reset_between_tests:
                try:
                    if policy.clear_data_between_tests and app_package:
                        driver.execute_script("mobile: clearApp", {"appId": app_package})
                    if app_package:
                        driver.execute_script("mobile: terminateApp", {"appId": app_package})
                        driver.execute_script("mobile: activateApp", {"appId": app_package})
                    from mobile.locators import wait_for_stable_content
                    wait_for_stable_content(driver, timeout_ms=15000)
                except Exception as exc:
                    logger.warning("Per-test reset before test %s failed (continuing): %s", test.id, exc)

            recorder = ScreenRecorder(device.serial)
            recording_started = recorder.start()
            frame_streamer = FrameStreamer(execution.id, device.serial)
            frame_streamer.start()

            execution.appium_session_id = getattr(driver, "session_id", None)
            execution.started_at = _now()
            execution.status = "RUNNING"
            db.commit()
            _emit(execution.id, "status", status="RUNNING")

            try:
                overall_status, artifacts, failures = execute_test_steps(
                    db, driver, execution, test, ctx, policy, application, app_version, app_package,
                )
            except Exception as exc:
                logger.exception("Unhandled exception running test %s in suite %s", test.id, suite_id)
                overall_status = "INFRA_FAILURE"
                artifacts, failures = [], []
                failure_module.classify_and_record(db, execution.id, None, str(exc), "UNKNOWN")

            frame_streamer.stop()

            if recording_started:
                tmp_path = Path(evidence_module.VIDEO_DIR) / f"_pending_suite_{execution.id}.mp4"
                pulled = recorder.stop_and_pull(tmp_path)
                if pulled:
                    video_row = evidence_module.save_video(db, execution.id, tmp_path)
                    if video_row is not None:
                        artifacts.append(video_row.id)
                        per_test_video_paths.append(evidence_module.STORAGE_ROOT.parent.parent / video_row.storage_path)
                        per_test_video_storage_paths.append(video_row.storage_path)
                        execution.video_path = video_row.storage_path
                        _emit(execution.id, "video_ready", url=f"/{video_row.storage_path.replace(chr(92), '/')}")
                elif tmp_path.exists():
                    tmp_path.unlink(missing_ok=True)

            execution.completed_at = _now()
            execution.duration_ms = _ms_between(execution.started_at, execution.completed_at)
            execution.status = overall_status
            execution.result_json = {
                "status": overall_status, "step_count": len(test.steps),
                "artifacts": artifacts, "failures": failures, "adapter_version": execution.adapter_version,
            }
            db.commit()
            _emit(execution.id, "execution_completed", status=overall_status, duration_ms=execution.duration_ms)

        if appium_handle and appium_handle.log_path:
            # One Appium server for the whole suite — the log is shared
            # across every test in it, so link it to all of them rather
            # than arbitrarily picking one.
            for execution in executions:
                try:
                    evidence_module.save_appium_log(db, execution.id, appium_handle.log_path)
                except Exception:
                    pass  # save_appium_log already unlinks the source on first success; later calls correctly no-op

        if len(per_test_video_paths) > 1:
            combined = _concat_videos(per_test_video_paths, suite_id)
            if combined:
                suite.combined_video_path = combined
        elif len(per_test_video_paths) == 1:
            # Only one test actually produced video — the "whole" video IS that clip.
            suite.combined_video_path = per_test_video_storage_paths[0]
        db.commit()

    except Exception as exc:
        logger.exception("Unhandled exception in suite %s", suite_id)
    finally:
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
            if device:
                device_manager.release_device(db, device.id)
                from mobile import emulator_manager
                emulator_manager.release(device.serial)  # no-op unless we launched it
        except Exception:
            pass
        try:
            suite = db.get(MobileTestSuite, suite_id)
            if suite:
                _finish_suite(db, suite)
        except Exception:
            pass
        db.close()


def _finish_suite(db, suite: MobileTestSuite) -> None:
    suite.status = "COMPLETED"
    suite.completed_at = _now()
    db.commit()


# Execution statuses that mean "still in flight" — anything left in one of
# these when the process starts up was killed by the previous shutdown
# (run_suite/run_execution run in daemon threads that do NOT survive a
# restart), never something to silently resume.
_NON_TERMINAL_EXECUTION_STATUSES = [
    "CREATED", "QUEUED", "ALLOCATING_DEVICE", "STARTING_APPIUM", "STARTING_SESSION",
    "RUNNING", "HEALING", "RETRYING", "WAITING_APPROVAL", "CLEANUP",
]


def reap_interrupted_runs() -> None:
    """Called once on startup. Marks any suite / execution / compatibility run
    that was still in progress when the backend last stopped as interrupted —
    so nothing shows as perpetually "running", stuck device reservations are
    released, and the UI can offer a MANUAL re-run. We never auto-resume or
    auto-start a suite here (that only happens at create/import/generate time,
    for the suite created by that one request)."""
    from mobile.models import MobileCompatibilityRun, MobileDevice

    db = SessionLocal()
    try:
        now = _now()

        execs = db.query(MobileExecution).filter(
            MobileExecution.status.in_(_NON_TERMINAL_EXECUTION_STATUSES)
        ).all()
        for e in execs:
            e.status = "INFRA_FAILURE"
            e.completed_at = e.completed_at or now
            e.result_json = {
                **(e.result_json or {}),
                "interrupted": True,
                "note": "Backend restarted while this run was in progress; it was not resumed.",
            }

        suites = db.query(MobileTestSuite).filter(
            MobileTestSuite.status.in_(["QUEUED", "RUNNING"])
        ).all()
        for s in suites:
            s.status = "INTERRUPTED"
            s.completed_at = s.completed_at or now

        runs = db.query(MobileCompatibilityRun).filter(MobileCompatibilityRun.status == "RUNNING").all()
        for r in runs:
            r.status = "COMPLETED"
            r.completed_at = r.completed_at or now

        stuck_devices = db.query(MobileDevice).filter(MobileDevice.status == "RESERVED").all()
        for d in stuck_devices:
            d.status = "AVAILABLE"
            d.reserved_by_execution = None

        db.commit()
        if execs or suites or runs or stuck_devices:
            logger.info(
                "Startup reap: %d execution(s), %d suite(s), %d compat run(s) marked interrupted; %d device(s) released.",
                len(execs), len(suites), len(runs), len(stuck_devices),
            )
    except Exception:
        logger.exception("reap_interrupted_runs failed (non-fatal)")
    finally:
        db.close()


def _concat_videos(paths: List[Path], suite_id: int) -> Optional[str]:
    """ffmpeg stream-copy concat — no re-encoding, since every clip came
    from the same device's screenrecord with identical codec settings.
    There's a small (roughly 1-3s) gap between clips where the recorder
    was stopped/pulled/restarted between tests — the combined video is not
    frame-perfect continuous, and that's disclosed rather than hidden."""
    if not FFMPEG_BIN:
        logger.warning("ffmpeg not found on PATH — skipping whole-suite video concatenation (per-test videos are still saved individually).")
        return None

    existing = [p for p in paths if p.exists()]
    if not existing:
        return None

    with tempfile.TemporaryDirectory() as tmp_dir:
        list_file = Path(tmp_dir) / "concat_list.txt"
        with open(list_file, "w", encoding="utf-8") as f:
            for p in existing:
                escaped = str(p.resolve()).replace("\\", "/").replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        output_path = Path(tmp_dir) / "combined.mp4"
        try:
            result = subprocess.run(
                [FFMPEG_BIN, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(output_path)],
                capture_output=True, timeout=120,
            )
        except Exception as exc:
            logger.warning("ffmpeg concat failed to run: %s", exc)
            return None

        if result.returncode != 0 or not output_path.exists():
            logger.warning("ffmpeg concat failed (code %s): %s", result.returncode, (result.stderr or b"")[-500:])
            return None

        return evidence_module.save_suite_video(suite_id, output_path)
