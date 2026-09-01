"""
Execution patch to apply selector self-healing retry.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional, Tuple

from execution.self_healing import remember_selector_mapping
from models.schemas import ActionType, ErrorType
from self_healing.llm_healer import heal_selector_with_llm


def _is_selector_failure(action: ActionType, error: Exception) -> bool:
    error_type = getattr(error, "error_type", None)
    if error_type in {ErrorType.ELEMENT_NOT_FOUND, ErrorType.TIMEOUT_ERROR, ErrorType.ASSERTION_FAILURE}:
        return action in {
            ActionType.FILL,
            ActionType.CLICK,
            ActionType.ASSERT_TEXT,
            ActionType.ASSERT_COUNT,
        }
    return False


def _is_healable_exception(error: Exception) -> bool:
    message = str(error).lower()
    if "intercepts pointer events" in message:
        return False
    return (
        "selector not found" in message
        or "timeout waiting for selector" in message
        or "timed out waiting for" in message
        or "not found in dom" in message
    )


async def heal_selector(page: Any, failed_selector: str) -> Optional[str]:
    candidates = [
        "[data-testid='error']",
        ".error-message-container",
        "[role='alert']",
        "text=Epic sadface",
        "div.error-message-container",
    ]

    for candidate in candidates:
        if candidate == failed_selector:
            continue
        try:
            locator = page.locator(candidate)
            count = await locator.count()
            if count > 0:
                return candidate
        except Exception:
            continue

    llm_suggestion = await heal_selector_with_llm(
        {
            "page": page,
            "url": getattr(page, "url", ""),
            "action": "assert_visible",
            "failed_selector": failed_selector,
            "step_index": None,
            "previous_steps": [],
            "expected_intent": "recover selector for failed execution step",
        }
    )
    if llm_suggestion:
        return llm_suggestion
    return None


async def execute_with_self_healing(
    *,
    action: ActionType,
    handler: Callable[..., Any],
    page: Any,
    step: Any,
    base_url: str,
    run_logger: Any,
    timeout: int,
    action_error_cls: type[Exception],
    skip_self_heal: bool = False,
) -> Tuple[Optional[str], Dict[str, Any]]:
    """
    Execute action with one self-healing retry when selector fails.
    """
    original_selector = getattr(step, "selector", None)
    banned_heal_selectors = {"button", "div", "span", "a", "body", "#root", "#react-burger-menu-btn"}

    try:
        result = await handler(page, step, base_url, run_logger, timeout)
        if isinstance(result, dict) and result.get("healed") is True:
            return None, {
                "healed": True,
                "memory_used": False,
                "original_selector": result.get("original_selector"),
                "new_selector": result.get("new_selector"),
                "recovery_attempts": [{"strategy": "handler", "candidate": result.get("new_selector"), "success": True}],
            }
        return result, {
            "healed": False,
            "memory_used": False,
            "original_selector": None,
            "new_selector": None,
            "recovery_attempts": [],
        }
    except Exception as exc:  # noqa: BLE001
        if not isinstance(exc, action_error_cls):
            raise
        if skip_self_heal:
            raise
        if not original_selector or not _is_selector_failure(action, exc) or not _is_healable_exception(exc):
            raise
        if str(original_selector).strip().lower() in banned_heal_selectors:
            raise

        run_logger.warning(f"[SELF-HEAL] original={original_selector}")
        healed_selector = await heal_selector(page, str(original_selector))
        if not healed_selector:
            run_logger.warning("[SELF-HEAL] new=None")
            run_logger.warning("[SELF-HEAL] success=False")
            raise
        if str(healed_selector).strip().lower() in banned_heal_selectors:
            run_logger.warning("[SELF-HEAL] rejected generic healed selector")
            raise

        run_logger.info(f"[SELF-HEAL] new={healed_selector}")
        healed_step = step.model_copy()
        healed_step.selector = healed_selector

        try:
            result = await handler(page, healed_step, base_url, run_logger, timeout)
            remember_selector_mapping(
                base_url=base_url,
                action=str(action.value),
                original_selector=str(original_selector),
                healed_selector=str(healed_selector),
                confidence=1.0,
            )
            run_logger.info("[SELF-HEAL] success=True")
            return result, {
                "healed": True,
                "memory_used": False,
                "original_selector": original_selector,
                "new_selector": healed_selector,
                "recovery_attempts": [{"strategy": "executor_patch", "candidate": healed_selector, "success": True}],
            }
        except Exception:  # noqa: BLE001
            run_logger.warning("[SELF-HEAL] success=False")
            raise
