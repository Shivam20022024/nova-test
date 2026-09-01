"""
HealingValidator — "finding an element is NOT sufficient proof of successful
healing" (rule 68). Validates a candidate locator resolves to a compatible,
usable element *before* it's used, and that the app is still alive *after*
the healed action runs.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from mobile.locators import ElementNotFoundError, get_current_package, resolve_element
from mobile.schemas import Locator


@dataclass
class ValidationResult:
    valid: bool
    reason: str


def validate_candidate_pre_execution(driver, candidate_locator: Locator, requires_interactive: bool) -> ValidationResult:
    try:
        element = resolve_element(driver, candidate_locator)
    except ElementNotFoundError:
        return ValidationResult(False, "Candidate locator no longer resolves against the live hierarchy.")

    if not element.is_displayed():
        return ValidationResult(False, "Candidate element is not visible.")

    if requires_interactive and not element.is_enabled():
        return ValidationResult(False, "Candidate element is not enabled.")

    return ValidationResult(True, "Candidate resolves to a visible, compatible element.")


def validate_post_execution(driver, expected_package: Optional[str]) -> ValidationResult:
    try:
        current_pkg = get_current_package(driver)
    except Exception as exc:
        return ValidationResult(False, f"Session unresponsive after healed action: {exc}")

    if expected_package and current_pkg and current_pkg != expected_package:
        return ValidationResult(False, f"App under test left foreground after healed action (now '{current_pkg}').")

    return ValidationResult(True, "App remained responsive and in the expected package after the healed action.")
