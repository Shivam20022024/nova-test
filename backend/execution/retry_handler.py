from __future__ import annotations

from typing import Optional

from execution.actions import ActionError
from models.schemas import ErrorType, TestStep


TRANSIENT_ERROR_TYPES = {
    ErrorType.TIMEOUT_ERROR,
    ErrorType.ELEMENT_NOT_FOUND,
}


def resolve_step_retries(step: TestStep, default_retries: int) -> int:
    if step.retries is not None:
        return step.retries
    return default_retries


def is_transient_failure(error: ActionError) -> bool:
    normalized = str(error).lower()
    if "semantic mismatch" in normalized or "action mismatch" in normalized:
        return False
    if "selector pre-validation failed" in normalized:
        return False

    if getattr(error, "error_type", None) in TRANSIENT_ERROR_TYPES:
        return True

    if "timeout" in normalized:
        return True
    if "not found" in normalized:
        return True
    if "detached" in normalized:
        return True
    if "no node" in normalized:
        return True
    return False
