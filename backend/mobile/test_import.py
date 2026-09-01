"""
Deterministic test-case import — CSV/JSON/XLS, single or bulk (rule: existing
test cases / bulk upload input modes). No AI involved: this is a data mapping
problem, not a generation problem, so nothing here needs review-before-save
the way AI-generated tests do.

CSV shape (one row per step, grouped by test_name):
    test_name,application_id,risk_level,action,locator_strategy,locator_value,locator_hint,value,timeout_ms

JSON shape: either one test object or a list of them:
    {"name": "...", "application_id": 1, "steps": [{"action": "TAP", "locator": {...}, ...}, ...]}
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any, Dict, List

from mobile.schemas import Locator, TestStep


class ImportValidationError(Exception):
    pass


def _step_from_dict(d: Dict[str, Any]) -> TestStep:
    try:
        return TestStep(**d)
    except Exception as exc:
        raise ImportValidationError(f"Invalid step {d}: {exc}") from exc


def parse_json_tests(raw: bytes) -> List[Dict[str, Any]]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ImportValidationError(f"Not valid JSON: {exc}") from exc

    objs = data if isinstance(data, list) else [data]
    tests = []
    for obj in objs:
        if "name" not in obj or "steps" not in obj:
            raise ImportValidationError("Each test object needs at least 'name' and 'steps'.")
        steps = [_step_from_dict(s).dict() for s in obj["steps"]]
        tests.append({
            "name": obj["name"],
            "description": obj.get("description"),
            "application_id": obj.get("application_id"),
            "risk_level": obj.get("risk_level", "LOW_RISK"),
            "steps": steps,
        })
    return tests


def parse_csv_tests(raw: bytes) -> List[Dict[str, Any]]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportValidationError(f"CSV must be UTF-8 encoded: {exc}") from exc

    reader = csv.DictReader(io.StringIO(text))
    required = {"test_name", "action"}
    if reader.fieldnames is None or not required.issubset(set(reader.fieldnames)):
        raise ImportValidationError(f"CSV must have at least columns: {sorted(required)}")

    grouped: "dict[str, dict]" = {}
    for row_num, row in enumerate(reader, start=2):
        test_name = (row.get("test_name") or "").strip()
        action = (row.get("action") or "").strip()
        if not test_name or not action:
            raise ImportValidationError(f"Row {row_num}: 'test_name' and 'action' are required.")

        bucket = grouped.setdefault(test_name, {
            "name": test_name,
            "description": None,
            "application_id": int(row["application_id"]) if row.get("application_id") else None,
            "risk_level": row.get("risk_level") or "LOW_RISK",
            "steps": [],
        })

        locator = None
        if row.get("locator_value"):
            locator = Locator(
                strategy=row.get("locator_strategy") or "resource_id",
                value=row["locator_value"],
                hint=row.get("locator_hint") or None,
            ).dict()

        step = _step_from_dict({
            "action": action,
            "locator": locator,
            "value": row.get("value") or None,
            "timeout_ms": int(row["timeout_ms"]) if row.get("timeout_ms") else 8000,
            "risk": row.get("step_risk") or "LOW_RISK",
        })
        bucket["steps"].append(step.dict())

    return list(grouped.values())


def parse_test_file(filename: str, raw: bytes) -> List[Dict[str, Any]]:
    lower = filename.lower()
    if lower.endswith(".json"):
        return parse_json_tests(raw)
    if lower.endswith(".csv"):
        return parse_csv_tests(raw)
    raise ImportValidationError(f"Unsupported import file type: {filename} (use .csv or .json).")
