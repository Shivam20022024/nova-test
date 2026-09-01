"""
Flexible, AI-assisted bulk import — for the real-world case the strict
deterministic importer (test_import.py) doesn't cover: a QA team's manual
test-case tracker, where each row is a test case described in free text
("1. Enter valid username\n2. Tap Login", "Expected: user is redirected...")
rather than our internal action/locator schema. Column names and order vary
by team — this adapts to that instead of requiring one fixed layout.

Each row becomes one natural-language objective, fed through the SAME
generate_test_steps() pipeline already used for a single document (same
grounding, same hallucination flagging — rule: one AI entry point, not two).
Runs as a background job since a real tracker can have 100+ rows and each
AI call takes a few seconds — a single blocking HTTP request would time out
long before it finished.
"""
from __future__ import annotations

import csv
import io
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from mobile.emulator_manager import is_enabled as _emu_autostart
from utils.logger import get_logger

logger = get_logger("mobile.batch_generate")

# Recognized header meanings, in claim order — a header is matched to the
# FIRST field whose keywords it contains, so a column like "Test Case ID"
# (which contains both "id" and "test case") is claimed by "id" before
# "title" gets a chance to also match it. Order matters.
_COLUMN_MATCHERS: List[Tuple[str, List[str]]] = [
    ("id", ["test case id", "test id", "tc id", "case id"]),
    ("title", ["test case", "test name", "test title", "scenario", "title", "summary", "case name"]),
    ("module", ["module", "feature", "category", "component"]),
    ("preconditions", ["precondition", "pre-condition", "prerequisite"]),
    ("steps", ["test steps", "steps", "step description", "action", "procedure"]),
    ("test_data", ["test data", "data", "input"]),
    ("expected", ["expected result", "expected", "outcome"]),
    ("priority", ["priority", "severity"]),
    ("type", ["type", "test type"]),
]


class BatchValidationError(Exception):
    pass


def _detect_columns(headers: List[str]) -> Dict[str, str]:
    """Maps our field names to whichever actual header matched — returned so
    the caller can show the user what was detected (never silently guess
    without disclosing the guess)."""
    mapping: Dict[str, str] = {}
    claimed: set = set()
    for field, keywords in _COLUMN_MATCHERS:
        for h in headers:
            if h in claimed:
                continue
            hl = h.strip().lower()
            if any(kw in hl for kw in keywords):
                mapping[field] = h
                claimed.add(h)
                break
    return mapping


def _row_to_objective(row: Dict[str, Any], mapping: Dict[str, str]) -> Optional[Tuple[str, str, Dict[str, Any]]]:
    """Returns (title, objective_text, source_meta) or None if the row has no
    usable signal at all (e.g. a fully blank row). `source_meta` carries the
    row's own identifiers/expectations through to the test so the final report
    can be mapped back to the client's document."""
    def get(field: str) -> str:
        header = mapping.get(field)
        if not header:
            return ""
        val = row.get(header)
        return str(val).strip() if val is not None else ""

    title = get("title") or get("id") or ""
    steps = get("steps")
    expected = get("expected")
    preconditions = get("preconditions")
    test_data = get("test_data")
    module = get("module")

    if not title and not steps and not expected:
        return None  # nothing usable in this row — skip, don't fabricate a test from silence

    parts = []
    if module:
        parts.append(f"Module: {module}")
    if title:
        parts.append(f"Test case: {title}")
    if preconditions:
        parts.append(f"Preconditions: {preconditions}")
    if steps:
        parts.append(f"Steps:\n{steps}")
    if test_data:
        parts.append(f"Test data: {test_data}")
    if expected:
        parts.append(f"Expected result: {expected}")

    objective = "\n".join(parts)
    display_title = title or get("id") or "Untitled test case"
    tc_id = get("id")
    if tc_id and tc_id not in display_title:
        display_title = f"{tc_id} — {display_title}"

    from mobile.automatability import classify
    verdict = classify("\n".join(filter(None, [title, steps, expected, preconditions])), get("type"))

    meta = {
        "test_case_id": tc_id or None,
        "module": module or None,
        "expected_result": expected or None,
        "type": get("type") or None,
        "priority": get("priority") or None,
        "data": test_data or None,
        "automatable": verdict["automatable"],
        "not_automatable_reason": verdict["reason"],
        "needs": verdict["needs"],
    }
    return display_title[:255], objective, meta


def parse_rows(filename: str, raw: bytes) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Returns (headers, rows) for a .csv or .xlsx file. Raises
    BatchValidationError for anything else or anything unparseable."""
    lower = filename.lower()
    if lower.endswith(".csv"):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BatchValidationError(f"CSV must be UTF-8 encoded: {exc}") from exc
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            raise BatchValidationError("CSV has no header row.")
        headers = list(reader.fieldnames)
        rows = [dict(r) for r in reader]
        return headers, rows

    if lower.endswith(".xlsx"):
        try:
            import openpyxl
        except ImportError as exc:
            raise BatchValidationError("XLSX import requires openpyxl.") from exc
        try:
            wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
            sheet = wb.worksheets[0]
            rows_iter = sheet.iter_rows(values_only=True)
            headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
            rows = []
            for r in rows_iter:
                if not any(c is not None and str(c).strip() for c in r):
                    continue  # skip blank rows
                rows.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
            wb.close()
        except BatchValidationError:
            raise
        except Exception as exc:
            raise BatchValidationError(f"Could not parse XLSX: {exc}") from exc
        return headers, rows

    raise BatchValidationError(f"Unsupported file type for batch generation: {filename} (use .csv or .xlsx).")


# ── In-memory job tracking ─────────────────────────────────────────────────
# Not persisted to the DB: a batch-generation job is a one-off run-once
# action, not durable state anything else needs to query after this process
# restarts (unlike executions/tests, which are the actual product of a run).
_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def start_batch_job(
    filename: str, raw: bytes, application_id: Optional[int], device_id: Optional[int] = None,
) -> Dict[str, Any]:
    headers, rows = parse_rows(filename, raw)
    mapping = _detect_columns(headers)
    if not mapping:
        raise BatchValidationError(
            f"Could not recognize any test-case columns in {filename}. "
            f"Found headers: {headers}. Expected something like a title/test-case, steps, and "
            f"expected-result column (names can vary — e.g. 'Test Case', 'Steps', 'Expected Result')."
        )

    objectives: List[Tuple[str, str, Dict[str, Any]]] = []
    skipped = 0
    for row in rows:
        mapped = _row_to_objective(row, mapping)
        if mapped is None:
            skipped += 1
            continue
        objectives.append(mapped)

    if not objectives:
        raise BatchValidationError("No rows had enough content to generate a test case from.")

    # Ground on the app's REAL Screen Map (mobile/explorer.py). Resolve it once
    # up front; if there isn't one yet and we have a device, crawl the app now
    # so every row is generated against elements that provably exist. Falls
    # back to stored-hierarchy grounding only if a crawl isn't possible.
    screen_map = None
    grounding = None
    if application_id:
        from mobile.database import SessionLocal as _SessionLocal
        from mobile.api import _screen_map_for, _ground_from_recent_hierarchy, _latest_valid_version
        _db = _SessionLocal()
        try:
            screen_map = _screen_map_for(_db, application_id)
            if screen_map is None and device_id:
                version = _latest_valid_version(_db, application_id)
                if version:
                    try:
                        from mobile.explorer import run_exploration
                        screen_map = run_exploration(version.id, device_id)
                    except Exception:
                        logger.exception("Batch pre-generation exploration failed (continuing)")
            if screen_map is None:
                grounding = _ground_from_recent_hierarchy(_db, application_id)
        finally:
            _db.close()

    # The suite exists from the start (not created after generation finishes)
    # so every test created below can be tagged with it as it's made, rather
    # than needing a second pass to retroactively link 124 rows to a suite.
    suite_id = None
    autorun = bool(device_id) or _emu_autostart()
    if autorun:
        from mobile.database import SessionLocal as _SessionLocal
        from mobile.models import MobileTestSuite
        _db = _SessionLocal()
        try:
            suite = MobileTestSuite(
                name=filename, application_id=application_id, device_id=device_id, source="XLSX_BATCH",
            )
            _db.add(suite)
            _db.commit()
            _db.refresh(suite)
            suite_id = suite.id
        finally:
            _db.close()

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "RUNNING",
        "filename": filename,
        "detected_columns": mapping,
        "total_rows": len(objectives),
        "skipped_rows": skipped,
        "processed": 0,
        "has_grounding": bool(screen_map) or grounding is not None,
        "grounded_on": "screen_map" if screen_map else ("stored_hierarchy" if grounding else "none"),
        "screen_map_screens": screen_map["screen_count"] if screen_map else 0,
        "not_automatable_rows": sum(1 for _, _, m in objectives if m.get("automatable") is False),
        "suite_id": suite_id,
        "created": [],   # [{title, test_id, step_count, hallucinated_step_count, unverified_step_count}]
        "failed": [],    # [{title, reason}]
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job

    thread = threading.Thread(
        target=_run_batch_job,
        args=(job_id, objectives, application_id, screen_map, grounding, suite_id, device_id),
        daemon=True,
    )
    thread.start()
    return dict(job)


# Each row's generation is a fully independent OpenAI call — same prompt,
# same grounding, same per-row precision as running them one at a time.
# Running them concurrently instead of sequentially is what actually makes a
# 124-row sheet take ~1-2 minutes instead of ~8-10: wall-clock time was
# almost entirely per-call network/model latency, not local work. Capped
# (not unbounded) to stay under typical OpenAI per-account rate limits
# rather than firing all rows at once.
_MAX_CONCURRENT_GENERATIONS = 8


def _generate_one_row(
    title: str, objective: str, meta: Dict[str, Any], application_id: Optional[int],
    screen_map, grounding, suite_id: Optional[int],
) -> Dict[str, Any]:
    """Runs in a worker thread — opens its own DB session (SQLAlchemy
    sessions aren't thread-safe to share). A row the classifier marked
    not-automatable still becomes a test (so it shows in the report), but a
    minimal stub one — the suite runner will record it SKIPPED with the
    reason rather than execute fake steps."""
    from mobile.ai_gateway import generate_test_steps
    from mobile.database import SessionLocal
    from mobile.models import MobileTest

    db = SessionLocal()
    try:
        if meta.get("automatable") is False:
            test = MobileTest(
                name=title, description=objective[:2000], application_id=application_id, suite_id=suite_id,
                steps=[{"action": "LAUNCH", "locator": None, "value": None, "timeout_ms": 8000, "risk": "LOW_RISK"}],
                risk_level="LOW_RISK", source_meta=meta,
            )
            db.add(test)
            db.commit()
            db.refresh(test)
            return {"ok": True, "title": title, "test_id": test.id, "step_count": 0,
                    "hallucinated_step_count": 0, "unverified_step_count": 0, "skipped": True}

        result = generate_test_steps(objective, screen_map=screen_map, grounding_elements=grounding, test_data=meta.get("data"))
        steps = result["steps"]
        hallucinated = sum(1 for s in steps if s.get("grounded") is False)
        unverified = sum(1 for s in steps if s.get("grounded") is None and (s.get("locator") or {}).get("value"))
        for s in steps:
            s.pop("grounded", None)
        test = MobileTest(
            name=title, description=objective[:2000], application_id=application_id, suite_id=suite_id,
            steps=steps, risk_level="LOW_RISK", source_meta=meta,
        )
        db.add(test)
        db.commit()
        db.refresh(test)
        return {
            "ok": True, "title": title, "test_id": test.id, "step_count": len(steps),
            "hallucinated_step_count": hallucinated, "unverified_step_count": unverified, "skipped": False,
        }
    except Exception as exc:
        return {"ok": False, "title": title, "reason": str(exc)[:500]}
    finally:
        db.close()


def _run_batch_job(
    job_id: str, objectives: List[Tuple[str, str, Dict[str, Any]]], application_id: Optional[int],
    screen_map, grounding, suite_id: Optional[int], device_id: Optional[int],
) -> None:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        with ThreadPoolExecutor(max_workers=_MAX_CONCURRENT_GENERATIONS) as pool:
            futures = {
                pool.submit(_generate_one_row, title, objective, meta, application_id, screen_map, grounding, suite_id): title
                for title, objective, meta in objectives
            }
            for future in as_completed(futures):
                try:
                    outcome = future.result()
                except Exception as exc:
                    outcome = {"ok": False, "title": futures[future], "reason": str(exc)[:500]}

                with _jobs_lock:
                    if outcome["ok"]:
                        _jobs[job_id]["created"].append({
                            "title": outcome["title"], "test_id": outcome["test_id"], "step_count": outcome["step_count"],
                            "hallucinated_step_count": outcome["hallucinated_step_count"],
                            "unverified_step_count": outcome["unverified_step_count"],
                            "not_automatable": bool(outcome.get("skipped")),
                        })
                    else:
                        logger.warning("Batch generation failed for row %r: %s", outcome["title"], outcome["reason"])
                        _jobs[job_id]["failed"].append({"title": outcome["title"], "reason": outcome["reason"]})
                    _jobs[job_id]["processed"] += 1
    finally:
        with _jobs_lock:
            _jobs[job_id]["status"] = "COMPLETED"
            _jobs[job_id]["completed_at"] = datetime.now(timezone.utc).isoformat()
            created_any = bool(_jobs[job_id]["created"])

        # Auto-run the whole suite the moment every row has a generated test.
        # Spawn it as its own thread (same pattern as the API's
        # _create_suite_and_run) so a failure here is isolated and clearly
        # logged, rather than silently dying inside this finally block.
        if suite_id and created_any and (device_id or _emu_autostart()):
            logger.info("Batch job %s complete — auto-running suite %s", job_id, suite_id)
            try:
                from mobile.suite_engine import run_suite
                threading.Thread(target=run_suite, args=(suite_id,), daemon=True, name=f"suite-{suite_id}").start()
            except Exception:
                logger.exception("Auto-run of suite %s failed to start after batch generation", suite_id)
        elif suite_id and not created_any:
            logger.warning("Batch job %s created no tests — suite %s not started", job_id, suite_id)
