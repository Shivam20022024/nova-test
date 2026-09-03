"""
ActionRegistry — extensible baseline Android action set (section 15/16).
Every executor takes (driver, step, ctx) and returns an ActionOutcome; new
actions register into ACTION_REGISTRY without touching the execution engine.
"""
from __future__ import annotations

import os
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from mobile.device_manager import _adb as _run_adb
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
    _scroll_into_view,
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
    def __init__(self, expected_package: Optional[str] = None, device_serial: Optional[str] = None):
        self.expected_package = expected_package
        # Optional: only the new device-condition actions (permissions,
        # network, GPS — see actions.py's "Device conditions" section) need
        # the raw adb serial. Every existing action ignores this field.
        self.device_serial = device_serial


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


# Thread-local, not a plain module global: multiple mobile executions run
# concurrently in their own threads (mobile/suite_engine.py), and a global
# flag would let one execution's fallback resolution be read by another's
# step loop. Private to this module — engine.py reads it only through
# consume_resolved_via_fallback() below.
_fallback_state = threading.local()


def consume_resolved_via_fallback() -> bool:
    """Read-and-reset: did the most recent _resolve() call on this thread
    succeed via a step's fallback_locators rather than its primary locator?
    Called once per step by the execution engine right after the action
    runs, so a step that only worked because of a fallback can be reported
    as RESOLVED_VIA_FALLBACK instead of a plain PASSED — visible in the
    report, without having consumed a full AutoHeal cycle to get there."""
    used = getattr(_fallback_state, "used", False)
    _fallback_state.used = False
    return used


def _resolve(driver, step: TestStep, timeout_ms: Optional[int] = None, prefer_clickable: bool = False, want_role: str = "any"):
    _require_locator(step)
    _fallback_state.used = False
    try:
        return wait_for_element(
            driver, step.locator, timeout_ms=timeout_ms or step.timeout_ms,
            prefer_clickable=prefer_clickable, want_role=want_role,
        )
    except ElementNotFoundError:
        # The primary locator genuinely isn't there right now — a step's own
        # fallback_locators (recorded at authoring time from the same Screen
        # Map element, see schemas.py) get one quick, bounded try each before
        # surrendering to the same ElementNotFoundError AutoHeal already
        # handles. Short timeout per fallback: if the primary already waited
        # out its full timeout_ms, a genuine failure shouldn't cost another
        # full wait per fallback on top of that.
        fallback_timeout = min(2000, timeout_ms or step.timeout_ms)
        for fb in (step.fallback_locators or []):
            try:
                element = wait_for_element(
                    driver, fb, timeout_ms=fallback_timeout,
                    prefer_clickable=prefer_clickable, want_role=want_role,
                )
                _fallback_state.used = True
                return element
            except ElementNotFoundError:
                continue
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
    # Only the coordinate-tap fallback (used when the resolved element itself
    # isn't clickable) needs a before/after snapshot — a real element.click()
    # already raises on failure, and diffing the hierarchy on every ordinary
    # tap would be pure overhead. The fallback has no such signal: a W3C
    # coordinate tap reports success whether it landed on a clickable parent
    # card (the intended target) or on genuinely dead space next to it (e.g.
    # a plain label positioned outside any clickable container) — Appium
    # cannot tell those apart, only the app's own response can.
    try:
        before = capture_hierarchy_xml(driver)
    except Exception:
        before = None
    used_coordinate_fallback = tap_element(driver, element)
    # A tap very often triggers navigation — give whatever it opened a chance
    # to render (and settle) before the next step resolves against it. The
    # budget has to cover a cold/slow device doing a full screen transition;
    # wait_for_stable_content returns as soon as the UI is stable, so a tap
    # that did nothing still costs only ~1s.
    try:
        wait_for_stable_content(driver, timeout_ms=12000, min_meaningful=2)
    except Exception:
        pass
    if used_coordinate_fallback and before is not None:
        try:
            after = capture_hierarchy_xml(driver)
        except Exception:
            after = None
        if after is not None and after == before:
            # Byte-identical hierarchy after a tap is about as strong a
            # negative signal as this engine can get without app-specific
            # knowledge — any real response (navigation, a toast, a badge
            # update, even a checkbox's own checked attribute) changes SOME
            # attribute somewhere in the dump. Reporting this honestly as a
            # failure (rather than a silent PASSED) hands it to the exact
            # same AutoHeal pipeline every other failed step gets — which can
            # then score a genuinely clickable candidate (a sibling image, an
            # enclosing card) that this locator's own text/hint match missed,
            # instead of the run silently drifting off-scenario and failing
            # somewhere confusing several steps later. Same for any app: this
            # never looks at what the tap target actually was.
            return ActionOutcome(
                status="FAILED",
                resolved_locator=step.locator.dict() if step.locator else None,
                error="Tap produced no observable change on screen — it likely landed outside any interactive region.",
                error_code="TAP_NO_EFFECT",
            )
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
    (rule: adapt to dynamic content, don't assume fixed positions).

    Uses the same explicitly-bounded swipe as the generic SWIPE action (never
    UiScrollable's own scrollIntoView) — on a gesture-navigation device that
    class's internal swipe can start or end inside the OS's bottom gesture
    strip and get read as "go home" instead of a scroll, exiting the app
    mid-test. Confirmed live in this engine; fixed at the shared root."""
    target = step.value or (step.locator.value if step.locator else None)
    if not target:
        return ActionOutcome(status="FAILED", error="SCROLL_TO_TEXT requires a target text in `value` or `locator.value`.", error_code="UNSUPPORTED_CAPABILITY")
    if not _scroll_into_view(driver, target):
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


def _readable_text(element) -> str:
    """The text a resolved element actually shows, digging into children when
    the element itself has none.

    A very common Android pattern — a cart/notification badge, a tab counter,
    any icon-plus-count control — is a container (a RelativeLayout/FrameLayout)
    that carries a fixed, count-independent content-desc for accessibility
    (e.g. "View cart") while the actual count lives in a nested TextView two
    or three levels down. An element's own `.text` is empty for any non-leaf
    container, so reading only the resolved element's own text/content-desc
    silently returns that static accessibility label instead of the real,
    dynamic value being asserted — for any app built with this layout
    pattern, not any one app in particular. Preferring the element's own
    non-empty `.text` keeps the common single-TextView case exactly as before;
    only a genuinely textless container falls through to searching its
    descendants for the first real text, then finally its own content-desc.
    """
    own_text = (element.text or "").strip()
    if own_text:
        return own_text
    try:
        from appium.webdriver.common.appiumby import AppiumBy
        for child in element.find_elements(AppiumBy.XPATH, ".//*[@text]"):
            child_text = (child.text or "").strip()
            if child_text:
                return child_text
    except Exception:
        pass
    return (element.get_attribute("content-desc") or "").strip()


def _assert_text(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    element = _resolve(driver, step)
    actual = _readable_text(element)
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


# ── Device conditions (integration plan Phase 1: permissions, background,
#    local notifications, network, GPS) ────────────────────────────────────

_PERMISSION_PREFIX = "android.permission."


def _normalize_permission(raw: str) -> str:
    raw = raw.strip()
    return raw if "." in raw else f"{_PERMISSION_PREFIX}{raw.upper()}"


def _grant_or_deny_permission(driver, step: TestStep, ctx: ActionContext, grant: bool) -> ActionOutcome:
    package = ctx.expected_package
    if not package:
        return ActionOutcome(status="FAILED", error="No application package known for this execution.", error_code="UNSUPPORTED_CAPABILITY")
    raw = (step.value or "").strip()
    if not raw:
        return ActionOutcome(status="FAILED", error=f"{step.action} requires a permission name in `value` (e.g. 'CAMERA' or 'android.permission.CAMERA').", error_code="UNSUPPORTED_CAPABILITY")
    permission = _normalize_permission(raw)
    verb = "grant" if grant else "revoke"
    past_tense = "granted" if grant else "revoked"
    try:
        result = _run_adb(["shell", "pm", verb, package, permission], serial=ctx.device_serial)
    except Exception as exc:
        return ActionOutcome(status="FAILED", error=str(exc), error_code="UNSUPPORTED_CAPABILITY")
    if result.returncode != 0:
        return ActionOutcome(status="FAILED", actual=permission,
                              error=(result.stderr or result.stdout or f"adb pm {verb} failed").strip(),
                              error_code="UNSUPPORTED_CAPABILITY")
    return ActionOutcome(status="PASSED", actual=f"{past_tense} {permission}")


def _grant_permission(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    return _grant_or_deny_permission(driver, step, ctx, grant=True)


def _deny_permission(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    return _grant_or_deny_permission(driver, step, ctx, grant=False)


def _set_background(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """Send the app under test to the background and bring it back after
    `value` seconds (default 3). This is a standard built-in Appium
    extension — no adb or device-specific handling needed, so it works the
    same on an emulator or a real device."""
    raw = (step.value or "").strip()
    try:
        seconds = float(raw) if raw else 3.0
    except ValueError:
        seconds = 3.0
    driver.execute_script("mobile: backgroundApp", {"seconds": seconds})
    wait_for_stable_content(driver, timeout_ms=min(int(seconds * 1000) + 8000, 20000))
    return ActionOutcome(status="PASSED", actual=f"backgrounded for {seconds}s")


def _post_local_notification(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """Posts a real system notification on the device/emulator so a test can
    verify the app reacts correctly to one appearing (opening it from the
    notification shade, a badge updating, etc). This is a *local* notification
    injected via adb, not a push message delivered through Firebase/APNs —
    see the integration plan for why that's the realistic slice to build
    without standing up a real push-messaging project of its own.
    `value` is "title|body", or just "body" (title defaults to "NovaTest AI")."""
    text = (step.value or "NovaTest AI test notification").strip()
    if "|" in text:
        title, _, body = text.partition("|")
    else:
        title, body = "NovaTest AI", text
    try:
        result = _run_adb(
            ["shell", "cmd", "notification", "post", "-t", title, "novatest_ai_test", body],
            serial=ctx.device_serial,
        )
    except Exception as exc:
        return ActionOutcome(status="FAILED", error=str(exc), error_code="UNSUPPORTED_CAPABILITY")
    if result.returncode != 0:
        return ActionOutcome(status="FAILED", error=(result.stderr or result.stdout or "adb cmd notification post failed").strip(), error_code="UNSUPPORTED_CAPABILITY")
    return ActionOutcome(status="PASSED", actual=f"{title}: {body}")


_NETWORK_ONLINE_STATES = {"ONLINE", "ON", "WIFI"}
_NETWORK_OFFLINE_STATES = {"OFFLINE", "OFF"}
_NETWORK_SPEED_PROFILES = {"GSM", "EDGE", "UMTS", "HSDPA", "LTE", "FULL"}


def _emulator_console_command(serial: Optional[str], command: str, timeout: float = 5.0) -> str:
    """Send one command to the Android Studio emulator's console — the only
    way to simulate network *speed* (as opposed to just on/off), since
    there's no adb-shell or Appium equivalent. Emulator-only by nature: a
    real phone has no such console to connect to."""
    if not serial or not serial.startswith("emulator-"):
        raise RuntimeError("Network-speed simulation only works on an emulator (device serial must start with 'emulator-').")
    port = int(serial.split("-", 1)[1])
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        sock.settimeout(timeout)
        banner = sock.recv(4096).decode(errors="ignore")
        if "auth" in banner.lower():
            token_path = os.path.join(os.path.expanduser("~"), ".emulator_console_auth_token")
            try:
                with open(token_path, "r") as f:
                    token = f.read().strip()
                sock.sendall(f"auth {token}\n".encode())
                sock.recv(4096)
            except FileNotFoundError:
                pass  # many local setups run the console with auth disabled
        sock.sendall(f"{command}\n".encode())
        return sock.recv(4096).decode(errors="ignore")
    finally:
        try:
            sock.sendall(b"quit\n")
        except Exception:
            pass
        sock.close()


def _set_network_profile(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """ONLINE/OFFLINE toggles wifi+data via `svc` — works on most emulators
    and many real devices (a minority of real devices restrict `svc` to
    root, in which case this fails clearly rather than silently no-op'ing).
    Throttled speed profiles (GSM/EDGE/UMTS/HSDPA/LTE/FULL) only exist on the
    Android Studio emulator, via its console."""
    raw = (step.value or "").strip().upper()
    if not raw:
        return ActionOutcome(status="FAILED", error="SET_NETWORK_PROFILE requires a profile in `value` (ONLINE, OFFLINE, GSM, EDGE, UMTS, HSDPA, LTE, FULL).", error_code="UNSUPPORTED_CAPABILITY")

    if raw in _NETWORK_ONLINE_STATES or raw in _NETWORK_OFFLINE_STATES:
        state = "enable" if raw in _NETWORK_ONLINE_STATES else "disable"
        try:
            wifi = _run_adb(["shell", "svc", "wifi", state], serial=ctx.device_serial)
            data = _run_adb(["shell", "svc", "data", state], serial=ctx.device_serial)
        except Exception as exc:
            return ActionOutcome(status="FAILED", error=str(exc), error_code="UNSUPPORTED_CAPABILITY")
        if wifi.returncode != 0 or data.returncode != 0:
            return ActionOutcome(status="FAILED", actual=raw,
                                  error="Device did not allow toggling wifi/data (some real devices restrict `svc` to root).",
                                  error_code="UNSUPPORTED_CAPABILITY")
        return ActionOutcome(status="PASSED", actual=raw)

    if raw in _NETWORK_SPEED_PROFILES:
        try:
            reply = _emulator_console_command(ctx.device_serial, f"network speed {raw.lower()}")
        except Exception as exc:
            return ActionOutcome(status="FAILED", error=str(exc), error_code="UNSUPPORTED_CAPABILITY")
        if reply.strip().lower().startswith("ko"):
            return ActionOutcome(status="FAILED", actual=raw, error=f"Emulator console rejected the profile: {reply.strip()}", error_code="UNSUPPORTED_CAPABILITY")
        return ActionOutcome(status="PASSED", actual=raw)

    return ActionOutcome(status="FAILED", error=f"Unknown network profile '{raw}'.", error_code="UNSUPPORTED_CAPABILITY")


def _set_mock_location(driver, step: TestStep, ctx: ActionContext) -> ActionOutcome:
    """GPS mocking via `adb emu geo fix` — emulator-only, since that command
    only exists for the emulator's virtual GPS. On a real device this needs
    the tester to enable a mock-location app under Developer Options by
    hand first; we fail clearly here rather than pretending this worked."""
    raw = (step.value or "").strip()
    if not raw or "," not in raw:
        return ActionOutcome(status="FAILED", error="SET_MOCK_LOCATION requires `value` as 'latitude,longitude' (e.g. '37.4219,-122.0840').", error_code="UNSUPPORTED_CAPABILITY")
    if not ctx.device_serial or not ctx.device_serial.startswith("emulator-"):
        return ActionOutcome(status="FAILED", error="GPS mocking via this action only works on an emulator. On a real device, enable a mock-location app manually first.", error_code="UNSUPPORTED_CAPABILITY")
    try:
        lat_str, lon_str = (p.strip() for p in raw.split(",", 1))
        lat, lon = float(lat_str), float(lon_str)
    except ValueError:
        return ActionOutcome(status="FAILED", error=f"Could not parse '{raw}' as 'latitude,longitude'.", error_code="UNSUPPORTED_CAPABILITY")
    try:
        result = _run_adb(["emu", "geo", "fix", str(lon), str(lat)], serial=ctx.device_serial)
    except Exception as exc:
        return ActionOutcome(status="FAILED", error=str(exc), error_code="UNSUPPORTED_CAPABILITY")
    if result.returncode != 0:
        return ActionOutcome(status="FAILED", error=(result.stderr or result.stdout or "adb emu geo fix failed").strip(), error_code="UNSUPPORTED_CAPABILITY")
    return ActionOutcome(status="PASSED", actual=f"lat={lat}, lon={lon}")


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

    "GRANT_PERMISSION": _grant_permission,
    "DENY_PERMISSION": _deny_permission,
    "SET_BACKGROUND": _set_background,
    "POST_LOCAL_NOTIFICATION": _post_local_notification,
    "SET_NETWORK_PROFILE": _set_network_profile,
    "SET_MOCK_LOCATION": _set_mock_location,
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
