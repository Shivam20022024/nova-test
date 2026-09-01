"""
Deterministic failure classification (sections 56/57). LLM classification is
deliberately not wired in here — deterministic rules run first and are
sufficient for the golden path; an AI-assisted second opinion is a Phase-2
extension point (mobile/ai_gateway.py), never the first-line classifier.
"""
from __future__ import annotations

import datetime
from typing import Optional

from sqlalchemy.orm import Session

from mobile.models import MobileFailure

# error_code -> (category, recommended_action)
_RULES = {
    "ELEMENT_NOT_FOUND": ("LOCATOR_FAILURE", "AUTOHEAL_OR_REVIEW"),
    "LOCATOR_TIMEOUT": ("LOCATOR_FAILURE", "AUTOHEAL_OR_REVIEW"),
    "ASSERTION_FAILURE": ("APPLICATION_DEFECT", "CREATE_DEFECT"),
    "TEXT_MISMATCH": ("APPLICATION_DEFECT", "CREATE_DEFECT"),
    "NAVIGATION_ERROR": ("TEST_DEFECT", "HUMAN_REVIEW"),
    "APP_LAUNCH_FAILURE": ("APPLICATION_DEFECT", "CREATE_DEFECT"),
    "APP_CRASH": ("APP_CRASH", "CREATE_DEFECT"),
    "ANR": ("ANR", "CREATE_DEFECT"),
    "DEVICE_UNAVAILABLE": ("DEVICE_FAILURE", "RETRY"),
    "DEVICE_DISCONNECTED": ("DEVICE_FAILURE", "RETRY"),
    "APPIUM_SESSION_FAILURE": ("APPIUM_FAILURE", "RETRY"),
    "APPIUM_SERVER_FAILURE": ("APPIUM_FAILURE", "RETRY"),
    "UNSUPPORTED_CAPABILITY": ("TEST_DEFECT", "HUMAN_REVIEW"),
    "EVIDENCE_FAILURE": ("ENVIRONMENT_FAILURE", "HUMAN_REVIEW"),
    "UNKNOWN": ("UNKNOWN", "HUMAN_REVIEW"),
}


def classify(error_code: Optional[str]) -> dict:
    category, recommended = _RULES.get(error_code or "UNKNOWN", _RULES["UNKNOWN"])
    confidence = 0.9 if error_code in _RULES else 0.3
    return {
        "category": category,
        "error_code": error_code or "UNKNOWN",
        "recommended_action": recommended,
        "confidence": confidence,
        "rationale": f"Deterministic rule match on error_code='{error_code}'." if error_code in _RULES
                     else "No deterministic rule matched — flagged for human review rather than guessing.",
    }


def classify_and_record(
    db: Session, execution_id: int, step_index: Optional[int], message: Optional[str],
    error_code: Optional[str], evidence_refs: Optional[list] = None,
) -> MobileFailure:
    result = classify(error_code)
    row = MobileFailure(
        execution_id=execution_id,
        step_index=step_index,
        category=result["category"],
        error_code=result["error_code"],
        message=message,
        confidence=result["confidence"],
        rationale=result["rationale"],
        recommended_action=result["recommended_action"],
        evidence_refs=evidence_refs or [],
        created_at=datetime.datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
