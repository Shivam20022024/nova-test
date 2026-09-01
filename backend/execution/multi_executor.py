"""
Orchestrator for parallel cross-browser and emulated-device runs.
"""
from __future__ import annotations

import asyncio
import uuid
import datetime
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from execution.runner import run_test
from models.schemas import RunConfig, TestRequest, TestStep
from services.run_service import create_test_run
from utils.logger import get_logger

logger = get_logger("multi_executor")


async def run_single_combination(
    test_name: str,
    base_url: str,
    steps: List[Dict[str, Any]],
    browser: str,
    device: Optional[str],
    environment: str,
    run_id: str,
    project_id: int,
    suite_id: Optional[int],
    test_case_id: Optional[int],
    db: Session,
) -> Dict[str, Any]:
    """Execute a single test combination (browser + emulated device) and log to database."""
    # Convert step dicts to TestStep models
    test_steps = []
    for step in steps:
        test_steps.append(
            TestStep(
                action=step["action"],
                url=step.get("url"),
                selector=step.get("selector"),
                value=step.get("value"),
                timeout=step.get("timeout"),
                name=step.get("name"),
                retries=step.get("retries"),
                capture_screenshot=step.get("capture_screenshot", False),
            )
        )

    # Setup isolated folder naming
    safe_device = "".join(c if c.isalnum() else "_" for c in (device or "Desktop"))
    screenshot_test_name = f"{test_name}__{browser}__{safe_device}"

    # Build TestRequest
    request = TestRequest(
        test_name=test_name,
        base_url=base_url,
        steps=test_steps,
        headless=True,
        browser=browser,
        device=device,
        screenshot_suite_id=run_id,
        screenshot_test_name=screenshot_test_name,
        config=RunConfig(headless=True),
    )

    logger.info(
        "[MULTI_RUN] Starting combination: Browser=%s, Device=%s for run_id=%s",
        browser,
        device,
        run_id,
    )

    t_start = datetime.datetime.utcnow()
    try:
        result = await run_test(request)
        status = result.status.value if hasattr(result.status, "value") else str(result.status)
        duration_ms = result.total_duration_ms
        error = result.error
        error_type = result.error_type.value if result.error_type and hasattr(result.error_type, "value") else str(result.error_type or "")
        screenshot_url = result.screenshot_url
        video_url = result.video_url
        trace_url = result.trace_url
        execution_dump = result.model_dump() if hasattr(result, "model_dump") else {}
    except Exception as exc:
        logger.exception("Failed executing combination %s %s: %s", browser, device, exc)
        status = "failed"
        duration_ms = int((datetime.datetime.utcnow() - t_start).total_seconds() * 1000)
        error = str(exc)
        error_type = "RUNNER_CRASH"
        screenshot_url = None
        video_url = None
        trace_url = None
        execution_dump = {"status": "failed", "error": error}

    # Save to the database using the database session
    # Note: Using isolated scopes or transaction safety
    try:
        create_test_run(
            db=db,
            run_id=run_id,
            project_id=project_id,
            suite_id=suite_id,
            test_case_id=test_case_id,
            browser=browser,
            device=device,
            environment=environment,
            status=status,
            duration_ms=duration_ms,
            error=error,
            error_type=error_type,
            screenshot_url=screenshot_url,
            video_url=video_url,
            trace_url=trace_url,
            execution_result=execution_dump,
        )
    except Exception as db_exc:
        logger.error("[MULTI_RUN] Database logging failed: %s", db_exc)

    return {
        "browser": browser,
        "device": device or "Desktop",
        "status": status,
        "duration_ms": duration_ms,
        "screenshot_url": screenshot_url,
        "video_url": video_url,
        "trace_url": trace_url,
        "error": error,
        "execution_result": execution_dump,
    }


async def run_cross_platform_parallel(
    test_name: str,
    base_url: str,
    steps: List[Dict[str, Any]],
    browsers: List[str],
    devices: List[str],
    environment: str,
    project_id: int,
    db: Session,
    suite_id: Optional[int] = None,
    test_case_id: Optional[int] = None,
    execution_id: Optional[str] = None
) -> Dict[str, Any]:
    """Execute all browser and device combinations concurrently."""
    run_id = execution_id or f"run_{uuid.uuid4().hex[:12]}"
    
    # Standardize empty lists
    if not browsers:
        browsers = ["chromium"]
    if not devices:
        devices = ["Desktop"]

    # Gather combinations
    tasks = []
    for browser in browsers:
        for device in devices:
            tasks.append(
                run_single_combination(
                    test_name=test_name,
                    base_url=base_url,
                    steps=steps,
                    browser=browser,
                    device=device if device != "Desktop" else None,
                    environment=environment,
                    run_id=run_id,
                    project_id=project_id,
                    suite_id=suite_id,
                    test_case_id=test_case_id,
                    db=db,
                )
            )

    logger.info(
        "[MULTI_RUN] Launching parallel execution run_id=%s with %d tasks",
        run_id,
        len(tasks),
    )
    
    # Run concurrently via asyncio.gather
    results = await asyncio.gather(*tasks)
    
    # Calculate unified status
    all_passed = all(r["status"] == "passed" for r in results)
    unified_status = "passed" if all_passed else "failed"
    total_duration_ms = sum(r["duration_ms"] for r in results)

    return {
        "run_id": run_id,
        "status": unified_status,
        "duration_ms": total_duration_ms,
        "combinations": results,
    }
