"""
UI hierarchy capture, screen/element signatures, and multi-strategy locator
resolution. This is the shared substrate both direct action execution and
the AutoHeal candidate generator build on (rule: never depend on one
interaction/locator mechanism).
"""
from __future__ import annotations

import hashlib
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from mobile.schemas import Locator

ATTR_KEYS = [
    "class", "resource-id", "text", "content-desc", "package",
    "checkable", "checked", "clickable", "enabled", "focusable",
    "focused", "scrollable", "long-clickable", "password", "selected",
    "bounds", "index",
]


class ElementNotFoundError(Exception):
    def __init__(self, locator: Locator, tried: List[str]):
        self.locator = locator
        self.tried = tried
        super().__init__(f"Could not resolve element via {locator.strategy}='{locator.value}' (tried: {tried})")


@dataclass
class ElementNode:
    attrs: Dict[str, str]
    path: str            # positional xpath, e.g. /hierarchy/android.widget.FrameLayout[1]/...
    depth: int
    parent_class: Optional[str] = None
    sibling_index: int = 0

    @property
    def bounds_box(self) -> Optional[tuple]:
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", self.attrs.get("bounds", ""))
        if not m:
            return None
        return tuple(int(x) for x in m.groups())


def capture_hierarchy_xml(driver) -> str:
    return driver.page_source


def parse_hierarchy(xml_string: str) -> List[ElementNode]:
    """Flatten the UiAutomator2 XML dump into ElementNode records with a stable
    positional xpath for each — used both for direct XPath fallback and for
    AutoHeal candidate scoring."""
    root = ET.fromstring(xml_string)
    nodes: List[ElementNode] = []

    def walk(el: ET.Element, path: str, depth: int, parent_class: Optional[str]):
        tag_counts: Dict[str, int] = {}
        for child in el:
            tag = child.tag
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
            idx = tag_counts[tag]
            child_path = f"{path}/{tag}[{idx}]"
            attrs = dict(child.attrib)
            nodes.append(ElementNode(attrs=attrs, path=child_path, depth=depth + 1,
                                      parent_class=parent_class, sibling_index=idx))
            walk(child, child_path, depth + 1, attrs.get("class"))

    walk(root, "", 0, None)
    return nodes


def build_screen_signature(package: str, activity: Optional[str], nodes: List[ElementNode]) -> str:
    resource_ids = sorted({n.attrs.get("resource-id", "") for n in nodes if n.attrs.get("resource-id")})
    h = hashlib.sha1()
    h.update((package or "").encode())
    h.update((activity or "").encode())
    h.update(str(len(nodes)).encode())
    h.update("|".join(resource_ids[:50]).encode())
    return h.hexdigest()[:24]


def _text_hash(text: str) -> str:
    return hashlib.sha1((text or "").strip().lower().encode()).hexdigest()[:12]


def build_element_signature(node: ElementNode) -> str:
    a = node.attrs
    parts = [
        a.get("class", ""),
        a.get("resource-id", ""),
        a.get("content-desc", ""),
        _text_hash(a.get("text", "")),
        node.parent_class or "",
        str(node.depth),
        str(node.sibling_index),
    ]
    h = hashlib.sha1("|".join(parts).encode())
    return h.hexdigest()[:24]


def element_attributes_snapshot(node: ElementNode) -> Dict[str, str]:
    return {k: node.attrs.get(k, "") for k in ATTR_KEYS}


# ── Locator resolution (multi-strategy, section 19) ───────────────────────

def _escape_uiautomator_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _find_by_strategy(driver, strategy: str, value: str, prefer_clickable: bool = False):
    """`prefer_clickable` matters for text/text_contains only: many real apps
    reuse the exact same visible text for both a non-interactive screen title
    and a real button (e.g. a "Login" heading above a "Login" submit button).
    An interactive action (TAP/ENTER_TEXT/...) should target the *clickable*
    occurrence when one exists — an assertion should not, since it may
    legitimately be checking a label. This is a generic UiAutomator2 query
    change, not anything specific to one app."""
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import InvalidSelectorException, NoSuchElementException

    safe_value = _escape_uiautomator_string(value)
    strategy_map = {
        "accessibility_id": (AppiumBy.ACCESSIBILITY_ID, value),
        "content_desc": (AppiumBy.ACCESSIBILITY_ID, value),
        "resource_id": (AppiumBy.ID, value),
        "id": (AppiumBy.ID, value),
        "class_name": (AppiumBy.CLASS_NAME, value),
        "xpath": (AppiumBy.XPATH, value),
        "text": (AppiumBy.ANDROID_UIAUTOMATOR, f'new UiSelector().text("{safe_value}")'),
        "text_contains": (AppiumBy.ANDROID_UIAUTOMATOR, f'new UiSelector().textContains("{safe_value}")'),
        "uiautomator": (AppiumBy.ANDROID_UIAUTOMATOR, value),
    }
    by, val = strategy_map.get(strategy, (None, None))
    if by is None:
        raise ValueError(f"Unsupported locator strategy: {strategy}")

    # Real apps frequently ship labels with stray leading/trailing whitespace
    # ("  Login  ") or surrounding decoration, and an AI generator will just as
    # often emit the trimmed form. An exact accessibility-id / text lookup then
    # misses an element that is obviously the right one. Fall back to a
    # trimmed-contains match before giving up — generic, no per-app knowledge.
    def _with_contains_fallback(primary_by, primary_val, contains_selector):
        from selenium.common.exceptions import NoSuchElementException, InvalidSelectorException
        try:
            return driver.find_element(primary_by, primary_val)
        except (NoSuchElementException, InvalidSelectorException):
            trimmed = value.strip()
            if trimmed and trimmed != value:
                try:
                    return driver.find_element(primary_by, trimmed)
                except (NoSuchElementException, InvalidSelectorException):
                    pass
            if trimmed:
                return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, contains_selector)
            raise

    if strategy in ("accessibility_id", "content_desc"):
        return _with_contains_fallback(
            by, val, f'new UiSelector().descriptionContains("{_escape_uiautomator_string(value.strip())}")'
        )
    if strategy == "text" and not prefer_clickable:
        return _with_contains_fallback(
            by, val, f'new UiSelector().textContains("{_escape_uiautomator_string(value.strip())}")'
        )

    if prefer_clickable and strategy in ("text", "text_contains"):
        # UiAutomator2's fluent syntax chains by appending the next method
        # call after the previous one's closing paren — e.g.
        # `new UiSelector().text("Login").clickable(true)` — never by
        # inserting into the middle of the expression. (A previous version
        # of this used `val.replace(")", ...)`, which patched the FIRST `)`
        # in the string — the empty `UiSelector()` constructor's own paren,
        # not the end of the whole expression — producing a syntactically
        # invalid selector like `UiSelector(.clickable(true)).text(...)`
        # that failed on every single text-strategy tap. Simple append is
        # both correct and simpler.)
        clickable_selector = f"{val}.clickable(true)"
        try:
            return driver.find_element(by, clickable_selector)
        except (NoSuchElementException, InvalidSelectorException):
            pass  # fall through to the unfiltered query below

    return driver.find_element(by, val)


import difflib as _difflib


def _label_tokens(value: str) -> set:
    if not value:
        return set()
    value = re.sub(r"[._/\-]", " ", value)
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", value)
    return {t for t in re.split(r"\s+", value.lower()) if len(t) > 1}


def resolve_by_hint(driver, hint: str, want_role: str = "any"):
    """Resolve a step to a live element using only its human-language `hint`
    ('the username field', 'submit the transfer') — no literal locator value.

    Generic and framework-agnostic: it scores every currently-visible element
    by (a) role compatibility with the action and (b) semantic similarity of
    the hint to the element's own text/desc/id AND to the nearest visible
    label above/left of it (the common case for an unlabelled React-Native /
    Compose `EditText` whose placeholder is a separate TextView). This is what
    lets a generated test survive the model guessing the wrong locator string.
    """
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException

    hint = (hint or "").strip()
    if not hint:
        raise NoSuchElementException("resolve_by_hint: empty hint")
    nodes = parse_hierarchy(capture_hierarchy_xml(driver))
    visible = [n for n in nodes if (n.bounds_box and (n.bounds_box[2] - n.bounds_box[0]) > 0 and (n.bounds_box[3] - n.bounds_box[1]) > 0)]
    htok = _label_tokens(hint)

    labels = [n for n in visible if (n.attrs.get("text") or n.attrs.get("content-desc"))]

    def nearest_label_text(node) -> str:
        box = node.bounds_box
        if not box:
            return ""
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        best, best_d = "", 1e9
        for lb in labels:
            if lb is node:
                continue
            lbb = lb.bounds_box
            if not lbb:
                continue
            lcx, lcy = (lbb[0] + lbb[2]) / 2, (lbb[1] + lbb[3]) / 2
            # prefer labels above or to the left, reasonably close
            if lcy > cy + 40 and abs(lcx - cx) > 8:
                continue
            d = ((lcx - cx) ** 2 + (lcy - cy) ** 2) ** 0.5
            if d < best_d and d < 600:
                best_d, best = d, (lb.attrs.get("text") or lb.attrs.get("content-desc") or "")
        return best

    scored = []
    for n in visible:
        role = element_role(n)
        if want_role == "input" and role != "input":
            continue
        if want_role in ("button", "toggle") and role not in ("button", "toggle", "text"):
            continue
        own = " ".join(filter(None, [n.attrs.get("text", ""), n.attrs.get("content-desc", ""), n.attrs.get("resource-id", "")]))
        own_tok = _label_tokens(own)
        near = nearest_label_text(n)
        near_tok = _label_tokens(near)
        overlap = len(htok & (own_tok | near_tok))
        ratio = max(
            _difflib.SequenceMatcher(None, hint.lower(), (n.attrs.get("text") or "").lower()).ratio() if n.attrs.get("text") else 0.0,
            _difflib.SequenceMatcher(None, hint.lower(), near.lower()).ratio() if near else 0.0,
        )
        s = overlap * 3 + ratio * 2
        if want_role == "input" and role == "input":
            s += 1.0  # a matching role is itself evidence when the hint is thin
        if s > 0:
            scored.append((s, n))

    if not scored:
        raise NoSuchElementException(f"resolve_by_hint: nothing matched hint {hint!r} (role={want_role})")
    scored.sort(key=lambda x: x[0], reverse=True)
    best_node = scored[0][1]

    rid = best_node.attrs.get("resource-id")
    if rid:
        try:
            return driver.find_element(AppiumBy.ID, rid)
        except NoSuchElementException:
            pass
    cd = best_node.attrs.get("content-desc")
    if cd:
        try:
            return driver.find_element(AppiumBy.ACCESSIBILITY_ID, cd)
        except NoSuchElementException:
            pass
    txt = best_node.attrs.get("text")
    if txt:
        try:
            return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, f'new UiSelector().text("{_escape_uiautomator_string(txt)}")')
        except NoSuchElementException:
            pass
    # positional xpath as the last resort
    return driver.find_element(AppiumBy.XPATH, best_node.path or f"//{best_node.attrs.get('class', '*')}")


def resolve_element(driver, locator: Locator, prefer_clickable: bool = False, want_role: str = "any"):
    """Attempt the declared strategy; on failure raise ElementNotFoundError
    carrying enough context for the AutoHeal pipeline to take over."""
    from selenium.common.exceptions import NoSuchElementException

    if locator.strategy in ("semantic", "hint"):
        try:
            return resolve_by_hint(driver, locator.value or locator.hint or "", want_role=want_role)
        except NoSuchElementException:
            raise ElementNotFoundError(locator, ["semantic"])

    tried = [locator.strategy]
    try:
        return _find_by_strategy(driver, locator.strategy, locator.value, prefer_clickable=prefer_clickable)
    except NoSuchElementException:
        # A declared literal strategy that didn't resolve — if the locator also
        # carries a semantic hint, try that before surrendering to AutoHeal.
        if locator.hint:
            try:
                return resolve_by_hint(driver, locator.hint, want_role=want_role)
            except NoSuchElementException:
                pass
        raise ElementNotFoundError(locator, tried)


def wait_for_element(driver, locator: Locator, timeout_ms: int = 10000, poll_interval_s: float = 0.4, prefer_clickable: bool = False, want_role: str = "any"):
    """Adaptive polling wait — never a fixed sleep (rule 22)."""
    deadline = time.time() + (timeout_ms / 1000.0)
    last_err: Optional[Exception] = None
    while time.time() < deadline:
        try:
            return resolve_element(driver, locator, prefer_clickable=prefer_clickable, want_role=want_role)
        except ElementNotFoundError as exc:
            last_err = exc
            time.sleep(poll_interval_s)
    raise last_err or ElementNotFoundError(locator, [locator.strategy])


def tap_element(driver, element) -> None:
    """Real touch simulation, not just a semantic click. Proven bug: Appium's
    element.click() can return success on a non-clickable element WITHOUT
    throwing and WITHOUT the app actually responding (the accessibility click
    action silently no-ops) — so checking for an exception is not enough to
    tell whether anything happened. If the element doesn't report itself as
    clickable, skip .click() and go straight to a coordinate-based W3C tap,
    which is a genuine touch event that Android's normal hit-testing will
    route to whatever is really interactive at that screen position (e.g. a
    clickable parent card wrapping a plain text label) — exactly what a real
    user's finger does. Generic: no app-specific logic involved."""
    is_clickable = False
    try:
        is_clickable = element.get_attribute("clickable") == "true"
    except Exception:
        pass

    if is_clickable:
        try:
            element.click()
            return
        except Exception:
            pass

    try:
        rect = element.rect
        x = rect["x"] + rect["width"] // 2
        y = rect["y"] + rect["height"] // 2
        driver.tap([(x, y)], 50)
    except Exception:
        # last resort — the semantic click, even though clickable=false
        # suggested it might not do anything.
        element.click()


# ── Element role / editability (generic, framework-agnostic) ──────────────
# Used by the explorer (what can I interact with), execution-time re-grounding
# (does this candidate's role match the action), and the AI-output sanitizer
# (ENTER_TEXT must target something editable). Keyed off the standard Android
# widget class names every UiAutomator2 tree exposes — no app-specific logic.

_EDITABLE_CLASS_MARKERS = ("EditText", "AutoCompleteTextView", "TextInputEditText")
_BUTTON_CLASS_MARKERS = ("Button", "ImageButton", "CompoundButton")
_TOGGLE_CLASS_MARKERS = ("CheckBox", "Switch", "ToggleButton", "RadioButton")
_FRAMEWORK_RESOURCE_IDS = {
    "", "android:id/content", "android:id/action_bar_root", "android:id/navigationBarBackground",
    "android:id/statusBarBackground", "android:id/decor_content_parent",
}


def is_editable(node: "ElementNode") -> bool:
    cls = node.attrs.get("class", "")
    if any(m in cls for m in _EDITABLE_CLASS_MARKERS):
        return True
    if node.attrs.get("password") == "true":
        return True
    # RN/Compose sometimes report a generic class but flag the node focusable +
    # long-clickable with an empty text — a weak but useful last signal.
    return False


def element_role(node: "ElementNode") -> str:
    cls = node.attrs.get("class", "")
    if is_editable(node):
        return "input"
    if any(m in cls for m in _TOGGLE_CLASS_MARKERS):
        return "toggle"
    if any(m in cls for m in _BUTTON_CLASS_MARKERS):
        return "button"
    if node.attrs.get("clickable") == "true":
        return "button"
    if "ImageView" in cls:
        return "image"
    if node.attrs.get("text") or node.attrs.get("content-desc"):
        return "text"
    return "other"


def is_meaningful_node(node: "ElementNode") -> bool:
    """A node a human would recognise as real content/control — as opposed to
    an anonymous layout container. Used to tell 'the screen has rendered' from
    'we're staring at an empty FrameLayout mid-transition'."""
    a = node.attrs
    if a.get("text") or a.get("content-desc"):
        return True
    rid = a.get("resource-id", "")
    if rid and rid not in _FRAMEWORK_RESOURCE_IDS:
        return True
    return is_editable(node)


def wait_for_stable_content(
    driver,
    timeout_ms: int = 12000,
    min_meaningful: int = 3,
    poll_interval_s: float = 0.5,
) -> List["ElementNode"]:
    """Poll the accessibility tree until the screen has actually rendered
    meaningful content AND that content has stopped changing between two
    consecutive polls (or timeout). Returns the final parsed node list.

    This is the generic fix for the class of failure where a step runs against
    a screen that is still a blank container — React Native's JS bundle still
    booting, a Compose recomposition in flight, a fragment transition — and
    finds nothing. Never a fixed sleep: it returns as soon as the UI is ready.
    """
    deadline = time.time() + (timeout_ms / 1000.0)
    prev_sig: Optional[str] = None
    nodes: List[ElementNode] = []
    while time.time() < deadline:
        try:
            nodes = parse_hierarchy(capture_hierarchy_xml(driver))
        except Exception:
            time.sleep(poll_interval_s)
            continue
        meaningful = [n for n in nodes if is_meaningful_node(n)]
        sig = "|".join(sorted(
            (n.attrs.get("resource-id") or n.attrs.get("text") or n.attrs.get("content-desc") or n.attrs.get("class", ""))
            for n in meaningful
        ))
        if len(meaningful) >= min_meaningful and sig == prev_sig:
            return nodes
        prev_sig = sig
        time.sleep(poll_interval_s)
    return nodes


def get_current_activity(driver) -> Optional[str]:
    try:
        return driver.current_activity
    except Exception:
        return None


def get_current_package(driver) -> Optional[str]:
    try:
        return driver.current_package
    except Exception:
        return None
