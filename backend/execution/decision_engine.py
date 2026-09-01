"""
Decision engine for determining test failure based on error classification.

Implements strict vs relaxed execution modes.
"""
from __future__ import annotations

from typing import List

from execution.error_classifier import ErrorSeverity
from models.schemas import RunConfig


def should_fail(
    critical_errors: List,
    non_critical_errors: List,
    config,
) -> bool:
    """
    Determine if the test should fail based on errors and configuration.

    Args:
        critical_errors: List of critical errors
        non_critical_errors: List of non-critical errors
        config: Test run configuration

    Returns:
        True if test should fail, False otherwise
    """
    strict_mode = getattr(config, 'strict_mode', False)

    if strict_mode:
        # In strict mode, any error fails the test
        return len(critical_errors) > 0 or len(non_critical_errors) > 0

    # In relaxed mode, only critical errors fail the test
    return len(critical_errors) > 0