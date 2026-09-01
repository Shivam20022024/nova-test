"""
Error classification system for the AI Test Execution Platform.

Classifies errors into critical vs non-critical categories to avoid false negatives
and provide meaningful failure analysis.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from models.schemas import ErrorType


# ---------------------------------------------------------------------------
# Error Categories
# ---------------------------------------------------------------------------

CRITICAL_ERRORS = [
    "ERR_NAME_NOT_RESOLVED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_TIMED_OUT",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_CONNECTION_RESET",
    "ERR_SSL_PROTOCOL_ERROR",
]

NON_CRITICAL_PATTERNS = [
    r"401",
    r"403",
    r"analytics",
    r"tracking",
    r"favicon\.ico",
    r"pixel",
    r"metrics",
    r"gtag",
    r"googletagmanager",
    r"doubleclick",
    r"facebook",
    r"twitter",
    r"linkedin",
    r"instagram",
    r"youtube",
    r"vimeo",
    r"soundcloud",
    r"spotify",
    r"ads",
    r"banner",
    r"widget",
    r"social",
    r"share",
    r"comment",
    r"embed",
]

RESOURCE_TYPE_WEIGHTS = {
    "document": "critical",
    "xhr": "critical",
    "fetch": "critical",
    "script": "non_critical",
    "image": "non_critical",
    "stylesheet": "non_critical",
    "font": "non_critical",
    "media": "non_critical",
    "websocket": "critical",
    "other": "non_critical",
}


# ---------------------------------------------------------------------------
# Classification Enums
# ---------------------------------------------------------------------------

class ErrorSeverity:
    CRITICAL = "critical"
    NON_CRITICAL = "non_critical"
    UNKNOWN = "unknown"


class ErrorCategory:
    NETWORK = "network"
    CONSOLE = "console"


# ---------------------------------------------------------------------------
# Classification Functions
# ---------------------------------------------------------------------------

def classify_console_error(message: str) -> ErrorSeverity:
    """
    Classify a console error message.

    Returns:
        ErrorSeverity.CRITICAL if the error indicates a serious issue
        ErrorSeverity.NON_CRITICAL if it's likely harmless (e.g., analytics)
        ErrorSeverity.UNKNOWN otherwise
    """
    if any(pattern in message for pattern in CRITICAL_ERRORS):
        return ErrorSeverity.CRITICAL

    if any(re.search(pattern, message, re.IGNORECASE) for pattern in NON_CRITICAL_PATTERNS):
        return ErrorSeverity.NON_CRITICAL

    return ErrorSeverity.UNKNOWN


def classify_network_failure(
    url: str,
    resource_type: str,
    status_code: Optional[int] = None,
    failure_reason: Optional[str] = None,
) -> ErrorSeverity:
    """
    Classify a network request failure.

    Args:
        url: The failed request URL
        resource_type: Playwright resource type (document, xhr, etc.)
        status_code: HTTP status code if available
        failure_reason: Failure reason string

    Returns:
        ErrorSeverity.CRITICAL if the failure affects core functionality
        ErrorSeverity.NON_CRITICAL if it's peripheral (images, scripts)
        ErrorSeverity.UNKNOWN otherwise
    """
    # Check failure reason first
    if failure_reason and any(pattern in failure_reason for pattern in CRITICAL_ERRORS):
        return ErrorSeverity.CRITICAL

    # Check resource type weight
    weight = RESOURCE_TYPE_WEIGHTS.get(resource_type, "non_critical")
    if weight == "critical":
        return ErrorSeverity.CRITICAL

    # Check status code for critical resources
    if status_code and status_code >= 400:
        if resource_type in ["document", "xhr", "fetch"]:
            return ErrorSeverity.CRITICAL

    # Check URL patterns for non-critical
    url_lower = url.lower()
    if any(re.search(pattern, url_lower) for pattern in NON_CRITICAL_PATTERNS):
        return ErrorSeverity.NON_CRITICAL

    return ErrorSeverity.UNKNOWN


# ---------------------------------------------------------------------------
# Error Type Mapping
# ---------------------------------------------------------------------------

def map_to_error_type(severity: ErrorSeverity, category: ErrorCategory) -> ErrorType:
    """Map severity and category to ErrorType enum."""
    if category == ErrorCategory.NETWORK:
        if severity == ErrorSeverity.CRITICAL:
            return ErrorType.NETWORK_CRITICAL_ERROR
        elif severity == ErrorSeverity.NON_CRITICAL:
            return ErrorType.NETWORK_NON_CRITICAL_ERROR
        else:
            return ErrorType.NETWORK_ERROR
    elif category == ErrorCategory.CONSOLE:
        if severity == ErrorSeverity.CRITICAL:
            return ErrorType.CONSOLE_CRITICAL_ERROR
        elif severity == ErrorSeverity.NON_CRITICAL:
            return ErrorType.CONSOLE_NON_CRITICAL_ERROR
        else:
            return ErrorType.CONSOLE_ERROR
    else:
        return ErrorType.UNKNOWN_ERROR


# ---------------------------------------------------------------------------
# Warning Structure
# ---------------------------------------------------------------------------

class Warning:
    """Represents a non-critical error that doesn't fail the test."""

    def __init__(
        self,
        error_type: ErrorType,
        message: str,
        url: Optional[str] = None,
        resource_type: Optional[str] = None,
        status_code: Optional[int] = None,
    ):
        self.error_type = error_type
        self.message = message
        self.url = url
        self.resource_type = resource_type
        self.status_code = status_code

    def to_dict(self) -> Dict:
        return {
            "type": self.error_type.value,
            "message": self.message,
            "url": self.url,
            "resource_type": self.resource_type,
            "status_code": self.status_code,
        }