"""
Browser event tracking for console and network errors.

Enhanced with error classification and warning system.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from playwright.async_api import ConsoleMessage, Request

from execution.error_classifier import (
    ErrorCategory,
    ErrorSeverity,
    Warning,
    classify_console_error,
    classify_network_failure,
    map_to_error_type,
)
from models.schemas import ErrorType
from utils.logger import RunLogger


class BrowserEventTracker:
    """Tracks browser console and request failure events for a single run."""

    _FAILURE_PATTERNS = [
        "ERR_NAME_NOT_RESOLVED",
        "Failed to load resource",
        "404",
        "500",
        "502",
        "503",
        "504",
    ]
    _HTTP_STATUS_RE = re.compile(r"\b(?:4\d{2}|5\d{2})\b")

    def __init__(self, run_logger: RunLogger, fail_on_console_error: bool = True) -> None:
        self._run_logger = run_logger
        self.fail_on_console_error = fail_on_console_error
        self.console_events: List[str] = []
        self.console_errors: List[Dict] = []
        self.network_errors: List[Dict] = []
        self.warnings: List[Warning] = []

    def handle_console(self, message: ConsoleMessage) -> None:
        text = message.text or ""
        event = f"{message.type}: {text}"
        self.console_events.append(event)

        if message.type == "error":
            severity = classify_console_error(text)
            error_type = map_to_error_type(severity, ErrorCategory.CONSOLE)

            error_dict = {
                "type": error_type.value,
                "message": text,
                "severity": severity,
            }
            self.console_errors.append(error_dict)

            if severity == ErrorSeverity.CRITICAL:
                self._run_logger.error(f"[browser:console] CRITICAL {event}")
            elif severity == ErrorSeverity.NON_CRITICAL:
                warning = Warning(
                    error_type=error_type,
                    message=f"Console error: {text}",
                )
                self.warnings.append(warning)
                self._run_logger.warning(f"[browser:console] NON-CRITICAL {event}")
            else:
                self._run_logger.warning(f"[browser:console] UNKNOWN {event}")
        else:
            self._run_logger.debug(f"[browser:console] {event}")

    def handle_page_error(self, error: Any) -> None:
        event = f"pageerror: {error}"
        self.console_events.append(event)
        self._run_logger.error(f"[browser:pageerror] {error}")

        # Page errors are typically critical
        error_dict = {
            "type": ErrorType.CONSOLE_CRITICAL_ERROR.value,
            "message": str(error),
            "severity": ErrorSeverity.CRITICAL,
        }
        self.console_errors.append(error_dict)

    def handle_request_failed(self, request: Request) -> None:
        failure = request.failure
        if failure is None:
            detail = "unknown reason"
        elif hasattr(failure, "error_text"):
            detail = failure.error_text
        else:
            detail = str(failure)

        resource_type = getattr(request, "resource_type", "other")
        url = request.url

        severity = classify_network_failure(
            url=url,
            resource_type=resource_type,
            failure_reason=detail,
        )
        error_type = map_to_error_type(severity, ErrorCategory.NETWORK)

        error_dict = {
            "type": error_type.value,
            "message": detail,
            "url": url,
            "resource_type": resource_type,
            "severity": severity,
        }
        self.network_errors.append(error_dict)

        event = f"{request.method} {request.url} failed: {detail}"
        if severity == ErrorSeverity.CRITICAL:
            self._run_logger.error(f"[browser:request] CRITICAL {event}")
        elif severity == ErrorSeverity.NON_CRITICAL:
            warning = Warning(
                error_type=error_type,
                message=f"Network failure: {detail}",
                url=url,
                resource_type=resource_type,
            )
            self.warnings.append(warning)
            self._run_logger.warning(f"[browser:request] NON-CRITICAL {event}")
        else:
            self._run_logger.warning(f"[browser:request] UNKNOWN {event}")

    def _is_failure_console_message(self, text: str) -> bool:
        if any(pattern in text for pattern in self._FAILURE_PATTERNS):
            return True
        return bool(self._HTTP_STATUS_RE.search(text))

    def get_failure(self) -> Optional[Dict[str, str]]:
        # Return the first critical error for backward compatibility
        for error in self.console_errors:
            if error["severity"] == ErrorSeverity.CRITICAL:
                return {
                    "error_type": error["type"],
                    "message": f"Browser console error: {error['message']}",
                }

        for error in self.network_errors:
            if error["severity"] == ErrorSeverity.CRITICAL:
                return {
                    "error_type": error["type"],
                    "message": f"Browser network error: {error['message']}",
                }

        return None

    def get_warnings(self) -> List[Dict]:
        return [w.to_dict() for w in self.warnings]

    def get_console_errors(self) -> List[Dict]:
        return self.console_errors

    def get_network_errors(self) -> List[Dict]:
        return self.network_errors

    def reset(self) -> None:
        self.console_events.clear()
        self.console_errors.clear()
        self.network_errors.clear()
        self.warnings.clear()
