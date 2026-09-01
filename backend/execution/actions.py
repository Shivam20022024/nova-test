"""
Action handlers for the Playwright execution engine.

Each public async function corresponds to a supported ActionType.
All handlers share the same signature:

    async def handle_<action>(
        page: Page,
        step: TestStep,
        logger: RunLogger,
        timeout: int,
    ) -> None:

They raise ActionError on failure so the runner can decide
whether to retry or abort the run.
"""
from __future__ import annotations

import inspect
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse, urlunparse

from playwright.async_api import Page, TimeoutError as PWTimeout

from execution.executor_patch import execute_with_self_healing
from execution.self_healing import validate_selector
from models.schemas import ActionType, ErrorType, TestStep
from utils.logger import RunLogger, get_logger

logger = get_logger("actions")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_BASE_DIR = Path(__file__).resolve().parent.parent
SCREENSHOTS_DIR = _BASE_DIR / "storage" / "screenshots"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class ActionError(Exception):
    """Raised when a test action fails after all retries are exhausted."""

    def __init__(self, message: str, error_type: ErrorType = ErrorType.UNKNOWN_ERROR) -> None:
        super().__init__(message)
        self.error_type = error_type


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_url(base_url: str, url: str) -> str:
    """Join base_url with a relative or absolute URL."""
    if url.startswith(("http://", "https://")):
        return url
    return base_url.rstrip("/") + "/" + url.lstrip("/")


def _get_base_domain(netloc: str) -> str:
    netloc = netloc.split(':')[0].lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return netloc


def _normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, path, "", parsed.query, ""))


def _url_matches(expected: str, actual: str) -> bool:
    normalized_expected = _normalize_url(expected)
    normalized_actual = _normalize_url(actual)
    if normalized_actual == normalized_expected:
        return True
    if normalized_actual.startswith(normalized_expected + "?"):
        return True
    if normalized_actual.startswith(normalized_expected + "#"):
        return True
    return False


def _screenshot_path(prefix: str) -> Path:
    ts = int(time.time() * 1000)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in prefix)
    return SCREENSHOTS_DIR / f"{safe}_{ts}.png"



def _safe_name(value: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (value or "").strip())
    return safe or "unknown"


def build_structured_screenshot_path(
    suite_id: Optional[str],
    test_name: Optional[str],
    filename: Optional[str],
) -> Path:
    safe_suite = _safe_name(suite_id or "standalone")
    safe_test = _safe_name(test_name or "test_case")
    raw_filename = (filename or "shot").strip()
    
    if safe_test not in raw_filename:
        raw_filename = f"{safe_test}_{raw_filename}"
        
    safe_filename = "".join(c if c.isalnum() or c in "-_." else "_" for c in raw_filename) or "shot"
    if not safe_filename.lower().endswith(".png"):
        safe_filename = f"{safe_filename}.png"
        
    target_dir = SCREENSHOTS_DIR / f"run_{safe_suite}"
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir / safe_filename


def to_storage_url(path: Path) -> Optional[str]:
    try:
        rel = path.relative_to(_BASE_DIR).as_posix()
        return f"/{rel}"
    except Exception:
        return None


async def _stabilize_page(page: Page, timeout: int, run_logger: RunLogger) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=min(timeout, 15000))
    except Exception:
        run_logger.warning("[WAIT] domcontentloaded did not complete within timeout")
    try:
        await page.wait_for_load_state("networkidle", timeout=min(timeout, 8000))
    except Exception:
        run_logger.warning("[WAIT] networkidle did not complete within timeout")


async def _locator_state(locator: Any) -> Dict[str, Any]:
    count = await locator.count()
    first = locator.first
    visible = False
    enabled = None
    editable = None
    if count > 0:
        try:
            visible = await first.is_visible()
        except Exception:
            visible = False
        try:
            enabled = await first.is_enabled()
        except Exception:
            enabled = None
        try:
            editable = await first.is_editable()
        except Exception:
            editable = None
    return {
        "count": count,
        "unique": count == 1,
        "visible": visible,
        "enabled": enabled,
        "editable": editable,
    }
def _classify_action_error(exc: Exception) -> ErrorType:
    message = str(exc).lower()
    if "wait_for_function" in message:
        return ErrorType.EXECUTION_ERROR
    if "timeout" in message or isinstance(exc, PWTimeout):
        return ErrorType.TIMEOUT_ERROR
    if "not found" in message or "no node" in message or "detached" in message:
        return ErrorType.ELEMENT_NOT_FOUND
    return ErrorType.EXECUTION_ERROR


async def capture_compressed_dom(page: Page, run_logger: RunLogger) -> list[dict]:
    """
    Capture and compress the current DOM, returning only interactive elements.
    Returns a list of element dictionaries with relevant attributes for test generation.
    """
    try:
        # JavaScript to extract interactive elements
        dom_script = """
        () => {
            const elements = [];
            const selectors = [
                'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
                'input[type="submit"]',
                'input[type="button"]',
                'button',
                'select',
                'textarea',
                '[role="button"]',
                '[role="textbox"]',
                '[role="link"]',
                'a[href]',
                '[data-testid]',
                '[aria-label]',
                '[onclick]',
                '.btn',
                '.button',
                '[class*="btn"]',
                '[class*="button"]'
            ];

            selectors.forEach(selector => {
                try {
                    const found = document.querySelectorAll(selector);
                    found.forEach(el => {
                        // Skip if already captured
                        if (elements.some(e => e.element === el)) return;

                        // Check if element is visible
                        const rect = el.getBoundingClientRect();
                        const isVisible = rect.width > 0 && rect.height > 0 &&
                                        el.offsetParent !== null &&
                                        !el.hidden &&
                                        window.getComputedStyle(el).display !== 'none' &&
                                        window.getComputedStyle(el).visibility !== 'hidden';

                        if (!isVisible) return;

                        const elementData = {
                            tag: el.tagName.toLowerCase(),
                            id: el.id || null,
                            name: el.name || null,
                            'data-testid': el.getAttribute('data-testid') || null,
                            'aria-label': el.getAttribute('aria-label') || null,
                            role: el.getAttribute('role') || null,
                            type: el.type || null,
                            placeholder: el.placeholder || null,
                            text: el.textContent?.trim().substring(0, 50) || null, // Limit text length
                            class: el.className || null,
                            href: el.href || null,
                            value: el.value || null
                        };

                        // Remove null values
                        Object.keys(elementData).forEach(key => {
                            if (elementData[key] === null || elementData[key] === '') {
                                delete elementData[key];
                            }
                        });

                        elements.push(elementData);
                    });
                } catch (e) {
                    // Skip problematic selectors
                }
            });

            return elements.slice(0, 50); // Limit to 50 elements to avoid overwhelming
        }
        """

        compressed_dom = await page.evaluate(dom_script)
        run_logger.info(f"DOM captured: {len(compressed_dom)} interactive elements found")

        # Log a sample for debugging
        if compressed_dom:
            sample = compressed_dom[0]
            run_logger.info(f"DOM sample: {sample}")

        return compressed_dom

    except Exception as exc:
        run_logger.warning(f"DOM capture failed: {exc}")
        return []


async def capture_screenshot(
    page: Page,
    prefix: str,
    run_logger: RunLogger,
    suite_id: Optional[str] = None,
    test_name: Optional[str] = None,
    filename: Optional[str] = None,
    full_page: bool = True,
) -> Optional[str]:
    """
    Capture a screenshot and return the storage URL or None on repeated failure.
    Retries once and validates file existence to avoid silent skips.
    """
    path = build_structured_screenshot_path(suite_id, test_name, filename) if filename else _screenshot_path(prefix)
    min_useful_bytes = 12000
    for attempt in range(1, 3):
        try:
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=5000)
                await page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                run_logger.warning("[SCREENSHOT] stabilization wait timed out; capturing current frame")

            await page.screenshot(path=str(path), full_page=full_page)
            exists = path.exists()
            size = path.stat().st_size if exists else 0
            current_url = page.url
            try:
                title = await page.title()
            except Exception:
                title = ""
            try:
                body_text = await page.evaluate("() => document.body ? (document.body.innerText || '').trim() : ''")
            except Exception:
                body_text = ""
            run_logger.info(
                f"[SCREENSHOT] captured attempt={attempt} path={path} exists={exists} size={size} "
                f"url={current_url} title='{title}' body_text_len={len(body_text)} ts={datetime.now(timezone.utc).isoformat()}"
            )

            if exists and size < min_useful_bytes:
                run_logger.warning(f"[SCREENSHOT] low-byte image ({size}) detected; trying viewport/body fallback.")
                try:
                    await page.screenshot(path=str(path), full_page=False)
                    size = path.stat().st_size if path.exists() else 0
                except Exception as viewport_exc:  # noqa: BLE001
                    run_logger.warning(f"[SCREENSHOT] viewport fallback failed: {viewport_exc}")
                if size < min_useful_bytes:
                    try:
                        body = page.locator("body")
                        if await body.count() > 0:
                            await body.screenshot(path=str(path))
                            size = path.stat().st_size if path.exists() else 0
                    except Exception as body_exc:  # noqa: BLE001
                        run_logger.warning(f"[SCREENSHOT] body fallback failed: {body_exc}")

            if exists and size > 0:
                url = to_storage_url(path)
                return url or str(path)
            run_logger.error(f"[SCREENSHOT] file validation failed path={path} attempt={attempt}")
        except Exception as exc:  # noqa: BLE001
            run_logger.error(f"[SCREENSHOT] capture failed attempt={attempt} path={path} error={exc}")
    return None


# ---------------------------------------------------------------------------
# Individual action handlers
# ---------------------------------------------------------------------------
async def handle_goto(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    """Navigate to a URL (absolute or relative to base_url)."""
    # If no URL is provided, default to the root of the base_url
    target_url = step.url if step.url else "/"
    
    target = _resolve_url(base_url, target_url)
    run_logger.info(f"goto → {target}")
    try:
        await _stabilize_page(page, timeout, run_logger)
        response = await page.goto(
            target,
            wait_until="domcontentloaded",
            timeout=timeout,
        )
        await _stabilize_page(page, timeout, run_logger)
        if response and not response.ok:
            raise ActionError(
                f"goto received HTTP {response.status} for {target}",
                error_type=ErrorType.NAVIGATION_ERROR,
            )
        if not _url_matches(target, page.url):
            expected_parsed = urlparse(target)
            actual_parsed = urlparse(page.url)
            if expected_parsed.netloc and expected_parsed.netloc == actual_parsed.netloc:
                run_logger.warning(
                    f"goto redirected within same origin: expected='{target}', actual='{page.url}'"
                )
            else:
                raise ActionError(
                    f"goto navigation ended at '{page.url}', expected '{target}'",
                    error_type=ErrorType.NAVIGATION_ERROR,
                )
    except PWTimeout as exc:
        raise ActionError(
            f"goto timed out after {timeout}ms: {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except ActionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ActionError(f"goto failed: {exc}", error_type=ErrorType.NAVIGATION_ERROR) from exc


async def handle_fill(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    """Clear and fill a form element."""
    if not step.selector:
        raise ActionError("'fill' action requires a 'selector' field", error_type=ErrorType.INVALID_INPUT)
    if step.value is None:
        raise ActionError("'fill' action requires a 'value' field", error_type=ErrorType.INVALID_INPUT)

    run_logger.info(f"fill WAITING for element '{step.selector}'")
    try:
        locator = page.locator(step.selector)
        await _stabilize_page(page, timeout, run_logger)
        await locator.wait_for(state="visible", timeout=timeout)
        if not await locator.first.is_editable():
            raise ActionError(
                f"fill target '{step.selector}' is not editable",
                error_type=ErrorType.ELEMENT_NOT_FOUND,
            )
        run_logger.info(f"fill ELEMENT VISIBLE '{step.selector}'")
        await locator.fill(step.value, timeout=timeout)
        run_logger.info(f"fill SUCCESS '{step.selector}'")
    except PWTimeout as exc:
        raise ActionError(
            f"fill timed out waiting for '{step.selector}': {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise ActionError(
            f"fill failed on '{step.selector}': {exc}",
            error_type=ErrorType.ELEMENT_NOT_FOUND,
        ) from exc


async def handle_click(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    """Click an element, waiting for it to be visible and ready."""
    if not step.selector:
        raise ActionError("'click' action requires a 'selector' field", error_type=ErrorType.INVALID_INPUT)

    run_logger.info("DEBUG: NEW CLICK HANDLER CALLED")
    caller = inspect.stack()[1]
    run_logger.info(
        f"DEBUG: Called from {caller.function} "
        f"({caller.filename}:{caller.lineno})"
    )
    print(
        f"DEBUG: NEW CLICK HANDLER CALLED from {caller.function} "
        f"({caller.filename}:{caller.lineno})"
    )
    action_timeout = min(timeout, 8000)
    run_logger.info(f"click WAITING for element '{step.selector}'")
    locator = page.locator(step.selector)
    first = locator.first

    try:
        await _stabilize_page(page, action_timeout, run_logger)
        # Use first match to avoid strict-mode failures for broad selectors.
        await first.wait_for(state="visible", timeout=action_timeout)
        run_logger.info(f"click ELEMENT VISIBLE '{step.selector}'")
        await first.scroll_into_view_if_needed(timeout=action_timeout)
        run_logger.info(f"click ELEMENT READY '{step.selector}'")
        if not await first.is_enabled():
            raise ActionError(
                f"click target '{step.selector}' is not enabled",
                error_type=ErrorType.ELEMENT_NOT_FOUND,
            )

        await first.click(timeout=action_timeout)
        await _stabilize_page(page, action_timeout, run_logger)
        run_logger.info(f"click SUCCESS '{step.selector}'")

    except PWTimeout as exc:
        raise ActionError(
            f"click timed out waiting for '{step.selector}': {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except ActionError:
        raise
    except Exception as exc:  # noqa: BLE001
        error_type = _classify_action_error(exc)
        run_logger.error(f"DEBUG: handle_click exception type={type(exc).__name__} message={exc}")
        raise ActionError(
            f"click failed on '{step.selector}': {exc}",
            error_type=error_type,
        ) from exc


async def handle_wait_for(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    """
    Wait for a selector to appear in the DOM.
    If no selector is given, waits for 'networkidle'.
    """
    effective_timeout = step.timeout if step.timeout is not None else timeout

    if step.selector:
        run_logger.info(
            f"wait_for → selector='{step.selector}' timeout={effective_timeout}ms"
        )
        try:
            locator = page.locator(step.selector)
            await locator.wait_for(state="visible", timeout=effective_timeout)
        except PWTimeout as exc:
            raise ActionError(
                f"wait_for timed out ({effective_timeout}ms) for '{step.selector}': {exc}",
                error_type=ErrorType.TIMEOUT_ERROR,
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ActionError(
                f"wait_for failed on '{step.selector}': {exc}",
                error_type=ErrorType.ELEMENT_NOT_FOUND,
            ) from exc
    else:
        run_logger.info(
            f"wait_for → networkidle timeout={effective_timeout}ms"
        )
        try:
            await page.wait_for_load_state("networkidle", timeout=effective_timeout)
        except PWTimeout as exc:
            raise ActionError(
                f"wait_for networkidle timed out ({effective_timeout}ms): {exc}",
                error_type=ErrorType.TIMEOUT_ERROR,
            ) from exc


async def handle_assert_visible(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> Optional[dict]:
    """Assert that an element is visible on the page."""
    if not step.selector:
        raise ActionError("'assert_visible' action requires a 'selector' field", error_type=ErrorType.INVALID_INPUT)

    selector = step.selector
    action_timeout = min(timeout, 8000)
    run_logger.info(f"assert_visible WAITING for selector='{selector}'")
    try:
        locator = page.locator(selector)
        await _stabilize_page(page, action_timeout, run_logger)
        # Use first match to avoid strict-mode violations on pages with duplicate ids/selectors.
        await locator.first.wait_for(state="visible", timeout=action_timeout)
        run_logger.info(f"assert_visible ELEMENT VISIBLE '{selector}'")
        if not await locator.first.is_visible():
            raise ActionError(
                f"assert_visible failed: '{selector}' is not visible",
                error_type=ErrorType.ASSERTION_FAILURE,
            )
        return None
    except PWTimeout as exc:
        raise ActionError(
            f"assert_visible timed out ({action_timeout}ms) for '{selector}': {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise ActionError(
            f"assert_visible failed on '{selector}': {exc}",
            error_type=ErrorType.ASSERTION_FAILURE,
        ) from exc


async def handle_assert_text(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    if not step.selector:
        raise ActionError("'assert_text' action requires a 'selector' field", error_type=ErrorType.INVALID_INPUT)
    if step.value is None:
        raise ActionError("'assert_text' action requires a 'value' field", error_type=ErrorType.INVALID_INPUT)

    run_logger.info(
        f"assert_text WAITING for selector='{step.selector}' expected='{step.value}'"
    )
    try:
        locator = page.locator(step.selector)
        await _stabilize_page(page, timeout, run_logger)
        await locator.wait_for(state="visible", timeout=timeout)
        text_value = await locator.text_content()
        text = (text_value or "").strip()
        if step.value.strip() not in text:
            raise ActionError(
                f"assert_text failed: expected '{step.value}' not found in '{text}'",
                error_type=ErrorType.ASSERTION_FAILURE,
            )
        run_logger.info(f"assert_text SUCCESS '{step.selector}'")
    except PWTimeout as exc:
        raise ActionError(
            f"assert_text timed out ({timeout}ms) for '{step.selector}': {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except ActionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ActionError(
            f"assert_text errored on '{step.selector}': {exc}",
            error_type=ErrorType.ASSERTION_FAILURE,
        ) from exc


async def handle_assert_url(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    if step.value is None:
        raise ActionError("'assert_url' action requires a 'value' field", error_type=ErrorType.INVALID_INPUT)

    expected_url = _resolve_url(base_url, step.value)
    run_logger.info(f"assert_url → expected='{expected_url}'")
    try:
        await _stabilize_page(page, timeout, run_logger)
        actual_url = page.url
        if not _url_matches(expected_url, actual_url):
            raise ActionError(
                f"assert_url failed: expected '{expected_url}', got '{actual_url}'",
                error_type=ErrorType.ASSERTION_FAILURE,
            )
    except PWTimeout as exc:
        raise ActionError(
            f"assert_url timed out ({timeout}ms) while waiting for navigation: {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except ActionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ActionError(
            f"assert_url errored: {exc}",
            error_type=ErrorType.ASSERTION_FAILURE,
        ) from exc


async def handle_assert_count(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> None:
    if not step.selector:
        raise ActionError("'assert_count' action requires a 'selector' field", error_type=ErrorType.INVALID_INPUT)
    if step.value is None:
        raise ActionError("'assert_count' action requires a 'value' field", error_type=ErrorType.INVALID_INPUT)

    try:
        expected_count = int(step.value)
    except ValueError as exc:
        raise ActionError(
            f"assert_count value must be an integer: {step.value}",
            error_type=ErrorType.INVALID_INPUT,
        ) from exc

    run_logger.info(
        f"assert_count → selector='{step.selector}' expected={expected_count}"
    )

    try:
        locator = page.locator(step.selector)
        await _stabilize_page(page, timeout, run_logger)
        if expected_count > 0:
            await locator.first.wait_for(state="attached", timeout=timeout)
        actual_count = await locator.count()
        if actual_count != expected_count:
            raise ActionError(
                f"assert_count failed: expected {expected_count}, found {actual_count}",
                error_type=ErrorType.ASSERTION_FAILURE,
            )
    except PWTimeout as exc:
        raise ActionError(
            f"assert_count timed out ({timeout}ms) for '{step.selector}': {exc}",
            error_type=ErrorType.TIMEOUT_ERROR,
        ) from exc
    except ActionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ActionError(
            f"assert_count errored on '{step.selector}': {exc}",
            error_type=ErrorType.ASSERTION_FAILURE,
        ) from exc


async def handle_screenshot(
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
) -> Optional[str]:
    """
    Explicitly capture a screenshot. Returns the path.
    This action always succeeds (best-effort).
    """
    prefix = step.name or "manual"
    run_logger.info(f"screenshot → prefix='{prefix}'")
    return await capture_screenshot(page, prefix, run_logger)


# ---------------------------------------------------------------------------
# Dispatch table  (ActionType → handler)
# ---------------------------------------------------------------------------

ACTION_HANDLERS = {
    ActionType.GOTO: handle_goto,
    ActionType.FILL: handle_fill,
    ActionType.CLICK: handle_click,
    ActionType.WAIT_FOR: handle_wait_for,
    ActionType.ASSERT_VISIBLE: handle_assert_visible,
    ActionType.ASSERT_TEXT: handle_assert_text,
    ActionType.ASSERT_URL: handle_assert_url,
    ActionType.ASSERT_COUNT: handle_assert_count,
    ActionType.SCREENSHOT: handle_screenshot,
}
ACTION_MAP = ACTION_HANDLERS

# Prevent future misuse of Playwright wait_for_function for normal action handlers.
for handler in ACTION_MAP.values():
    try:
        src = inspect.getsource(handler)
    except (OSError, TypeError):
        continue
    if "wait_for_function" in src:
        raise RuntimeError(
            f"Invalid API usage detected in action handler: {handler.__name__}"
        )


async def dispatch(
    action: ActionType,
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
    ignore_memory: bool = False,
) -> dict:
    """
    Dispatch a single step to its handler with self-healing capabilities.
    Returns a payload with action result and healing metadata.
    Raises ActionError on unrecoverable failure.
    """
    handler = ACTION_MAP.get(action)
    if handler is None:
        raise ActionError(f"Unknown action '{action}'", error_type=ErrorType.INVALID_INPUT)

    requested_domain = _get_base_domain(urlparse(base_url).netloc)
    
    if action == ActionType.GOTO:
        target_url = step.url if step.url else "/"
        target = _resolve_url(base_url, target_url)
        target_domain = _get_base_domain(urlparse(target).netloc)
        if target_domain and target_domain != requested_domain and not target_domain.endswith("." + requested_domain) and not requested_domain.endswith("." + target_domain):
            run_logger.error(f"URL mismatch: requested domain {requested_domain}, target domain {target_domain}")
            raise ActionError(f"URL mismatch: requested domain {requested_domain}, target domain {target_domain}", error_type=ErrorType.INVALID_INPUT)
    else:
        current_url = page.url
        if current_url and current_url != "about:blank":
            current_domain = _get_base_domain(urlparse(current_url).netloc)
            if current_domain and current_domain != requested_domain and not current_domain.endswith("." + requested_domain) and not requested_domain.endswith("." + current_domain):
                run_logger.error(f"URL mismatch: requested domain {requested_domain}, current domain {current_domain}")
                raise ActionError(f"URL mismatch: requested domain {requested_domain}, current domain {current_domain}", error_type=ErrorType.INVALID_INPUT)

    if hasattr(step, "confidence") and step.confidence is not None:
        confidence_level = "high" if step.confidence >= 0.8 else "medium" if step.confidence >= 0.6 else "low"
        run_logger.info(
            f"Selector confidence: {step.confidence:.2f} ({confidence_level}) - {getattr(step, 'selector', 'N/A')}"
        )

    pre_healing = {
        "healed": False,
        "memory_used": False,
        "original_selector": None,
        "new_selector": None,
        "selector_score_original": None,
        "selector_score_new": None,
        "from_memory": False,
    }
    if action in {ActionType.FILL, ActionType.CLICK, ActionType.ASSERT_VISIBLE, ActionType.ASSERT_TEXT, ActionType.ASSERT_COUNT} and step.selector:
        pre_healing = await _validate_action_preconditions(
            action,
            page,
            step,
            base_url,
            run_logger,
            timeout,
            ignore_memory=ignore_memory,
        )

    result, healing = await execute_with_self_healing(
        action=action,
        handler=handler,
        page=page,
        step=step,
        base_url=base_url,
        run_logger=run_logger,
        timeout=timeout,
        action_error_cls=ActionError,
        skip_self_heal=bool(pre_healing.get("from_memory")),
    )
    final_healing = healing
    if (pre_healing.get("healed") or pre_healing.get("from_memory")) and not healing.get("healed"):
        final_healing = pre_healing
    else:
        merged_attempts = list(pre_healing.get("recovery_attempts", [])) + list(healing.get("recovery_attempts", []))
        if merged_attempts:
            final_healing["recovery_attempts"] = merged_attempts
        for key in ("selector_validated", "selector_visible", "selector_enabled", "selector_unique"):
            if final_healing.get(key) is None:
                final_healing[key] = pre_healing.get(key)

    return {
        "result": result,
        "healing": final_healing,
    }


async def _validate_action_preconditions(
    action: ActionType,
    page: Page,
    step: TestStep,
    base_url: str,
    run_logger: RunLogger,
    timeout: int,
    ignore_memory: bool = False,
) -> dict:
    """
    Validate preconditions before executing an action that uses a selector.
    Checks if the selector exists and the element is in the expected state.
    """
    selector = step.selector
    healing = {
        "healed": False,
        "memory_used": False,
        "original_selector": None,
        "new_selector": None,
        "selector_score_original": None,
        "selector_score_new": None,
        "from_memory": False,
        "recovery_attempts": [],
        "selector_validated": False,
        "selector_visible": None,
        "selector_enabled": None,
        "selector_unique": None,
    }
    run_logger.info(f"Pre-validating selector '{selector}' for action '{action}'")

    try:
        validation = await validate_selector(
            page,
            selector,
            base_url,
            str(action.value),
            ignore_memory=ignore_memory,
        )
        validated_selector = validation["selector"]
        if validated_selector != selector:
            step.selector = validated_selector
            selector = validated_selector
            if validation.get("used_memory"):
                healing = {
                    "healed": False,
                    "memory_used": True,
                    "original_selector": validation.get("original_selector"),
                    "new_selector": validation.get("new_selector"),
                    "selector_score_original": validation.get("selector_score_original"),
                    "selector_score_new": validation.get("selector_score_new"),
                    "from_memory": True,
                    "recovery_attempts": validation.get("recovery_attempts", []),
                    "selector_validated": False,
                    "selector_visible": None,
                    "selector_enabled": None,
                    "selector_unique": None,
                }
                run_logger.info("[MEMORY] Found cached selector")
                run_logger.info(f"[MEMORY] original={validation.get('original_selector')}")
                run_logger.info(f"[MEMORY] reused={validation.get('new_selector')}")
                run_logger.info("[MEMORY] substitution_applied=true")
            elif validation.get("healed"):
                healing = {
                    "healed": True,
                    "memory_used": False,
                    "original_selector": validation.get("original_selector"),
                    "new_selector": validation.get("new_selector"),
                    "selector_score_original": validation.get("selector_score_original"),
                    "selector_score_new": validation.get("selector_score_new"),
                    "from_memory": False,
                    "recovery_attempts": validation.get("recovery_attempts", []),
                    "selector_validated": False,
                    "selector_visible": None,
                    "selector_enabled": None,
                    "selector_unique": None,
                }
                run_logger.info(f"[SELF-HEAL] original={validation.get('original_selector')}")
                run_logger.info(f"[SELF-HEAL] new={validation.get('new_selector')}")

        locator = page.locator(selector)

        state = await _locator_state(locator)
        healing["selector_unique"] = state["unique"]
        healing["selector_visible"] = state["visible"]
        healing["selector_enabled"] = state["enabled"]
        if state["count"] == 0:
            raise ActionError(
                f"Selector '{selector}' not found in DOM",
                error_type=ErrorType.ELEMENT_NOT_FOUND,
            )

        if action in {ActionType.CLICK, ActionType.FILL, ActionType.ASSERT_VISIBLE}:
            if not state["visible"]:
                raise ActionError(
                    f"Selector '{selector}' found ({state['count']} elements) but none are visible",
                    error_type=ErrorType.ELEMENT_NOT_FOUND,
                )
            if action in {ActionType.CLICK, ActionType.FILL} and state["enabled"] is False:
                raise ActionError(
                    f"Selector '{selector}' is visible but disabled",
                    error_type=ErrorType.ELEMENT_NOT_FOUND,
                )
            healing["selector_validated"] = True
            run_logger.info(
                f"Selector validation passed: count={state['count']} visible={state['visible']} enabled={state['enabled']} unique={state['unique']}"
            )

        elif action in {ActionType.ASSERT_TEXT, ActionType.ASSERT_COUNT}:
            healing["selector_validated"] = True
            run_logger.info(f"Selector validation passed: count={state['count']} unique={state['unique']}")

    except ActionError:
        raise
    except Exception as exc:
        run_logger.warning(f"Selector pre-validation failed: {exc}")
        raise ActionError(
            f"Selector pre-validation failed for '{selector}' on '{action.value}': {exc}",
            error_type=ErrorType.ELEMENT_NOT_FOUND,
        ) from exc
    return healing





