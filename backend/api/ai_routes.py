"""
AI-powered test generation routes.

Provides endpoints for generating tests from natural language prompts.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
import json
from datetime import datetime
from pathlib import Path
from html import escape
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException

from execution.dom_analyzer import analyze_live_dom
from execution.runner import run_test
from llm.generator import generator
from models.schemas import (
    GenerateAndRunRequest,
    GenerateAndRunResponse,
    GeneratedTestRequest,
    GeneratedTestResponse,
    JobDoneResponse,
    JobFailedResponse,
    JobPendingResponse,
    JobRunningResponse,
    JobStatusResponse,
    TestRequest,
)
from utils.logger import get_logger

logger = get_logger("ai_routes")

router = APIRouter(prefix="/ai", tags=["AI Test Generation"])

LLM_TIMEOUT_SECONDS = 8.0
JOB_MAX_ATTEMPTS = 3
JOB_BACKOFF_BASE_SECONDS = 0.5
POLL_TIMEOUT_SECONDS = 3.0
POLL_INTERVAL_SECONDS = 0.5

# In-memory cache keyed by normalized prompt only.
generation_cache: Dict[str, Dict[str, Any]] = {}
# In-memory jobs store for async generation.
jobs: Dict[str, Dict[str, Any]] = {}
REPORTS_DIR = Path(__file__).resolve().parent.parent / "storage" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage"
EXECUTIONS_DIR = STORAGE_DIR / "executions"
EXECUTIONS_DIR.mkdir(parents=True, exist_ok=True)


def _as_dict(value: Any) -> Dict[str, Any]:
    """Normalize Pydantic models / mappings to plain dict for report rendering."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump()  # type: ignore[call-arg]
        except Exception:
            return {}
    return {}


def _safe_name(value: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (value or "").strip())
    return safe or "unknown"


def _screenshot_exists(raw_path: Any) -> bool:
    if not raw_path:
        return False
    path_str = str(raw_path).replace("\\", "/")
    if path_str.startswith("/storage/"):
        candidate = STORAGE_DIR / path_str.removeprefix("/storage/")
        return candidate.exists() and candidate.stat().st_size > 0
    candidate = Path(str(raw_path))
    return candidate.exists() and candidate.stat().st_size > 0


def _enrich_execution_result(result: Dict[str, Any]) -> Dict[str, Any]:
    execution = dict(result or {})
    screenshot_url = execution.get("screenshot_url") or execution.get("screenshot_path")
    execution["screenshot_url"] = screenshot_url
    execution["screenshot_exists"] = _screenshot_exists(screenshot_url)

    steps = execution.get("steps_executed") or []
    enriched_steps = []
    for step in steps:
        step_map = _as_dict(step)
        step_url = step_map.get("screenshot_url") or step_map.get("screenshot_path")
        step_map["screenshot_url"] = step_url
        step_map["screenshot_exists"] = _screenshot_exists(step_url)
        enriched_steps.append(step_map)
    execution["steps_executed"] = enriched_steps
    return execution


def _generate_execution_report_html(executions: List[Dict[str, Any]]) -> str:
    total_tests = len(executions)
    passed_tests = 0
    failed_tests = 0
    total_steps = 0
    sections: List[str] = []

    for run in executions:
        test_name = str(run.get("test_name") or "test")
        test_type = str(run.get("test_type") or "unknown")
        result = _enrich_execution_result(_as_dict(run.get("execution_result")))
        status = str(result.get("status") or "unknown")
        if status == "passed":
            passed_tests += 1
        else:
            failed_tests += 1

        steps = result.get("steps_executed") or []
        total_steps += len(steps)
        rows: List[str] = []
        for step in steps:
            step_map = _as_dict(step)
            screenshot = step_map.get("screenshot_url") or step_map.get("screenshot_path")
            screenshot_html = f"<a href='{escape(str(screenshot))}' target='_blank'>Open</a>" if screenshot else "Not captured"
            rows.append(
                "<tr>"
                f"<td>{escape(str(step_map.get('step_index')))}</td>"
                f"<td>{escape(str(step_map.get('action')))}</td>"
                f"<td>{escape(str(step_map.get('status')))}</td>"
                f"<td>{escape(str(step_map.get('expected_intent')))}</td>"
                f"<td>{escape(str(step_map.get('actual_detected_type')))}</td>"
                f"<td>{escape(str(step_map.get('intent_match')))}</td>"
                f"<td>{screenshot_html}</td>"
                "</tr>"
            )
        sections.append(
            "<section style='margin-top:18px'>"
            f"<h3 style='margin:0'>{escape(test_name)} <small>({escape(test_type)})</small></h3>"
            f"<p><strong>Status:</strong> {escape(status)}</p>"
            "<table style='width:100%;border-collapse:collapse'>"
            "<thead><tr><th>Step</th><th>Action</th><th>Status</th><th>Expected</th><th>Detected</th><th>Match</th><th>Screenshot</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody>"
            "</table>"
            "</section>"
        )

    generated_at = datetime.now().strftime("%d %b %Y, %I:%M:%S %p")
    return (
        "<html><head><meta charset='utf-8'><title>Execution Report</title>"
        "<style>"
        "body{font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#f7f7fb;color:#202124}"
        "table,th,td{border:1px solid #d8dee8}th,td{padding:8px;text-align:left}"
        "th{background:#eef3f8}.summary{display:flex;gap:12px;margin:12px 0}"
        ".card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:10px;min-width:130px}"
        "</style></head><body>"
        "<h1>AI Test Execution Report</h1>"
        f"<p><strong>Generated on:</strong> {generated_at}</p>"
        "<div class='summary'>"
        f"<div class='card'><div>Total Tests</div><strong>{total_tests}</strong></div>"
        f"<div class='card'><div>Passed</div><strong>{passed_tests}</strong></div>"
        f"<div class='card'><div>Failed</div><strong>{failed_tests}</strong></div>"
        f"<div class='card'><div>Total Steps</div><strong>{total_steps}</strong></div>"
        "</div>"
        "<p>This report summarizes the frontend-triggered execution run with per-step evidence.</p>"
        f"{''.join(sections)}"
        "</body></html>"
    )


def _count_execution_screenshots(executions: List[Dict[str, Any]]) -> Dict[str, int]:
    tests_with_screenshots = 0
    total_screenshots = 0
    for item in executions:
        result = _as_dict(item.get("execution_result"))
        if result.get("screenshot_exists"):
            tests_with_screenshots += 1
            total_screenshots += 1
        for step in result.get("steps_executed") or []:
            step_map = _as_dict(step)
            if step_map.get("screenshot_exists"):
                total_screenshots += 1
    return {
        "tests_with_screenshots": tests_with_screenshots,
        "total_screenshots": total_screenshots,
    }


def _phase_for_test_type(test_type: Any) -> Dict[str, Any]:
    mapping = {
        "positive": {"priority": 1, "phase": "positive_flows"},
        "e2e": {"priority": 2, "phase": "e2e_flows"},
        "negative": {"priority": 3, "phase": "negative_flows"},
        "edge": {"priority": 4, "phase": "edge_flows"},
    }
    return mapping.get(str(test_type or "").lower(), {"priority": 5, "phase": "other_flows"})


def _is_passed_status(status: Any) -> bool:
    normalized = str(status or "").lower()
    return normalized.endswith("passed")


def _request_cache_key(prompt: str) -> str:
    normalized_prompt = (prompt or "").strip().lower()
    prompt_bytes = normalized_prompt.encode("utf-8")
    return hashlib.sha256(prompt_bytes).hexdigest()


async def _ensure_dom_elements(base_url: Optional[str], dom_elements: Optional[Any], browser: str = "chromium") -> Optional[List[Dict[str, Any]]]:
    if dom_elements:
        return dom_elements
    if not base_url:
        return dom_elements
    try:
        discovered = await analyze_live_dom(base_url, browser=browser, headless=True)
        if discovered:
            logger.info("[DOM_ANALYSIS] captured elements=%s url=%s", len(discovered), base_url)
            return discovered
    except Exception as exc:  # noqa: BLE001
        logger.warning("[DOM_ANALYSIS] failed url=%s error=%s", base_url, exc)
    return dom_elements


def _fallback_test(prompt: str, base_url: Optional[str] = None) -> Dict[str, Any]:
    test_name = "fallback_test"
    if prompt:
        normalized = ".".join(
            [word for word in prompt.lower().replace("/", " ").split() if word.isalnum()]
        )
        if normalized:
            test_name = f"fallback_{normalized[:50]}"

    if not base_url:
        base_url = "https://example.com"

    return {
        "test_name": test_name,
        "base_url": base_url,
        "steps": [
            {"action": "goto", "url": "/"},
            {"action": "assert_visible", "selector": "body"},
        ],
    }


def _set_job_status(job_id: str, new_status: str) -> None:
    """Set and log job status transition."""
    job = jobs.get(job_id)
    if not job:
        return
    old_status = job.get("status")
    job["status"] = new_status
    logger.info(
        "[AI_JOB] job_id=%s status_transition=%s->%s attempts=%s",
        job_id,
        old_status,
        new_status,
        job.get("attempts", 0),
    )


def validate_test(test: Dict[str, Any]) -> Tuple[bool, str]:
    """Strict validation for AI-generated tests before execution."""
    if not isinstance(test, dict):
        detail = "test payload must be an object"
        logger.warning("[VALIDATION] pass=false detail=%s", detail)
        return False, detail

    test_name = test.get("test_name")
    if not isinstance(test_name, str) or not test_name.strip():
        detail = "test_name is required"
        logger.warning("[VALIDATION] pass=false detail=%s", detail)
        return False, detail

    base_url = test.get("base_url")
    if not isinstance(base_url, str) or not base_url.strip():
        detail = "base_url is required"
        logger.warning("[VALIDATION] pass=false detail=%s", detail)
        return False, detail

    steps = test.get("steps")
    if not isinstance(steps, list) or len(steps) == 0:
        detail = "steps must exist and have at least one item"
        logger.warning("[VALIDATION] pass=false detail=%s", detail)
        return False, detail

    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            detail = f"step {idx} must be an object"
            logger.warning("[VALIDATION] pass=false detail=%s", detail)
            return False, detail

        action = step.get("action")
        if not isinstance(action, str) or not action.strip():
            detail = f"step {idx} missing action"
            logger.warning("[VALIDATION] pass=false detail=%s", detail)
            return False, detail

        if action in {"fill", "click"} or action.startswith("assert"):
            selector = step.get("selector")
            if not isinstance(selector, str) or not selector.strip():
                detail = f"step {idx} requires selector for action={action}"
                logger.warning("[VALIDATION] pass=false detail=%s", detail)
                return False, detail

        confidence = step.get("confidence")
        try:
            confidence_value = float(confidence)
        except (TypeError, ValueError):
            detail = f"step {idx} missing/invalid confidence"
            logger.warning("[VALIDATION] pass=false detail=%s", detail)
            return False, detail

        if confidence_value < 0.7:
            detail = f"step {idx} confidence below threshold: {confidence_value}"
            logger.warning("[VALIDATION] pass=false detail=%s", detail)
            return False, detail

    logger.info("[VALIDATION] pass=true steps=%s", len(steps))
    return True, "ok"


async def _generate_llm_once(
    prompt: str,
    base_url: Optional[str],
    dom_elements: Optional[Any],
) -> Dict[str, Any]:
    """Single LLM attempt with timeout guardrail."""
    async with asyncio.timeout(LLM_TIMEOUT_SECONDS):
        result = await asyncio.to_thread(
            generator.generate_test,
            prompt,
            base_url,
            dom_elements,
            1,  # one attempt per outer retry loop
        )
    return result


async def run_llm(job_id: str, prompt: str, base_url: Optional[str], dom_elements: Optional[Any]) -> None:
    """Async LLM worker with retries, timeout, and validation."""
    if job_id not in jobs:
        logger.warning("[AI_JOB] job_id=%s missing from store", job_id)
        return

    _set_job_status(job_id, "running")
    last_error = "unknown"

    for attempt in range(1, JOB_MAX_ATTEMPTS + 1):
        jobs[job_id]["attempts"] = attempt
        try:
            result = await _generate_llm_once(prompt, base_url, dom_elements)
            is_valid, validation_detail = validate_test(result)
            if not is_valid:
                raise ValueError(f"validation_failed: {validation_detail}")

            jobs[job_id]["result"] = {
                **result,
                "is_fallback": False,
                "reason": None,
                "job_id": job_id,
            }
            jobs[job_id]["error"] = None
            _set_job_status(job_id, "done")
            logger.info("[AI_JOB] job_id=%s status=done attempts=%s", job_id, attempt)
            return
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            logger.warning(
                "[AI_JOB] job_id=%s status=running attempt=%s/%s failure_reason=%s",
                job_id,
                attempt,
                JOB_MAX_ATTEMPTS,
                last_error,
            )
            if attempt < JOB_MAX_ATTEMPTS:
                backoff = JOB_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                await asyncio.sleep(backoff)

    # Final failure path: complete with fallback (no hard failure state).
    fallback_response = jobs[job_id].get("fallback_test") or {
        **_fallback_test(prompt, base_url),
        "is_fallback": True,
        "reason": "Instant fallback",
        "job_id": job_id,
    }
    fallback_response = {
        **fallback_response,
        "is_fallback": True,
        "reason": f"LLM failed after retries: {last_error}",
        "job_id": job_id,
    }
    jobs[job_id]["result"] = fallback_response
    jobs[job_id]["error"] = last_error
    _set_job_status(job_id, "done")
    logger.error(
        "[AI_JOB] job_id=%s status=done attempts=%s failure_reason=%s fallback=true",
        job_id,
        JOB_MAX_ATTEMPTS,
        last_error,
    )


async def generate_test_internal(request: GeneratedTestRequest) -> Dict[str, Any]:
    """
    Unified generation pipeline used by both endpoints.

    Returns:
    {
      "fallback_test": {...},
      "job_id": "..."
    }
    """
    job_id = str(uuid.uuid4())
    fallback_data = _fallback_test(request.prompt, request.base_url)
    fallback_response = {
        **fallback_data,
        "is_fallback": True,
        "reason": "Instant fallback",
        "job_id": job_id,
    }

    try:
        jobs[job_id] = {
            "status": "pending",
            "result": None,
            "error": None,
            "attempts": 0,
            "fallback_test": fallback_response,
        }
        logger.info("[AI_JOB] job_id=%s status_transition=none->pending attempts=0", job_id)

        dom_elements = await _ensure_dom_elements(request.base_url, request.dom_elements)
        asyncio.create_task(run_llm(job_id, request.prompt, request.base_url, dom_elements))
        logger.info("[AI_JOB] job_id=%s background_task=started", job_id)
        return {"fallback_test": fallback_response, "job_id": job_id}
    except Exception as exc:  # noqa: BLE001
        jobs[job_id] = {
            "status": "done",
            "result": fallback_response,
            "error": str(exc),
            "attempts": 0,
            "fallback_test": fallback_response,
        }
        logger.exception("[AI_JOB] job_id=%s status=done failure_reason=%s fallback=true", job_id, exc)
        return {"fallback_test": fallback_response, "job_id": job_id}


async def poll_job(
    job_id: str,
    timeout: float = POLL_TIMEOUT_SECONDS,
    interval: float = POLL_INTERVAL_SECONDS,
) -> Optional[Dict[str, Any]]:
    """
    Poll a job for AI completion.

    Returns:
    - AI test when DONE
    - None when timeout or FAILED
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    while loop.time() < deadline:
        job = jobs.get(job_id)
        if not job:
            return None
        status = job.get("status")
        if status == "done":
            return job.get("result")
        if status == "failed":
            return None
        await asyncio.sleep(interval)

    return None


@router.post("/generate-test", response_model=GeneratedTestResponse)
async def generate_test(request: GeneratedTestRequest) -> GeneratedTestResponse:
    """
    Generate a structured test from a natural language prompt.

    Returns fallback immediately with job_id for async LLM generation.
    """
    internal = await generate_test_internal(request)
    fallback_test = internal["fallback_test"]
    return GeneratedTestResponse(**fallback_test)


@router.post("/generate-suite")
async def generate_suite(request: GeneratedTestRequest) -> Dict[str, Any]:
    """
    Generate a complete application test suite using the multi-phase QA model.
    """
    try:
        dom_elements = await _ensure_dom_elements(request.base_url, request.dom_elements)
        suite_timeout = float(os.getenv("SUITE_TIMEOUT_SECONDS", "90"))
        async with asyncio.timeout(suite_timeout):
            suite = await asyncio.to_thread(
                generator.generate_test_suite,
                request.prompt,
                request.base_url,
                dom_elements,
                2,
            )
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        suite_path = REPORTS_DIR / f"suite_{ts}.json"
        suite_path.write_text(json.dumps(suite, indent=2), encoding="utf-8")
        return suite
    except TimeoutError as exc:
        logger.exception("Suite generation timed out: %s", exc)
        raise HTTPException(status_code=504, detail="Suite generation timed out") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Suite generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Suite generation failed: {exc}") from exc


@router.get("/result/{job_id}", response_model=GeneratedTestResponse)
async def get_generation_result(job_id: str) -> GeneratedTestResponse:
    """Get generation result for an async job."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    status = job.get("status")
    if status == "done":
        return GeneratedTestResponse(**job["result"])

    if status == "failed":
        # Do not return empty payloads on failure.
        if job.get("result"):
            return GeneratedTestResponse(**job["result"])
        fallback_data = _fallback_test("", None)
        return GeneratedTestResponse(
            test_name=fallback_data["test_name"],
            base_url=fallback_data["base_url"],
            steps=fallback_data["steps"],
            is_fallback=True,
            reason=f"LLM failed: {job.get('error')}",
            job_id=job_id,
        )

    # pending/running: return known fallback.
    fallback_response = job.get("fallback_test")
    if fallback_response:
        return GeneratedTestResponse(**fallback_response)
    fallback_data = _fallback_test("", None)
    return GeneratedTestResponse(
        test_name=fallback_data["test_name"],
        base_url=fallback_data["base_url"],
        steps=fallback_data["steps"],
        is_fallback=True,
        reason="LLM still generating",
        job_id=job_id,
    )


@router.get("/job/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str) -> JobStatusResponse:
    """Get status for an async generation job."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    status = job.get("status")
    if status == "done":
        return JobDoneResponse(status="done", result=GeneratedTestResponse(**job["result"]))
    if status == "failed":
        return JobFailedResponse(status="failed", error=str(job.get("error") or "Unknown error"))
    if status == "running":
        return JobRunningResponse(status="running")
    return JobPendingResponse(status="pending")


async def _execute_structured_test(test_payload: Dict[str, Any], request: GenerateAndRunRequest) -> Any:
    """Execute a structured test payload through the standard runner."""
    steps = test_payload.get("steps", [])
    test_name = test_payload.get("test_name") or "generated_test"
    test_payload["test_name"] = test_name

    if not steps:
        return None

    converted_steps = []
    for step in steps:
        converted_step = {
            "action": step["action"],
            "url": step.get("url"),
            "selector": step.get("selector"),
            "value": step.get("value"),
            "timeout": step.get("timeout"),
            "name": step.get("name"),
            "retries": step.get("retries"),
            "capture_screenshot": step.get("capture_screenshot"),
        }
        converted_steps.append({k: v for k, v in converted_step.items() if v is not None})

    test_request = TestRequest(
        test_name=test_name,
        base_url=test_payload.get("base_url", request.base_url or "https://example.com"),
        steps=converted_steps,
        browser=request.browser,
        headless=request.headless,
        config=request.config,
        screenshot_suite_id=test_payload.get("screenshot_suite_id"),
        screenshot_test_name=test_payload.get("screenshot_test_name"),
    )
    return await run_test(test_request)


@router.post("/generate-and-run", response_model=GenerateAndRunResponse)
async def generate_and_run_test(request: GenerateAndRunRequest) -> Dict[str, Any]:
    try:
        # Mode 1: direct execution
        if request.test:
            executed_test = dict(request.test)
            executed_test.setdefault("test_name", "direct_test")
            if request.base_url and not executed_test.get("base_url"):
                executed_test["base_url"] = request.base_url
            execution_result = await _execute_structured_test(executed_test, request)
            logger.info(
                "[UI_EXECUTION] direct test=%s screenshot=%s exists=%s",
                executed_test.get("test_name"),
                getattr(execution_result, "screenshot_url", None) if execution_result else None,
                getattr(execution_result, "screenshot_exists", False) if execution_result else False,
            )
            return {
                "executed_test": executed_test,
                "source": "direct",
                "decision_reason": "direct_input",
                "execution_result": execution_result,
                "job_id": None,
            }

        # Mode 2/3: reused job or new AI generation
        mode = "new_job"
        if request.job_id:
            mode = "reused_job"
            job_id = request.job_id
            logger.info("[FLOW] mode=%s", mode)
            job = jobs.get(job_id)
            fallback_test = (job or {}).get("fallback_test") or _fallback_test(
                request.prompt or "",
                request.base_url,
            )
            fallback_test = {
                **fallback_test,
                "is_fallback": True,
                "reason": "Fallback for reused job",
                "job_id": job_id,
            }
        else:
            logger.info("[FLOW] mode=%s", mode)
            internal = await generate_test_internal(
                GeneratedTestRequest(
                    prompt=request.prompt or "",
                    base_url=request.base_url,
                    dom_elements=request.dom_elements,
                )
            )
            fallback_test = internal["fallback_test"]
            job_id = internal["job_id"]

        ai_candidate = await poll_job(job_id, timeout=3.0, interval=POLL_INTERVAL_SECONDS)
        final_status = str(jobs.get(job_id, {}).get("status", "missing"))
        logger.info("[JOB] job_id=%s status=%s", job_id, final_status)

        source = "fallback"
        decision_reason = "ai_failed_or_timeout" if mode == "reused_job" else "fresh_timeout"
        executed_test: Dict[str, Any] = fallback_test

        if ai_candidate and not ai_candidate.get("is_fallback", True):
            ai_valid, validation_detail = validate_test(ai_candidate)
            if ai_valid:
                executed_test = ai_candidate
                source = "ai"
                decision_reason = "reused_ai_result" if mode == "reused_job" else "fresh_ai_success"
            else:
                logger.warning("[VALIDATION] pass=false detail=%s", validation_detail)
                decision_reason = "ai_failed_or_timeout" if mode == "reused_job" else "fresh_timeout"
        elif mode == "reused_job":
            decision_reason = "ai_failed_or_timeout"

        logger.info("[DECISION] source=%s reason=%s", source, decision_reason)

        executed_test["job_id"] = job_id
        executed_test["is_fallback"] = source != "ai"
        execution_result = await _execute_structured_test(executed_test, request)
        if execution_result is None:
            logger.warning("[DECISION] source=%s reason=no_steps_to_execute", source)
        else:
            logger.info(
                "[UI_EXECUTION] source=%s test=%s screenshot=%s exists=%s",
                source,
                executed_test.get("test_name"),
                getattr(execution_result, "screenshot_url", None),
                getattr(execution_result, "screenshot_exists", False),
            )

        return {
            "executed_test": executed_test,
            "source": source,
            "decision_reason": decision_reason,
            "execution_result": execution_result,
            "job_id": job_id,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("[AI_JOB] job_id=unknown final_status=failed error=%s", exc)
        logger.exception("[DECISION] source=fallback reason=ai_failed_or_timeout error=%s", exc)
        fallback_data = _fallback_test(request.prompt or "", request.base_url)
        return {
            "executed_test": {
                **fallback_data,
                "is_fallback": True,
                "reason": f"Internal error fallback: {exc}",
                "job_id": None,
            },
            "source": "fallback",
            "decision_reason": "ai_failed_or_timeout",
            "execution_result": None,
            "job_id": None,
        }


@router.post("/save-report")
async def save_execution_report(payload: Dict[str, Any]) -> Dict[str, Any]:
    executions = payload.get("executions")
    if not isinstance(executions, list) or len(executions) == 0:
        raise HTTPException(status_code=400, detail="executions must be a non-empty list")
    html = _generate_execution_report_html(executions)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = REPORTS_DIR / f"report_{ts}.html"
    report_path.write_text(html, encoding="utf-8")
    stat = report_path.stat()
    logger.info("[REPORT] saved report name=%s size=%s", report_path.name, stat.st_size)
    return {
        "name": report_path.name,
        "url": f"/storage/reports/{report_path.name}",
        "size_bytes": stat.st_size,
        "updated_at": stat.st_mtime,
    }


@router.post("/run-suite-and-save-report")
async def run_suite_and_save_report(payload: Dict[str, Any]) -> Dict[str, Any]:
    suite = payload.get("suite") or {}
    base_url = payload.get("base_url")
    tests = ((suite.get("test_suite") or {}).get("tests") or [])
    if not isinstance(tests, list) or len(tests) == 0:
        raise HTTPException(status_code=400, detail="suite.test_suite.tests must be a non-empty list")

    req_browser = payload.get("browser", "chromium")
    req_headless = bool(payload.get("headless", True))
    req_config = payload.get("config") or {"headless": req_headless, "slow_mo": 0}
    suite_id = payload.get("suite_id") or datetime.now().strftime("suite_%Y%m%d_%H%M%S")
    logger.info("[UI_EXECUTION] suite start suite_id=%s tests=%s base_url=%s", suite_id, len(tests), base_url)

    indexed_tests: List[Dict[str, Any]] = []
    for idx, test in enumerate(tests, start=1):
        phase = _phase_for_test_type(test.get("test_type"))
        indexed_tests.append(
            {
                "original_index": idx - 1,
                "test": test,
                "priority": phase["priority"],
                "phase": phase["phase"],
            }
        )
    indexed_tests.sort(key=lambda item: (item["priority"], item["original_index"]))

    baseline_tests = [item for item in indexed_tests if item["priority"] in {1, 2}]
    downstream_tests = [item for item in indexed_tests if item["priority"] >= 3]

    executions: List[Dict[str, Any]] = []
    baseline_success = True
    baseline_flow: Dict[str, Any] = {
        "authenticated": False,
        "working_routes": [],
        "validated_selectors": [],
        "successful_pages": [],
        "failed_tests": [],
        "phase_order": ["positive_flows", "e2e_flows", "negative_flows", "edge_flows"],
    }

    for item in baseline_tests:
        idx = item["original_index"] + 1
        test = item["test"]
        steps = test.get("steps") or []
        if not isinstance(steps, list):
            continue
        execution_steps = []
        for s_idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            is_final = s_idx == len(steps) - 1
            is_assert = str(step.get("action") or "").startswith("assert")
            execution_steps.append(
                {
                    **step,
                    "capture_screenshot": bool(step.get("capture_screenshot")) or is_final or is_assert,
                }
            )

        try:
            run_request = GenerateAndRunRequest(
                test={
                    "test_name": test.get("test_name") or f"suite_test_{idx}",
                    "base_url": base_url or suite.get("base_url") or "https://example.com",
                    "steps": execution_steps,
                    "screenshot_suite_id": suite_id,
                    "screenshot_test_name": _safe_name(test.get("test_name") or f"suite_test_{idx}"),
                },
                base_url=base_url,
                browser=req_browser,
                headless=req_headless,
                config=req_config,
            )
            run_result = await generate_and_run_test(run_request)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[RUN_SUITE] test_index=%s failed before execution: %s", idx, exc)
            run_result = {
                "execution_result": {
                    "status": "failed",
                    "error": str(exc),
                    "steps_executed": [],
                }
            }
        execution_result = _enrich_execution_result(_as_dict(run_result.get("execution_result")))
        passed = _is_passed_status(execution_result.get("status"))
        if not passed:
            baseline_success = False
            baseline_flow["failed_tests"].append(test.get("test_name") or f"suite_test_{idx}")
        else:
            if execution_result.get("base_url"):
                baseline_flow["working_routes"].append(execution_result.get("base_url"))
            if execution_result.get("screenshot_url"):
                baseline_flow["successful_pages"].append(execution_result.get("screenshot_url"))
            for step_result in execution_result.get("steps_executed", []):
                selector_used = step_result.get("selector_used")
                if selector_used:
                    baseline_flow["validated_selectors"].append(selector_used)
        if execution_result.get("status") and _is_passed_status(execution_result.get("status")) and test.get("feature", "").lower().find("auth") >= 0:
            baseline_flow["authenticated"] = True
        executions.append(
            {
                "test_name": test.get("test_name") or f"suite_test_{idx}",
                "test_type": test.get("test_type", "unknown"),
                "execution_priority": item["priority"],
                "execution_phase": item["phase"],
                "execution_result": execution_result,
                "timestamp": datetime.now().isoformat(),
            }
        )
        logger.info(
            "[UI_EXECUTION] suite_id=%s test=%s status=%s screenshot=%s exists=%s",
            suite_id,
            test.get("test_name") or f"suite_test_{idx}",
            execution_result.get("status"),
            execution_result.get("screenshot_url"),
            execution_result.get("screenshot_exists"),
        )

    # If baseline is not stable, do not execute negative/edge scenarios.
    if baseline_success:
        for item in downstream_tests:
            idx = item["original_index"] + 1
            test = item["test"]
            steps = test.get("steps") or []
            if not isinstance(steps, list):
                continue
            execution_steps = []
            for s_idx, step in enumerate(steps):
                if not isinstance(step, dict):
                    continue
                is_final = s_idx == len(steps) - 1
                is_assert = str(step.get("action") or "").startswith("assert")
                execution_steps.append(
                    {
                        **step,
                        "capture_screenshot": bool(step.get("capture_screenshot")) or is_final or is_assert,
                    }
                )
            try:
                run_request = GenerateAndRunRequest(
                    test={
                        "test_name": test.get("test_name") or f"suite_test_{idx}",
                        "base_url": base_url or suite.get("base_url") or "https://example.com",
                        "steps": execution_steps,
                        "screenshot_suite_id": suite_id,
                        "screenshot_test_name": _safe_name(test.get("test_name") or f"suite_test_{idx}"),
                    },
                    base_url=base_url,
                    browser=req_browser,
                    headless=req_headless,
                    config=req_config,
                )
                run_result = await generate_and_run_test(run_request)
            except Exception as exc:  # noqa: BLE001
                logger.exception("[RUN_SUITE] test_index=%s failed before execution: %s", idx, exc)
                run_result = {
                    "execution_result": {
                        "status": "failed",
                        "error": str(exc),
                        "steps_executed": [],
                    }
                }
            execution_result = _enrich_execution_result(_as_dict(run_result.get("execution_result")))
            executions.append(
                {
                    "test_name": test.get("test_name") or f"suite_test_{idx}",
                    "test_type": test.get("test_type", "unknown"),
                    "execution_priority": item["priority"],
                    "execution_phase": item["phase"],
                    "execution_result": execution_result,
                    "timestamp": datetime.now().isoformat(),
                }
            )
            logger.info(
                "[UI_EXECUTION] suite_id=%s test=%s status=%s screenshot=%s exists=%s",
                suite_id,
                test.get("test_name") or f"suite_test_{idx}",
                execution_result.get("status"),
                execution_result.get("screenshot_url"),
                execution_result.get("screenshot_exists"),
            )
    else:
        for item in downstream_tests:
            idx = item["original_index"] + 1
            test = item["test"]
            executions.append(
                {
                    "test_name": test.get("test_name") or f"suite_test_{idx}",
                    "test_type": test.get("test_type", "unknown"),
                    "execution_priority": item["priority"],
                    "execution_phase": item["phase"],
                    "execution_result": {
                        "status": "skipped",
                        "error": "Skipped because baseline workflow failed",
                        "steps_executed": [],
                        "screenshot_exists": False,
                    },
                    "timestamp": datetime.now().isoformat(),
                    "blocked_by_baseline": True,
                }
            )
        logger.warning("[UI_EXECUTION] suite_id=%s baseline failed; downstream negative/edge tests skipped", suite_id)

    # Deduplicate baseline reference lists
    baseline_flow["working_routes"] = list(dict.fromkeys(baseline_flow["working_routes"]))
    baseline_flow["validated_selectors"] = list(dict.fromkeys(baseline_flow["validated_selectors"]))
    baseline_flow["successful_pages"] = list(dict.fromkeys(baseline_flow["successful_pages"]))

    html = _generate_execution_report_html(executions)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = REPORTS_DIR / f"report_{ts}.html"
    report_path.write_text(html, encoding="utf-8")
    stat = report_path.stat()
    screenshot_summary = _count_execution_screenshots(executions)
    execution_artifact = {
        "suite_id": suite_id,
        "generated_at": datetime.now().isoformat(),
        "base_url": base_url,
        "suite": suite,
        "baseline_workflow": baseline_flow,
        "baseline_success": baseline_success,
        "executions": executions,
        "screenshot_summary": screenshot_summary,
        "report": {
            "name": report_path.name,
            "url": f"/storage/reports/{report_path.name}",
            "size_bytes": stat.st_size,
            "updated_at": stat.st_mtime,
        },
    }
    execution_path = EXECUTIONS_DIR / f"{suite_id}.json"
    execution_path.write_text(json.dumps(execution_artifact, indent=2), encoding="utf-8")
    execution_stat = execution_path.stat()
    logger.info(
        "[UI_EXECUTION] artifact saved suite_id=%s file=%s screenshots=%s/%s",
        suite_id,
        execution_path.name,
        screenshot_summary["tests_with_screenshots"],
        screenshot_summary["total_screenshots"],
    )
    logger.info("[REPORT] saved report via run-suite endpoint name=%s size=%s", report_path.name, stat.st_size)
    return {
        "suite_id": suite_id,
        "baseline_success": baseline_success,
        "baseline_workflow": baseline_flow,
        "executions": executions,
        "screenshot_summary": screenshot_summary,
        "execution_artifact": {
            "name": execution_path.name,
            "url": f"/storage/executions/{execution_path.name}",
            "size_bytes": execution_stat.st_size,
            "updated_at": execution_stat.st_mtime,
        },
        "report": {
            "name": report_path.name,
            "url": f"/storage/reports/{report_path.name}",
            "size_bytes": stat.st_size,
            "updated_at": stat.st_mtime,
        },
    }

from pydantic import BaseModel

class CodeGenRequest(BaseModel):
    test_name: str
    base_url: str
    steps: list

@router.post("/codegen")
async def generate_playwright_code(req: CodeGenRequest):
    try:
        from services.codegen import PlaywrightCodeGen
        code = PlaywrightCodeGen.generate_spec(
            test_name=req.test_name,
            base_url=req.base_url,
            steps=req.steps
        )
        return {"code": code}
    except Exception as e:
        logger.error(f"Codegen failed: {e}")
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))
