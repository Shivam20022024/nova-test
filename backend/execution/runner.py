"""
Playwright-based test execution engine.

Responsibilities
----------------
* Launch browser (chromium | firefox | webkit)
* Create isolated browser context + page per run
* Execute steps sequentially with retry support
* Capture screenshots on step failure or on demand
* Emit structured StepResult objects
* Return a TestRunResult summary
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from playwright.async_api import (
    Browser,
    BrowserContext,
    Frame,
    Page,
    async_playwright,
)

from execution.actions import ActionError, capture_screenshot, dispatch
from execution.artifacts import artifact_dir, save_dom_snapshot, save_json_artifact, save_page_html, to_storage_url
from execution.console_handler import BrowserEventTracker
from execution.live import StreamController, event_bus, utc_now_iso

async def _emit_event(execution_id: str, suite_id: str, payload: Dict[str, Any]) -> None:
    payload["source_execution_id"] = execution_id
    await event_bus.emit(execution_id, payload)
    if suite_id != execution_id:
        await event_bus.emit(suite_id, payload)

from execution.decision_engine import should_fail
from execution.dom_analyzer import extract_dom_elements
from execution.retry_handler import is_transient_failure, resolve_step_retries
from models.schemas import (
    ActionType,
    ExecutionStatus,
    RunConfig,
    StepResult,
    TestRequest,
    TestRunResult,
    ErrorType,
)
from utils.logger import RunLogger, get_logger

logger = get_logger("runner")

SUCCESS_SELECTORS = (".inventory_list", ".dashboard", ".home", "[data-test='success']")
ERROR_SELECTORS = (".error-message-container", ".error", ".alert-error", "[role='alert']")
VALIDATION_SELECTORS = ("[aria-invalid='true']", ".validation-error")


def _install_wait_for_function_tracer(run_logger: RunLogger) -> None:
    """Patch Playwright Page/Frame wait_for_function to trace accidental runtime calls."""
    import traceback

    def _patch_class(cls: type) -> None:
        original = getattr(cls, "wait_for_function", None)
        if original is None or getattr(original, "__wrapped__", None) is not None:
            return

        async def patched_wait_for_function(self, *args, **kwargs):
            message = (
                "🚨 wait_for_function CALLED on Playwright "
                f"{cls.__name__} with args={args} kwargs={kwargs}"
            )
            print(message)
            traceback.print_stack()
            run_logger.error(message)
            return await original(self, *args, **kwargs)

        patched_wait_for_function.__wrapped__ = original
        setattr(cls, "wait_for_function", patched_wait_for_function)
        run_logger.warning(f"DEBUG: patched {cls.__name__}.wait_for_function for runtime tracing")

    _patch_class(Page)
    _patch_class(Frame)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _execute_step(
    page: Page,
    step_index: int,
    step,
    base_url: str,
    default_timeout: int,
    default_retries: int,
    ignore_memory: bool,
    test_type: str,
    event_tracker: BrowserEventTracker,
    run_logger: RunLogger,
    screenshot_suite_id: str,
    screenshot_test_name: str,
    evidence_level: str,
    execution_id: str,
    test_name: str,
    timeline: List[Dict],
) -> StepResult:
    """
    Execute one test step, honouring its retry count.
    Returns a StepResult regardless of outcome.
    """
    action = ActionType(step.action)
    step_timeout = step.timeout if step.timeout is not None else default_timeout
    retries_allowed = resolve_step_retries(step, default_retries)
    max_attempts = 1 + retries_allowed

    last_error: Optional[str] = None
    screenshot_path: Optional[str] = None
    screenshot_exists = False
    before_screenshot_url: Optional[str] = None
    after_screenshot_url: Optional[str] = None
    failure_screenshot_url: Optional[str] = None
    assertion_screenshot_url: Optional[str] = None
    dom_snapshot_url: Optional[str] = None
    html_snapshot_url: Optional[str] = None
    selector_used: Optional[str] = getattr(step, "selector", None)
    selector_validated = False
    selector_visible: Optional[bool] = None
    selector_enabled: Optional[bool] = None
    selector_unique: Optional[bool] = None
    recovery_attempts: List[Dict] = []
    artifacts: Dict[str, str] = {}
    retries_used = 0
    step_log_start = len(run_logger.get_logs())
    expected_intent: Optional[str] = None
    actual_detected_type: Optional[str] = None
    intent_match: Optional[bool] = None

    run_logger.info(
        f"[Step {step_index + 1}] START  action={step.action}"
    )
    t_start = time.perf_counter()
    started_at = utc_now_iso()
    url_before = page.url
    await _emit_event(
        execution_id, screenshot_suite_id,
        {
            "event": "step_started",
            "test_case": test_name,
            "step_index": step_index,
            "action": step.action,
            "selector": getattr(step, "selector", None),
            "url": url_before,
        },
    )
    if evidence_level in {"full", "balanced"}:
        before_screenshot_url = await capture_screenshot(
            page,
            prefix=f"step{step_index + 1}_before_{step.action}",
            run_logger=run_logger,
            suite_id=screenshot_suite_id,
            test_name=screenshot_test_name,
            filename=f"step_{step_index + 1}_before.png",
            full_page=False,
        )
        if before_screenshot_url:
            artifacts["before_screenshot"] = before_screenshot_url

    for attempt in range(max_attempts):
        if attempt > 0:
            retries_used += 1
            run_logger.warning(
                f"[Step {step_index + 1}] RETRY {attempt}/{retries_allowed} "
                f"action={step.action}"
            )
            await asyncio.sleep(0.25 * attempt)

        try:
            dispatch_payload = await dispatch(
                action=action,
                page=page,
                step=step,
                base_url=base_url,
                run_logger=run_logger,
                timeout=step_timeout,
                ignore_memory=ignore_memory,
            )
            result = dispatch_payload.get("result")
            healing = dispatch_payload.get("healing", {})
            selector_used = healing.get("new_selector") or healing.get("original_selector") or getattr(step, "selector", None)
            selector_validated = bool(healing.get("selector_validated", False))
            selector_visible = healing.get("selector_visible")
            selector_enabled = healing.get("selector_enabled")
            selector_unique = healing.get("selector_unique")
            recovery_attempts = list(healing.get("recovery_attempts", []))

            failure = event_tracker.get_failure()
            if failure is not None:
                raise ActionError(
                    failure["message"],
                    error_type=failure["error_type"],
                )

            if action == ActionType.SCREENSHOT and result:
                screenshot_path = result
                screenshot_exists = bool(result)

            if step.capture_screenshot and action != ActionType.SCREENSHOT:
                after_screenshot_url = await capture_screenshot(
                    page,
                    prefix=f"step{step_index + 1}_{step.action}",
                    run_logger=run_logger,
                    suite_id=screenshot_suite_id,
                    test_name=screenshot_test_name,
                    filename=f"step_{step_index + 1}_after.png",
                )
                screenshot_path = after_screenshot_url
                screenshot_exists = bool(after_screenshot_url)
                if after_screenshot_url:
                    artifacts["after_screenshot"] = after_screenshot_url

            if evidence_level == "full" and action in {ActionType.ASSERT_VISIBLE, ActionType.ASSERT_TEXT, ActionType.ASSERT_URL, ActionType.ASSERT_COUNT}:
                assertion_screenshot_url = await capture_screenshot(
                    page,
                    prefix=f"step{step_index + 1}_assert_{step.action}",
                    run_logger=run_logger,
                    suite_id=screenshot_suite_id,
                    test_name=screenshot_test_name,
                    filename=f"step_{step_index + 1}_assertion.png",
                    full_page=False,
                )
                if assertion_screenshot_url:
                    artifacts["assertion_screenshot"] = assertion_screenshot_url
                    screenshot_path = assertion_screenshot_url
                    screenshot_exists = True

            original_selector = healing.get("original_selector")
            new_selector = healing.get("new_selector")
            memory_used = bool(healing.get("memory_used", False))
            selector_substituted = bool(
                original_selector
                and new_selector
                and original_selector != new_selector
            )
            healed_reported = bool(healing.get("healed", False)) or selector_substituted or memory_used
            healing_type = "memory" if memory_used else ("llm" if healed_reported else "none")

            if action in {ActionType.ASSERT_VISIBLE, ActionType.ASSERT_TEXT}:
                expected_intent, actual_detected_type, intent_match = _evaluate_assertion_intent(
                    test_type=test_type,
                    selector=str(new_selector or step.selector or ""),
                )
                if intent_match is False:
                    if test_type == "positive" and healed_reported and actual_detected_type == "error":
                        run_logger.error("Invalid healing: success -> error mismatch")
                    raise ActionError(
                        f"Assertion intent mismatch: expected={expected_intent}, actual={actual_detected_type}",
                        error_type=ErrorType.ASSERTION_FAILURE,
                    )

            duration_ms = (time.perf_counter() - t_start) * 1000
            completed_at = utc_now_iso()
            url_after = page.url
            timeline_item = {
                "step": step_index + 1,
                "action": step.action,
                "selector": selector_used,
                "status": "passed",
                "duration_ms": round(duration_ms, 2),
                "timestamp": completed_at,
                "started_at": started_at,
                "completed_at": completed_at,
                "url_before": url_before,
                "url_after": url_after,
                "ai_reasoning": None,
                "self_healing_attempts": recovery_attempts,
                "retries": retries_used,
                "error": None,
            }
            timeline.append(timeline_item)
            await _emit_event(
                execution_id, screenshot_suite_id,
                {
                    "event": "step_completed",
                    "test_case": test_name,
                    "step_index": step_index,
                    "action": step.action,
                    "status": "passed",
                    "duration_ms": round(duration_ms, 2),
                    "url": url_after,
                },
            )
            run_logger.info(
                f"[Step {step_index + 1}] PASSED action={step.action} "
                f"({duration_ms:.0f}ms, retries={retries_used})"
            )
            return StepResult(
                step_index=step_index,
                action=step.action,
                status=ExecutionStatus.PASSED,
                duration_ms=round(duration_ms, 2),
                screenshot_path=screenshot_path,
                screenshot_url=screenshot_path,
                screenshot_exists=screenshot_exists,
                captured_at=datetime.now(timezone.utc).isoformat() if screenshot_path else None,
                before_screenshot_url=before_screenshot_url,
                after_screenshot_url=after_screenshot_url,
                failure_screenshot_url=failure_screenshot_url,
                assertion_screenshot_url=assertion_screenshot_url,
                dom_snapshot_url=dom_snapshot_url,
                html_snapshot_url=html_snapshot_url,
                selector_used=selector_used,
                selector_validated=selector_validated,
                selector_visible=selector_visible,
                selector_enabled=selector_enabled,
                selector_unique=selector_unique,
                recovery_attempts=recovery_attempts,
                artifacts=artifacts,
                error=None,
                error_type=None,
                retries_used=retries_used,
                healed=healed_reported,
                memory_used=memory_used,
                healing_type=healing_type,
                original_selector=original_selector,
                new_selector=new_selector,
                selector_score_original=healing.get("selector_score_original"),
                selector_score_new=healing.get("selector_score_new"),
                expected_intent=expected_intent,
                actual_detected_type=actual_detected_type,
                intent_match=intent_match,
                logs=run_logger.get_logs_slice(step_log_start),
                timestamp=completed_at,
                started_at=started_at,
                completed_at=completed_at,
                url_before=url_before,
                url_after=url_after,
                ai_reasoning=None,
            )

        except ActionError as exc:
            last_error = str(exc)
            run_logger.error(
                f"[Step {step_index + 1}] ERROR  action={step.action} | {exc}"
            )
            if attempt == max_attempts - 1 or not is_transient_failure(exc):
                break

    duration_ms = (time.perf_counter() - t_start) * 1000
    completed_at = utc_now_iso()
    url_after = page.url
    failure_shot = await capture_screenshot(
        page,
        prefix=f"FAIL_step{step_index + 1}_{step.action}",
        run_logger=run_logger,
        suite_id=screenshot_suite_id,
        test_name=screenshot_test_name,
        filename=f"step_{step_index + 1}_failure.png",
    )
    if failure_shot:
        screenshot_path = failure_shot
        screenshot_exists = True
        failure_screenshot_url = failure_shot
        artifacts["failure_screenshot"] = failure_shot
    dom_snapshot_url = await save_dom_snapshot(page, screenshot_suite_id, screenshot_test_name, f"step_{step_index + 1}_dom.json")
    html_snapshot_url = await save_page_html(page, screenshot_suite_id, screenshot_test_name, f"step_{step_index + 1}.html")
    if dom_snapshot_url:
        artifacts["dom_snapshot"] = dom_snapshot_url
    if html_snapshot_url:
        artifacts["html_snapshot"] = html_snapshot_url
    if last_error:
        attempts_artifact = save_json_artifact(
            {
                "step_index": step_index,
                "action": step.action,
                "selector_used": selector_used,
                "recovery_attempts": recovery_attempts,
                "error": last_error,
            },
            screenshot_suite_id,
            screenshot_test_name,
            f"step_{step_index + 1}_recovery.json",
        )
        if attempts_artifact:
            artifacts["recovery_attempts"] = attempts_artifact

    run_logger.error(
        f"[Step {step_index + 1}] FAILED action={step.action} "
        f"({duration_ms:.0f}ms, retries={retries_used})"
    )
    timeline_item = {
        "step": step_index + 1,
        "action": step.action,
        "selector": selector_used,
        "status": "failed",
        "duration_ms": round(duration_ms, 2),
        "timestamp": completed_at,
        "started_at": started_at,
        "completed_at": completed_at,
        "url_before": url_before,
        "url_after": url_after,
        "ai_reasoning": None,
        "self_healing_attempts": recovery_attempts,
        "retries": retries_used,
        "error": last_error,
    }
    timeline.append(timeline_item)
    await _emit_event(
        execution_id, screenshot_suite_id,
        {
            "event": "step_completed",
            "test_case": test_name,
            "step_index": step_index,
            "action": step.action,
            "status": "failed",
            "duration_ms": round(duration_ms, 2),
            "url": url_after,
            "error": last_error,
        },
    )
    return StepResult(
        step_index=step_index,
        action=step.action,
        status=ExecutionStatus.FAILED,
        duration_ms=round(duration_ms, 2),
        screenshot_path=screenshot_path,
        screenshot_url=screenshot_path,
        screenshot_exists=screenshot_exists,
        captured_at=datetime.now(timezone.utc).isoformat() if screenshot_path else None,
        before_screenshot_url=before_screenshot_url,
        after_screenshot_url=after_screenshot_url,
        failure_screenshot_url=failure_screenshot_url,
        assertion_screenshot_url=assertion_screenshot_url,
        dom_snapshot_url=dom_snapshot_url,
        html_snapshot_url=html_snapshot_url,
        selector_used=selector_used,
        selector_validated=selector_validated,
        selector_visible=selector_visible,
        selector_enabled=selector_enabled,
        selector_unique=selector_unique,
        recovery_attempts=recovery_attempts,
        artifacts=artifacts,
        error=last_error,
        error_type=getattr(exc, "error_type", ErrorType.UNKNOWN_ERROR) if "exc" in locals() else ErrorType.UNKNOWN_ERROR,
        retries_used=retries_used,
        healed=False,
        memory_used=False,
        healing_type="none",
        original_selector=None,
        new_selector=None,
        selector_score_original=None,
        selector_score_new=None,
        expected_intent=expected_intent,
        actual_detected_type=actual_detected_type,
        intent_match=intent_match,
        logs=run_logger.get_logs_slice(step_log_start),
        timestamp=completed_at,
        started_at=started_at,
        completed_at=completed_at,
        url_before=url_before,
        url_after=url_after,
        ai_reasoning=None,
    )


def _infer_test_type(test_name: str) -> str:
    lowered = (test_name or "").lower()
    if "positive" in lowered:
        return "positive"
    if "negative" in lowered:
        return "negative"
    if "edge" in lowered:
        return "edge"
    return "generic"


def _classify_selector_type(selector: str) -> str:
    lowered = (selector or "").lower()
    if any(token in lowered for token in VALIDATION_SELECTORS):
        return "validation"
    if any(token in lowered for token in ERROR_SELECTORS):
        return "error"
    if any(token in lowered for token in SUCCESS_SELECTORS):
        return "success"
    return "unknown"


def _evaluate_assertion_intent(test_type: str, selector: str) -> tuple[Optional[str], Optional[str], Optional[bool]]:
    detected = _classify_selector_type(selector)
    if test_type == "positive":
        return "success", detected, detected == "success"
    if test_type == "negative":
        return "error", detected, detected == "error"
    if test_type == "edge":
        return "validation", detected, detected in {"error", "validation"}
    return None, detected, True


# ---------------------------------------------------------------------------
# Public runner
# ---------------------------------------------------------------------------

async def run_test(request: TestRequest) -> TestRunResult:
    """
    Entry point for the execution engine.

    Launches a browser, executes all steps in order, and returns a
    TestRunResult with full details about each step.
    """
    config: RunConfig = request.config
    headless = config.headless if config is not None else request.headless
    default_timeout = config.timeout if config is not None else request.default_timeout
    default_retries = config.retries
    fail_on_console_error = config.fail_on_console_error
    ignore_memory = request.ignore_memory or config.ignore_memory
    slow_mo = max(0, int(getattr(config, "slow_mo", 0) or 0))
    enable_trace = str(os.getenv("AI_ENABLE_TRACE", "0")).strip().lower() in {"1", "true", "yes"}
    enable_video = str(os.getenv("AI_ENABLE_VIDEO", "1")).strip().lower() in {"1", "true", "yes"}
    evidence_level = str(os.getenv("AI_EVIDENCE_LEVEL", "balanced")).strip().lower()
    if evidence_level not in {"minimal", "balanced", "full"}:
        evidence_level = "balanced"
    test_type = _infer_test_type(request.test_name)

    # Force Windows event loop policy for Playwright subprocess compatibility
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    run_logger = RunLogger(test_name=request.test_name)
    screenshot_suite_id = request.screenshot_suite_id or datetime.now(timezone.utc).strftime("suite_%Y%m%d_%H%M%S")
    screenshot_test_name = request.screenshot_test_name or request.test_name
    execution_id = f"{screenshot_suite_id}__{screenshot_test_name}__{int(time.time() * 1000)}"
    run_logger.info(
        f"=== TEST RUN START  name='{request.test_name}'  "
        f"browser={request.browser}  headless={headless}  "
        f"base_url={request.base_url}  evidence={evidence_level}  trace={enable_trace}  video={enable_video} ==="
    )

    steps_executed: List[StepResult] = []
    failure_screenshot: Optional[str] = None
    failure_screenshot_exists = False
    failed_step: Optional[int] = None
    global_error: Optional[str] = None
    error_type: Optional[ErrorType] = None
    overall_status = ExecutionStatus.PASSED
    t_run_start = time.perf_counter()

    logs: List[str] = []
    warnings: List[Dict] = []
    console_errors: List[Dict] = []
    network_errors: List[Dict] = []

    if not request.steps:
        raise ValueError("No steps provided in the test request")
    if not request.base_url:
        raise ValueError("Missing base_url in the test request")

    logger.info("Init Playwright")
    logger.info("Launch browser")
    logger.info("Create context")
    logger.info("Create page")
    logger.info("Start steps")

    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    event_tracker: Optional[BrowserEventTracker] = None
    pw = None
    trace_url: Optional[str] = None
    video_url: Optional[str] = None
    test_case_video_url: Optional[str] = None
    test_case_video_path: Optional[str] = None
    timeline: List[Dict] = []
    streamer: Optional[StreamController] = None
    run_artifact_dir = artifact_dir(screenshot_suite_id, screenshot_test_name)
    artifact_dir_url: Optional[str] = to_storage_url(run_artifact_dir)

    try:
        pw = await async_playwright().start()
        browser_key = request.browser.lower() if request.browser else "chromium"
        launcher_type = pw.chromium
        channel_name = None

        if browser_key == "chrome":
            launcher_type = pw.chromium
            channel_name = "chrome"
        elif browser_key == "edge":
            launcher_type = pw.chromium
            channel_name = "msedge"
        elif browser_key == "firefox":
            launcher_type = pw.firefox
        elif browser_key in {"webkit", "safari"}:
            launcher_type = pw.webkit
        else:
            launcher_type = pw.chromium

        run_logger.info(f"Launching {browser_key} (channel={channel_name})  headless={headless}")
        try:
            launch_args = ["--disable-dev-shm-usage"] if browser_key in {"chromium", "chrome", "edge"} else []
            browser_kwargs = {
                "headless": headless,
                "slow_mo": slow_mo,
                "args": launch_args,
            }
            if channel_name:
                browser_kwargs["channel"] = channel_name
                
            browser = await launcher_type.launch(**browser_kwargs)
        except Exception as launch_exc:
            logger.error("Browser launch failed", exc_info=True)
            raise

        if browser is None:
            raise RuntimeError("Browser launch returned None")

        # Emulated Device configuration lookup
        device_config = {}
        if getattr(request, "device", None):
            dev_name = request.device
            if dev_name in pw.devices:
                device_config = pw.devices[dev_name]
                run_logger.info(f"Applying device emulation for: {dev_name}")
            else:
                device_mappings = {
                    "iphone 13": "iPhone 13",
                    "iphone 14": "iPhone 14",
                    "pixel 7": "Pixel 7",
                    "galaxy s22": "Galaxy S9+",
                    "ipad pro": "iPad Pro 11",
                    "desktop chrome": "Desktop Chrome",
                }
                mapped_name = device_mappings.get(dev_name.lower())
                if mapped_name and mapped_name in pw.devices:
                    device_config = pw.devices[mapped_name]
                    run_logger.info(f"Applying emulated device mapping: {mapped_name}")

        # Set up Browser context options
        context_kwargs = {
            "base_url": request.base_url,
            "ignore_https_errors": True,
        }
        
        if device_config:
            context_kwargs.update(device_config)
            if enable_video:
                context_kwargs["record_video_dir"] = str(run_artifact_dir)
        else:
            context_kwargs.update({
                "viewport": {"width": 1440, "height": 900},
                "record_video_dir": str(run_artifact_dir) if enable_video else None,
                "record_video_size": {"width": 1440, "height": 900} if enable_video else None,
            })

        if getattr(request, "storage_state", None):
            context_kwargs["storage_state"] = request.storage_state

        context = await browser.new_context(**context_kwargs)
        if context is None:
            raise RuntimeError("Browser context initialization failed")

        if enable_trace:
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)

        context.set_default_timeout(default_timeout)
        page: Page = await context.new_page()
        await _emit_event(
            execution_id, screenshot_suite_id,
            {
                "event": "suite_started",
                "suite_id": screenshot_suite_id,
                "test_case": request.test_name,
                "base_url": request.base_url,
                "browser": request.browser,
            },
        )
        await _emit_event(
            execution_id, screenshot_suite_id,
            {"event": "test_started", "suite_id": screenshot_suite_id, "test_case": request.test_name},
        )
        streamer = StreamController(
            execution_id=execution_id,
            page=page,
            interval_seconds=0.5,
            channel_ids=[execution_id, screenshot_suite_id],
        )
        await streamer.start()
        if page is None:
            raise RuntimeError("Page init failed")

        _install_wait_for_function_tracer(run_logger)

        event_tracker = BrowserEventTracker(
            run_logger=run_logger,
            fail_on_console_error=fail_on_console_error,
        )
        page.on("console", event_tracker.handle_console)
        page.on("pageerror", event_tracker.handle_page_error)
        page.on("requestfailed", event_tracker.handle_request_failed)
        initial_dom = await extract_dom_elements(page)
        save_json_artifact(
            {
                "test_name": request.test_name,
                "base_url": request.base_url,
                "dom_elements": initial_dom,
            },
            screenshot_suite_id,
            screenshot_test_name,
            "initial_dom.json",
        )

        for idx, step in enumerate(request.steps):
            step_result = await _execute_step(
                page=page,
                step_index=idx,
                step=step,
                base_url=request.base_url,
                default_timeout=default_timeout,
                default_retries=default_retries,
                ignore_memory=ignore_memory,
                test_type=test_type,
                event_tracker=event_tracker,
                run_logger=run_logger,
                screenshot_suite_id=screenshot_suite_id,
                screenshot_test_name=screenshot_test_name,
                evidence_level=evidence_level,
                execution_id=execution_id,
                test_name=request.test_name,
                timeline=timeline,
            )
            steps_executed.append(step_result)

            if step_result.status == ExecutionStatus.FAILED:
                overall_status = ExecutionStatus.FAILED
                failure_screenshot = step_result.screenshot_path
                failure_screenshot_exists = step_result.screenshot_exists
                failed_step = failed_step if failed_step is not None else step_result.step_index
                global_error = global_error or step_result.error
                step_error_type = step_result.error_type
                fatal_failure = step_error_type in {ErrorType.NAVIGATION_ERROR, ErrorType.RUNNER_CRASH}
                if fatal_failure:
                    remaining = len(request.steps) - idx - 1
                    if remaining > 0:
                        run_logger.warning(
                            f"Aborting run after fatal failure on step {idx + 1}; "
                            f"{remaining} step(s) skipped."
                        )
                        for skipped_idx in range(idx + 1, len(request.steps)):
                            steps_executed.append(
                                StepResult(
                                    step_index=skipped_idx,
                                    action=request.steps[skipped_idx].action,
                                    status=ExecutionStatus.SKIPPED,
                                    duration_ms=0.0,
                                    logs=[],
                                )
                            )
                    break
                run_logger.warning(
                    f"Continuing after non-fatal step failure on step {idx + 1} ({step.action})."
                )

        if overall_status == ExecutionStatus.PASSED:
            ts = int(time.time() * 1000)
            browser_key = (request.browser or "chromium").lower()
            pass_shot = await capture_screenshot(
                page,
                prefix=f"PASS_{request.test_name}",
                run_logger=run_logger,
                suite_id=screenshot_suite_id,
                test_name=screenshot_test_name,
                filename=f"{screenshot_test_name}_{browser_key}_{ts}.png",
            )
            if pass_shot:
                failure_screenshot = pass_shot
                failure_screenshot_exists = True

        # Check for browser errors after all steps
        critical_errors = [
            e for e in event_tracker.get_console_errors() + event_tracker.get_network_errors()
            if e.get("severity") == "critical"
        ] if event_tracker else []
        non_critical_errors = [
            e for e in event_tracker.get_console_errors() + event_tracker.get_network_errors()
            if e.get("severity") == "non_critical"
        ] if event_tracker else []

        if should_fail(critical_errors, non_critical_errors, config):
            overall_status = ExecutionStatus.FAILED
            if critical_errors:
                global_error = critical_errors[0]["message"]
                error_type = ErrorType(critical_errors[0]["type"])
            elif non_critical_errors and config.strict_mode:
                global_error = non_critical_errors[0]["message"]
                error_type = ErrorType(non_critical_errors[0]["type"])
            else:
                global_error = "Test failed due to errors"
                error_type = ErrorType.UNKNOWN_ERROR

    except Exception as exc:  # noqa: BLE001
        if not global_error:
            global_error = str(exc) or repr(exc) or "Unknown runner failure"
        error_type = ErrorType.RUNNER_CRASH
        overall_status = ExecutionStatus.FAILED
        run_logger.error(f"Runner crashed: {global_error}")
        logger.error(f"Runner crashed: {global_error}")
        logger.error(traceback.format_exc())
        await _emit_event(
            execution_id, screenshot_suite_id,
            {"event": "failure", "suite_id": screenshot_suite_id, "test_case": request.test_name, "error": global_error},
        )
    finally:
        if streamer:
            await streamer.stop()
        try:
            if context and enable_trace:
                trace_path = run_artifact_dir / "trace.zip"
                await context.tracing.stop(path=str(trace_path))
                trace_url = to_storage_url(trace_path) or str(trace_path)
        except Exception:  # noqa: BLE001
            logger.warning("Failed to save trace", exc_info=True)
        try:
            if context:
                videos = []
                if enable_video:
                    for page_obj in context.pages:
                        if page_obj.video:
                            videos.append(page_obj.video)
                await context.close()
                for video in videos:
                    try:
                        video_path = await video.path()
                        if video_path:
                            video_url = to_storage_url(Path(video_path)) or video_path
                            test_case_video_path = video_path
                            test_case_video_url = video_url
                    except Exception:
                        continue
        except Exception:  # noqa: BLE001
            logger.warning("Failed to close context or save video", exc_info=True)
        try:
            if browser:
                await browser.close()
        except Exception:  # noqa: BLE001
            logger.warning("Failed to close browser", exc_info=True)
        try:
            if pw:
                await pw.stop()
        except Exception:  # noqa: BLE001
            logger.warning("Failed to stop Playwright", exc_info=True)
        await _emit_event(
            execution_id, screenshot_suite_id,
            {
                "event": "video_ready",
                "suite_id": screenshot_suite_id,
                "test_case": request.test_name,
                "video_url": test_case_video_url,
                "video_path": test_case_video_path,
            },
        )
        await _emit_event(
            execution_id, screenshot_suite_id,
            {
                "event": "test_completed",
                "suite_id": screenshot_suite_id,
                "test_case": request.test_name,
                "status": overall_status.value if hasattr(overall_status, "value") else overall_status,
            },
        )

    total_duration_ms = round((time.perf_counter() - t_run_start) * 1000, 2)
    healed_steps = sum(1 for step in steps_executed if getattr(step, "healed", False))
    healed_summary = healed_steps > 0

    run_logger.info(
        f"=== TEST RUN END  status={overall_status}  "
        f"total={total_duration_ms:.0f}ms ==="
    )
    run_logger.info(
        f"=== TEST RUN HEALING SUMMARY healed={healed_summary} healed_steps={healed_steps} ==="
    )

    try:
        run_logger.flush_to_file()
    except Exception:  # noqa: BLE001
        pass

    if overall_status == ExecutionStatus.PASSED:
        global_error = None
        error_type = None
    elif error_type is None:
        error_type = ErrorType.UNKNOWN_ERROR
    await _emit_event(
        execution_id, screenshot_suite_id,
        {
            "event": "suite_completed",
            "suite_id": screenshot_suite_id,
            "test_case": request.test_name,
            "status": str(overall_status.value if hasattr(overall_status, "value") else overall_status),
            "duration_ms": round(total_duration_ms, 2),
            "timeline_steps": len(timeline),
            "video_url": test_case_video_url,
        },
    )

    bug_report = None
    if overall_status == ExecutionStatus.FAILED:
        try:
            from llm.bug_classifier import BugClassifier
            classifier = BugClassifier()
            failed_action_name = "Unknown"
            if failed_step is not None and failed_step < len(request.steps):
                failed_action_name = request.steps[failed_step].action
            
            c_errs = [e.get("message", "") for e in (event_tracker.get_console_errors() if event_tracker else [])]
            n_errs = [e.get("url", "") for e in (event_tracker.get_network_errors() if event_tracker else [])]
            
            bug_report = classifier.classify_failure(
                step_index=failed_step or 0,
                action=failed_action_name,
                error_msg=global_error or "",
                console_logs=c_errs,
                network_failures=n_errs
            )
        except Exception as e:
            logger.error(f"Failed to run bug classifier: {e}")

    return TestRunResult(
        test_name=request.test_name,
        status=overall_status,
        steps_executed=steps_executed,
        failed_step=failed_step,
        error=global_error,
        error_type=error_type,
        bug_report=bug_report,
        screenshot_path=failure_screenshot,
        screenshot_url=failure_screenshot,
        screenshot_exists=failure_screenshot_exists,
        executed_at=datetime.now(timezone.utc).isoformat(),
        trace_url=trace_url,
        video_url=video_url,
        artifact_dir_url=artifact_dir_url,
        logs=run_logger.get_logs(),
        total_duration_ms=total_duration_ms,
        browser=request.browser,
        base_url=request.base_url,
        warnings=event_tracker.get_warnings() if event_tracker else [],
        console_errors=event_tracker.get_console_errors() if event_tracker else [],
        network_errors=event_tracker.get_network_errors() if event_tracker else [],
        execution_id=execution_id,
        suite_id=screenshot_suite_id,
        timeline=timeline,
        test_case_video_url=test_case_video_url,
        test_case_video_path=test_case_video_path,
    )
