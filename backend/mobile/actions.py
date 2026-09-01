"""
ActionRegistry — extensible baseline Android action set (section 15/16).
Every executor takes (driver, step, ctx) and returns an ActionOutcome; new
actions register into ACTION_REGISTRY without touching the execution engine.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from mobile.locators import (
    ElementNotFoundError,
    get_current_activity,
    get_current_package,
    is_editable,
    parse_hierarchy,
    capture_hierarchy_xml,
    resolve_by_hint,
    resolve_element,
    tap_element,
    wait_for_element,
    wait_for_stable_content,
)
from mobile.schemas import TestStep


@dataclass
class ActionOutcome:
    status: str  # PASSED | FAILED
    actual: Optional[str] = None
    resolved_locator: Optional[Dict[str, Any]] = None
    element: Any = None
    error: Optional[str] = None
    error_code: Optional[str] = None


class ActionContext:
    """Per-step execution context passed to every action executor."""
    def __init__(self, expected_package: Optional[str] = None):
        self.expected_package = expected_package


def _require_locator(step: TestStep) -> None:
    if step.locator is None:
        raise ValueError(f"Action {step.action} requires a locator.")


def _expected_value(step: TestStep) -> Optional[str]:
    """The TestStep schema carries two candidate fields for an assertion's
    expected outcome: `expected` (semantically correct, and what the AI
    generator — following its own prompt — always populates for ASSERT_*
    steps) and `value` (used by TAP/ENTER_TEXT/etc. for their own purpose,
    but also historically read by some assert executors). Prefer `expected`
    when set so a correctly-authored assertion is never falsely reported as
    FAILED just because its expected value landed in the "other" field —
    this was a real, generic bug: every AI-generated ASSERT_TEXT/CHECKED/
    ACTIVITY step failed even when the app matched exactly, because the
    executor only ever looked at `value` (which the AI leaves null for
    assertions). Falls back to `value` for CSV/manually-built tests that
    use that field instead."""
    return step.expected if step.expected is not None else step.value


def _resolve(driver, step: TestStep, timeout_ms: Optional[int] = None, prefer_clickable: bool = False, want_role: str = "any"):
    _require_locator(step)
    try:
        return wait_for_element(
            driver, step.locator, timeout_ms=timeout_ms or step.timeout_ms,
            prefer_clickable=prefer_clickable, want_role=want_role,
        )
    except ElementNotFoundError:
        raise


# ── Application lifecycle ─────────────────────────────────────────────────

def _launch(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    package = step.value or ctx.expected_package
    driver.execute_script("mobile: activateApp", {"appId": package})
    # Don't return until the first screen has actually rendered real content —
    # a fixed 0.5s sleep is far too short for a React-Native/Flutter cold start
    # and is the direct cause of the next step running against an empty view
    # tree. Generic: waits on the UI, not the framework.
    wait_for_stable_content(driver, timeout_ms=min(step.timeout_ms * 2, 20000))
    return ActionOutcome(status="PASSED", actual=get_current_activity(driver))


def _terminate(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    package = step.value or ctx.expected_package
    driver.execute_script("mobile: terminateApp", {"appId": package})
    return ActionOutcome(status="PASSED")


def _reset_app(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    package = step.value or ctx.expected_package
    driver.execute_script("mobile: clearApp", {"appId": package})
    return ActionOutcome(status="PASSED")


def _back(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    driver.back()
    wait_for_stable_content(driver, timeout_ms=6000)
    return ActionOutcome(status="PASSED", actual=get_current_activity(driver))


def _home(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    driver.press_keycode(3)
    return ActionOutcome(status="PASSED")


# ── Interaction ────────────────────────────────────────────────────────────

def _dismiss_keyboard_if_shown(driver) -> None:
    """Generic, app-agnostic cleanup after any text entry: a visible soft
    keyboard covers whatever's below it, which is exactly why the same
    "field 2 becomes unreachable after typing into field 1" failure shows up
    across unrelated apps' forms. No test author or AI generation step should
    have to remember this — the engine does it automatically every time."""
    try:
        if driver.is_keyboard_shown():
            driver.hide_keyboard()
    except Exception:
        pass  # not fatal — some drivers/OS versions don't support the check


def _tap(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step, prefer_clickable=True, want_role="button")
    tap_element(driver, element)
    # A tap very often triggers navigation — give whatever it opened a chance
    # to render (and settle) before the next step resolves against it. The
    # budget has to cover a cold/slow device doing a full screen transition;
    # wait_for_stable_content returns as soon as the UI is stable, so a tap
    # that did nothing still costs only ~1s.
    try:
        wait_for_stable_content(driver, timeout_ms=12000, min_meaningful=2)
    except Exception:
        pass
    return ActionOutcome(status="PASSED", resolved_locator=step.locator.dict() if step.locator else None)


def _double_tap(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step, prefer_clickable=True)
    driver.execute_script("mobile: doubleClickGesture", {"elementId": element.id})
    return ActionOutcome(status="PASSED")


def _long_press(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step, prefer_clickable=True)
    driver.execute_script("mobile: longClickGesture", {"elementId": element.id})
    return ActionOutcome(status="PASSED")


def _resolve_editable(driver, step: TestStep):
    """Text-entry steps must land on something you can actually type into. The
    AI generator frequently produces a `text=` locator pointing at a field's
    visible *label/placeholder* (a non-editable TextView) instead of the input
    itself. Resolve normally, and if what we got isn't editable, fall back to a
    semantic search for the real input near that label using the step's hint.
    Generic — no app-specific field names."""
    try:
        el = _resolve(driver, step, want_role="input")
    except ElementNotFoundError:
        el = None
    if el is not None:
        try:
            cls = el.get_attribute("className") or ""
        except Exception:
            cls = ""
        if any(m in cls for m in ("EditText", "AutoCompleteTextView", "TextInputEditText")):
            return el
        try:
            if el.get_attribute("password") == "true":
                return el
        except Exception:
            pass
    hint = (step.locator.hint if step.locator else None) or (step.locator.value if step.locator else None)
    if hint:
        from mobile.schemas import Locator
        try:
            # Poll (don't one-shot) — on a cold device the target screen may
            # still be rendering when we get here.
            return wait_for_element(
                driver, Locator(strategy="semantic", value=hint, hint=hint),
                timeout_ms=max(step.timeout_ms, 10000), want_role="input",
            )
        except ElementNotFoundError:
            pass
    if el is not None:
        return el  # best effort — better to try typing than to hard-fail
    raise ElementNotFoundError(step.locator, ["input"])


def _enter_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve_editable(driver, step)
    element.send_keys(step.value or "")
    _dismiss_keyboard_if_shown(driver)
    return ActionOutcome(status="PASSED", actual=step.value)


def _replace_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve_editable(driver, step)
    element.clear()
    element.send_keys(step.value or "")
    _dismiss_keyboard_if_shown(driver)
    return ActionOutcome(status="PASSED", actual=step.value)


def _clear_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve_editable(driver, step)
    element.clear()
    return ActionOutcome(status="PASSED")


def _swipe(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    direction = (step.value or "up").lower()
    size = driver.get_window_size()
    driver.execute_script("mobile: swipeGesture", {
        "left": int(size["width"] * 0.1), "top": int(size["height"] * 0.1),
        "width": int(size["width"] * 0.8), "height": int(size["height"] * 0.8),
        "direction": direction, "percent": 0.85,
    })
    return ActionOutcome(status="PASSED", actual=direction)


def _scroll(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    return _swipe(driver, step, ctx)


def _scroll_to_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """Scroll a scrollable container until an element containing this text is
    visible — the generic answer to 'the element I need is off-screen and I
    don't know the exact scroll distance'. Works for dynamically-sized lists
    (rule: adapt to dynamic content, don't assume fixed positions)."""
    target = step.value or (step.locator.value if step.locator else None)
    if not target:
        return ActionOutcome(status="FAILED", error="SCROLL_TO_TEXT requires a target text in `value` or `locator.value`.", error_code="UNSUPPORTED_CAPABILITY")
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException
    selector = (
        'new UiScrollable(new UiSelector().scrollable(true)).setMaxSearchSwipes(8)'
        f'.scrollIntoView(new UiSelector().textContains("{target}"))'
    )
    try:
        driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
    except NoSuchElementException:
        return ActionOutcome(status="FAILED", error=f"Could not scroll '{target}' into view.", error_code="ELEMENT_NOT_FOUND")
    return ActionOutcome(status="PASSED", actual=target)


def _drag(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """Drag from step.locator to a destination locator passed as a JSON string
    in step.value, e.g. value='{"strategy":"resource_id","value":"...bin_icon"}'."""
    import json as _json
    source = _resolve(driver, step)
    if not step.value:
        return ActionOutcome(status="FAILED", error="DRAG requires a destination locator JSON in `value`.", error_code="UNSUPPORTED_CAPABILITY")
    try:
        dest_spec = _json.loads(step.value)
        dest_locator = TestStep(action="DRAG", locator=dest_spec).locator
    except Exception as exc:
        return ActionOutcome(status="FAILED", error=f"Invalid destination locator JSON: {exc}", error_code="UNSUPPORTED_CAPABILITY")
    dest = resolve_element(driver, dest_locator)
    driver.execute_script("mobile: dragGesture", {"elementId": source.id, "destElementId": dest.id})
    return ActionOutcome(status="PASSED")


def _pinch(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step) if step.locator else None
    payload = {"elementId": element.id} if element else {}
    payload["percent"] = 0.75
    driver.execute_script("mobile: pinchCloseGesture", payload)
    return ActionOutcome(status="PASSED")


def _zoom(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step) if step.locator else None
    payload = {"elementId": element.id} if element else {}
    payload["percent"] = 0.75
    driver.execute_script("mobile: pinchOpenGesture", payload)
    return ActionOutcome(status="PASSED")


_ANDROID_KEYCODES = {
    "HOME": 3, "BACK": 4, "CALL": 5, "ENDCALL": 6, "ENTER": 66, "DEL": 67,
    "BACKSPACE": 67, "TAB": 61, "SPACE": 62, "ESCAPE": 111, "MENU": 82,
    "SEARCH": 84, "CAMERA": 27, "VOLUME_UP": 24, "VOLUME_DOWN": 25,
    "APP_SWITCH": 187,
}


def _press_key(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    raw = (step.value or "").strip()
    if not raw:
        return ActionOutcome(status="FAILED", error="PRESS_KEY requires a keycode name or number in `value`.", error_code="UNSUPPORTED_CAPABILITY")
    keycode = _ANDROID_KEYCODES.get(raw.upper())
    if keycode is None:
        try:
            keycode = int(raw)
        except ValueError:
            return ActionOutcome(status="FAILED", error=f"Unknown keycode '{raw}' (known names: {sorted(_ANDROID_KEYCODES)}).", error_code="UNSUPPORTED_CAPABILITY")
    driver.press_keycode(keycode)
    return ActionOutcome(status="PASSED", actual=str(keycode))


def _set_orientation(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    value = (step.value or "PORTRAIT").upper()
    if value not in ("PORTRAIT", "LANDSCAPE"):
        return ActionOutcome(status="FAILED", error="value must be PORTRAIT or LANDSCAPE.", error_code="UNSUPPORTED_CAPABILITY")
    driver.orientation = value
    return ActionOutcome(status="PASSED", actual=value)


# ── Waits ────────────────────────────────────────────────────────────────

def _wait(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """Fixed pause in ms. Defensive parse: the AI generator sometimes emits a
    WAIT with an empty / non-numeric value — treat that as a short default
    rather than crashing or blocking for a full step timeout. Also hard-cap so
    a bad '600000' can't stall a whole suite."""
    raw = (step.value or "").strip()
    try:
        ms = int(float(raw)) if raw else 1000
    except (TypeError, ValueError):
        ms = 1000
    ms = max(0, min(ms, 15000))
    time.sleep(ms / 1000.0)
    return ActionOutcome(status="PASSED", actual=str(ms))


def _wait_for_element(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    _resolve(driver, step)
    return ActionOutcome(status="PASSED", resolved_locator=step.locator.dict() if step.locator else None)


def _wait_for_activity(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    deadline = time.time() + step.timeout_ms / 1000.0
    while time.time() < deadline:
        current = get_current_activity(driver)
        if current and step.value and step.value in current:
            return ActionOutcome(status="PASSED", actual=current)
        time.sleep(0.4)
    return ActionOutcome(status="FAILED", actual=get_current_activity(driver),
                          error=f"Activity did not become '{step.value}' within {step.timeout_ms}ms",
                          error_code="NAVIGATION_ERROR")


# ── Assertions ──────────────────────────────────────────────────────────

def _assert_visible(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    visible = element.is_displayed()
    return ActionOutcome(
        status="PASSED" if visible else "FAILED",
        actual=str(visible),
        resolved_locator=step.locator.dict() if step.locator else None,
        error=None if visible else "Element resolved but is not displayed.",
        error_code=None if visible else "ASSERTION_FAILURE",
    )


def _assert_not_visible(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    try:
        element = resolve_element(driver, step.locator)
        visible = element.is_displayed()
        return ActionOutcome(status="FAILED" if visible else "PASSED", actual=str(visible),
                              error=None if not visible else "Element unexpectedly visible.",
                              error_code=None if not visible else "ASSERTION_FAILURE")
    except ElementNotFoundError:
        return ActionOutcome(status="PASSED", actual="not_found")


def _assert_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    actual = element.text or element.get_attribute("content-desc") or ""
    expected = _expected_value(step) or ""
    ok = actual.strip() == expected.strip()
    return ActionOutcome(status="PASSED" if ok else "FAILED", actual=actual,
                          resolved_locator=step.locator.dict() if step.locator else None,
                          error=None if ok else f"Expected text '{expected}', got '{actual}'",
                          error_code=None if ok else "TEXT_MISMATCH")


def _assert_enabled(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    ok = element.is_enabled()
    return ActionOutcome(status="PASSED" if ok else "FAILED", actual=str(ok),
                          error=None if ok else "Element is disabled.",
                          error_code=None if ok else "ASSERTION_FAILURE")


def _assert_selected(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    ok = element.is_selected()
    return ActionOutcome(status="PASSED" if ok else "FAILED", actual=str(ok),
                          error=None if ok else "Element is not selected.",
                          error_code=None if ok else "ASSERTION_FAILURE")


def _assert_checked(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    checked = (element.get_attribute("checked") == "true")
    ok = checked == (_expected_value(step) != "false")
    return ActionOutcome(status="PASSED" if ok else "FAILED", actual=str(checked),
                          error=None if ok else "Checked state mismatch.",
                          error_code=None if ok else "ASSERTION_FAILURE")


def _assert_activity(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    current = get_current_activity(driver)
    expected = _expected_value(step)
    ok = bool(current and expected and expected in current)
    return ActionOutcome(status="PASSED" if ok else "FAILED", actual=current,
                          error=None if ok else f"Expected activity containing '{expected}', got '{current}'",
                          error_code=None if ok else "NAVIGATION_ERROR")


def _assert_crash_free(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    try:
        current_pkg = get_current_package(driver)
    except Exception as exc:
        return ActionOutcome(status="FAILED", error=f"Session unresponsive: {exc}", error_code="APP_CRASH")
    if ctx.expected_package and current_pkg and current_pkg != ctx.expected_package:
        return ActionOutcome(status="FAILED", actual=current_pkg,
                              error=f"App under test is no longer foreground (now '{current_pkg}') — likely crash/ANR.",
                              error_code="APP_CRASH")
    return ActionOutcome(status="PASSED", actual=current_pkg)


# ── Evidence (capture is orchestrated by engine.py; these are no-ops that
#    just signal intent for step-level evidence policy) ───────────────────

def _noop_evidence(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    return ActionOutcome(status="PASSED")


ACTION_REGISTRY: Dict[str, Callable[[Any, TestStep, ActionContext], ActionOutcome]] = {
    "LAUNCH": _launch,
    "TERMINATE": _terminate,
    "RESTART": _launch,
    "RESET_APP": _reset_app,
    "CLEAR_DATA": _reset_app,
    "BACK": _back,
    "HOME": _home,

    "TAP": _tap,
    "DOUBLE_TAP": _double_tap,
    "LONG_PRESS": _long_press,
    "ENTER_TEXT": _enter_text,
    "REPLACE_TEXT": _replace_text,
    "APPEND_TEXT": _enter_text,
    "CLEAR_TEXT": _clear_text,
    "DELETE_TEXT": _clear_text,

    "SWIPE": _swipe,
    "SCROLL": _scroll,
    "SCROLL_TO_TEXT": _scroll_to_text,
    "DRAG": _drag,
    "PINCH": _pinch,
    "ZOOM": _zoom,
    "PRESS_KEY": _press_key,
    "SET_ORIENTATION": _set_orientation,

    "WAIT": _wait,
    "WAIT_FOR_ELEMENT": _wait_for_element,
    "WAIT_FOR_TEXT": _wait_for_element,
    "WAIT_FOR_ACTIVITY": _wait_for_activity,
    "WAIT_FOR_GONE": _assert_not_visible,

    "ASSERT_VISIBLE": _assert_visible,
    "ASSERT_NOT_VISIBLE": _assert_not_visible,
    "ASSERT_TEXT": _assert_text,
    "ASSERT_ENABLED": _assert_enabled,
    "ASSERT_DISABLED": lambda d, s, c: _invert(_assert_enabled(d, s, c)),
    "ASSERT_SELECTED": _assert_selected,
    "ASSERT_CHECKED": _assert_checked,
    "ASSERT_ACTIVITY": _assert_activity,
    "ASSERT_CRASH_FREE": _assert_crash_free,

    "TAKE_SCREENSHOT": _noop_evidence,
    "CAPTURE_HIERARCHY": _noop_evidence,
}

# Actions whose primary purpose is resolving a locator against the live app —
# these are the ones eligible for AutoHeal on ElementNotFoundError.
LOCATOR_DEPENDENT_ACTIONS = {
    "TAP", "DOUBLE_TAP", "LONG_PRESS", "ENTER_TEXT", "REPLACE_TEXT", "APPEND_TEXT",
    "CLEAR_TEXT", "DELETE_TEXT", "WAIT_FOR_ELEMENT", "WAIT_FOR_TEXT",
    "ASSERT_VISIBLE", "ASSERT_TEXT", "ASSERT_ENABLED", "ASSERT_DISABLED",
    "ASSERT_SELECTED", "ASSERT_CHECKED", "DRAG",
}


def _invert(outcome: ActionOutcome) -> ActionOutcome:
    inverted_status = "FAILED" if outcome.status == "PASSED" else "PASSED"
    return ActionOutcome(status=inverted_status, actual=outcome.actual,
                          resolved_locator=outcome.resolved_locator)


def execute_action(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    executor = ACTION_REGISTRY.get(step.action)
    if executor is None:
        return ActionOutcome(status="FAILED", error=f"Unsupported action '{step.action}'.",
                              error_code="UNSUPPORTED_CAPABILITY")
    return executor(driver, step, ctx)
