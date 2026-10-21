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
    """Wraps `_find_by_strategy_once` with a single scroll-and-retry: a text
    lookup that fails outright (not "found but wrong," genuinely absent from
    the current hierarchy) is, in a scrollable list, usually just off-screen
    rather than actually missing — the same real gap SCROLL_TO_TEXT exists to
    close when authored explicitly, just applied automatically so a plain TAP
    on an item further down a list doesn't need every test to spell out its
    own scroll step first. Only retried for text/text_contains — the other
    strategies (resource-id, accessibility-id, ...) don't have a text value
    to hand UiScrollable, and xpath/class_name lookups are positional, so
    scrolling wouldn't change whether they resolve."""
    from selenium.common.exceptions import NoSuchElementException

    try:
        return _find_by_strategy_once(driver, strategy, value, prefer_clickable=prefer_clickable)
    except NoSuchElementException:
        if strategy not in ("text", "text_contains") or not _scroll_into_view(driver, value):
            raise
        return _find_by_strategy_once(driver, strategy, value, prefer_clickable=prefer_clickable)


def _scroll_into_view(driver, text: str, max_swipes: int = 8) -> bool:
    """Swipe up, checking after each swipe, until `text` appears somewhere in
    the hierarchy or `max_swipes` is exhausted. Returns whether it was found.

    Deliberately NOT UiScrollable's own scrollIntoView: that swipes within
    whatever bounds the scrollable container itself reports, which on a
    gesture-navigation device (no on-screen back/home buttons, swipe up from
    the very bottom edge instead) can start or end inside the OS's bottom
    gesture strip — turning what's meant to be a content scroll into a
    system "go home" gesture and exiting the app entirely mid-test. Confirmed
    live: this is exactly what happened before this fix. Swiping within an
    explicit 10%-90% vertical box (mirroring the existing generic SWIPE
    action's own safe bounds) keeps every touch point well clear of that
    strip regardless of device or screen size — nothing app-specific here."""
    from selenium.common.exceptions import NoSuchElementException
    text = text.strip()
    if not text:
        return False

    for _ in range(max_swipes):
        try:
            nodes = parse_hierarchy(capture_hierarchy_xml(driver))
        except Exception:
            return False
        if any(text in (n.attrs.get("text") or "") or text in (n.attrs.get("content-desc") or "") for n in nodes):
            return True
        try:
            size = driver.get_window_size()
            driver.execute_script("mobile: swipeGesture", {
                "left": int(size["width"] * 0.1), "top": int(size["height"] * 0.1),
                "width": int(size["width"] * 0.8), "height": int(size["height"] * 0.8),
                "direction": "up", "percent": 0.75,
            })
            wait_for_stable_content(driver, timeout_ms=4000)
        except Exception:
            return False

    try:
        nodes = parse_hierarchy(capture_hierarchy_xml(driver))
        return any(text in (n.attrs.get("text") or "") or text in (n.attrs.get("content-desc") or "") for n in nodes)
    except Exception:
        return False


def _find_by_strategy_once(driver, strategy: str, value: str, prefer_clickable: bool = False):
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
            pass  # fall through below

        # No element has this exact text AND is itself clickable — the
        # common real cause is a card/list-item pattern where the text is a
        # plain, non-interactive label and the actionable region is a
        # sibling (an image) or ancestor (the card) instead. Rather than
        # returning that non-clickable label as-is and letting a coordinate
        # tap land on dead space, look for the nearest genuinely clickable
        # element to wherever that label actually sits — same "which card is
        # this" reasoning AutoHeal's candidate scoring uses, just applied up
        # front so a plain "tap the item named X" locator resolves correctly
        # on the first try instead of needing a failure+heal round trip.
        # Generic: works for any repeated-card/list layout, not this app.
        try:
            anchor = driver.find_element(by, val)
        except (NoSuchElementException, InvalidSelectorException):
            anchor = None
        if anchor is not None:
            neighbor = _nearest_clickable_neighbor(driver, anchor)
            if neighbor is not None:
                return neighbor
            return anchor

    return driver.find_element(by, val)


def _nearest_clickable_neighbor(driver, anchor_element, radius: float = 500.0):
    """The nearest clickable element to `anchor_element`'s position, or None
    if nothing genuinely clickable is within `radius` px. Used when a literal
    text match resolved to a non-interactive label — the actionable control
    for that label (an image, an icon, an enclosing card) is usually its
    nearest clickable neighbor on screen, not the label itself."""
    try:
        rect = anchor_element.rect
        ax, ay = rect["x"] + rect["width"] / 2.0, rect["y"] + rect["height"] / 2.0
    except Exception:
        return None

    try:
        nodes = parse_hierarchy(capture_hierarchy_xml(driver))
    except Exception:
        return None

    # A small icon-sized control (a star in a rating widget, a badge) often
    # sits even closer to a card's title than the card's own main content
    # region (its image) does — pure nearest-distance would prefer the small
    # control every time, which is backwards for "what does this label
    # represent." A substantial content region is the more reliable signal
    # of "the thing this label names" when one is available at all; only
    # fall back to whatever's nearest, regardless of size, when nothing
    # roomy exists nearby (a plain icon-only list row, say). No size or
    # count here is app-specific — this is just "prefer real content over a
    # small decorative control" as a general layout heuristic.
    SUBSTANTIAL_AREA_PX2 = 15000.0
    candidates = []
    for n in nodes:
        if n.attrs.get("clickable") != "true":
            continue
        box = n.bounds_box
        if not box:
            continue
        ncx, ncy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
        d = ((ncx - ax) ** 2 + (ncy - ay) ** 2) ** 0.5
        # Reject an exact/near-exact overlap with the anchor's own position —
        # that would just be the anchor's own clickable ancestor container,
        # which the earlier `.clickable(true)` attempt already ruled out as
        # not matching the text search; a real "different, nearby control"
        # sits recognizably off to the side, not stacked on the same spot.
        if d < 5 or d >= radius:
            continue
        area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
        candidates.append((d, area, n))

    if not candidates:
        return None
    substantial = [c for c in candidates if c[1] >= SUBSTANTIAL_AREA_PX2]
    pool = substantial or candidates
    best_node = min(pool, key=lambda c: c[0])[2]

    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException
    # Positional XPath first, not resource-id: a repeated-card layout is
    # exactly the case that led here, and every card's control shares the
    # SAME resource-id — looking it up by ID again would silently grab the
    # first card on screen regardless of which one was actually closest.
    # The positional path is how the specific matched instance survives.
    if best_node.path:
        try:
            return driver.find_element(AppiumBy.XPATH, best_node.path)
        except NoSuchElementException:
            pass
    rid = best_node.attrs.get("resource-id")
    if rid:
        try:
            return driver.find_element(AppiumBy.ID, rid)
        except NoSuchElementException:
            pass
    return None


import difflib as _difflib


def _label_tokens(value: str) -> set:
    if not value:
        return set()
    value = re.sub(r"[._/\-]", " ", value)
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", value)
    return {t for t in re.split(r"\s+", value.lower()) if len(t) > 1}


# English function words carry no identifying content of their own — "to" in
# a hint ("the icon TO open the cart") matching "to" inside an unrelated
# element's own text ("Tap TO add...") is coincidence, not evidence, yet a
# bare token-overlap count treats it exactly like a real shared content word.
# Small, fixed, and language-generic — not tuned to any one hint or app.
_STOPWORDS = {"the", "a", "an", "to", "of", "on", "in", "is", "at", "for", "and", "or", "with", "this", "that"}


# ── Screen-level semantic verification ──────────────────────────────────
# A semantic WAIT_FOR_ELEMENT locator sometimes names a whole SCREEN ("the
# product detail screen") rather than one element ("the submit button").
# resolve_by_hint below is built to find one element whose OWN text/
# content-desc/nearby-label matches the hint — but a screen very often never
# spells its own name out verbatim anywhere on itself (a product detail page
# doesn't literally say "detail" anywhere), so that per-element matcher
# systematically fails on a screen that in fact loaded correctly. This is a
# different, screen-level check: generic and app-agnostic, not tuned to any
# one screen name or app.

_SCREEN_SUFFIX_WORDS = {"screen", "page", "view", "tab", "dialog", "modal", "sheet"}
_SCREEN_STOPWORDS = {"the", "a", "an", "this", "that", "current", "new"}


def looks_like_screen_locator(value: Optional[str]) -> bool:
    """True when `value`'s own LAST word is a generic screen/page noun — the
    vocabulary a test author or an AI generator naturally uses for "we should
    now be looking at X" ('the product detail screen', 'the settings page').
    Purely lexical, no app knowledge."""
    value = (value or "").strip().lower()
    if not value:
        return False
    last_word = re.split(r"\s+", value)[-1]
    return last_word in _SCREEN_SUFFIX_WORDS


def _screen_meaningful_tokens(value: str) -> set:
    """The screen name's own content words — everything except the generic
    trailing noun ('screen'/'page'/...) and stopwords, which carry no
    identifying signal of their own."""
    return {t for t in _label_tokens(value) if t not in _SCREEN_SUFFIX_WORDS and t not in _SCREEN_STOPWORDS}


def _hierarchy_text_tokens(nodes: List["ElementNode"]) -> set:
    tokens: set = set()
    for n in nodes:
        for attr in ("text", "content-desc"):
            v = n.attrs.get(attr)
            if v:
                tokens |= _label_tokens(v)
    return tokens


def wait_for_screen(
    driver, screen_name: str, timeout_ms: int,
    before_signature: Optional[str] = None, poll_interval_s: float = 0.4,
) -> bool:
    """"Are we on the right screen?" — combines two fully generic signals
    that together are hard to satisfy by accident, without requiring any
    single element to literally spell out the screen's own name:

      1. keyword recall — does at least one of the screen name's own
         meaningful words appear ANYWHERE in the current hierarchy's visible
         text/content-desc, spread across any number of elements (not
         necessarily one)?
      2. structural change — has the screen actually changed from the
         snapshot captured right before this step began (real navigation
         happened), when a before-snapshot is available at all?

    Both must hold when a before-snapshot is given — keyword recall alone
    would accept "the same unrelated screen that happens to mention one
    shared word"; a bare screen change alone would accept "navigated to
    literally anywhere." Neither check depends on any specific app, screen
    name, or element."""
    deadline = time.time() + timeout_ms / 1000.0
    wanted = _screen_meaningful_tokens(screen_name)
    if not wanted:
        return False
    while time.time() < deadline:
        try:
            nodes = parse_hierarchy(capture_hierarchy_xml(driver))
        except Exception:
            time.sleep(poll_interval_s)
            continue
        if wanted & _hierarchy_text_tokens(nodes):
            if before_signature is None:
                return True
            try:
                current_signature = build_screen_signature(
                    get_current_package(driver) or "", get_current_activity(driver), nodes,
                )
            except Exception:
                current_signature = None
            if current_signature is None or current_signature != before_signature:
                return True
        time.sleep(poll_interval_s)
    return False


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
    htok_raw = _label_tokens(hint)
    htok = htok_raw - _STOPWORDS

    # How many of this screen's own elements share a given token — Android
    # resource-ids very commonly follow an {entity}{RoleAbbrev} convention
    # ("productTV", "productIV", "productRV" all sharing "product" even
    # though they are a title, an image, and a list), so a word appearing in
    # MANY elements' own identity is weak, non-distinguishing evidence, while
    # one appearing in only one or two is strong. Purely statistical over
    # THIS screen's own elements at this moment — no app-specific knowledge.
    # Deliberately conservative: only heavily-shared tokens (3+ elements) are
    # discounted; anything less common keeps its original full weight, so
    # this can only ever reduce a false match's score, never inflate one.
    _token_df: Dict[str, int] = {}
    for _n in visible:
        _own = " ".join(filter(None, [_n.attrs.get("text", ""), _n.attrs.get("content-desc", ""), _n.attrs.get("resource-id", "")]))
        for _t in _label_tokens(_own):
            _token_df[_t] = _token_df.get(_t, 0) + 1

    def _token_weight(t: str) -> float:
        return 0.34 if _token_df.get(t, 1) >= 3 else 1.0

    # Excludes clickable elements: nearest-label borrowing exists for the
    # unlabelled-input-next-to-its-static-caption pattern (a passive TextView
    # describing a neighboring EditText), where the caption is never itself a
    # separate control. A clickable neighbor is a DIFFERENT, independently
    # actionable element (e.g. two icons sitting side by side in a toolbar —
    # a sort icon next to a cart icon), not a caption for this one, so
    # borrowing its text/content-desc as if it described the node next to it
    # produces exactly the kind of false match that let an unrelated icon
    # "impersonate" its neighbor's label. Same rule for any app: a header
    # with several adjacent icon buttons is an extremely common layout.
    labels = [n for n in visible if (n.attrs.get("text") or n.attrs.get("content-desc")) and n.attrs.get("clickable") != "true"]

    # A label can also be an OWNED descendant of some other clickable control
    # (a decorative icon or count badge nested a level or two inside a
    # DIFFERENT button) rather than a free caption of its own — e.g. a "shows
    # cart contents" icon nested inside the cart button, sitting physically
    # close enough to also read as "nearest" to a completely unrelated
    # sibling button (a sort icon next to it in the same toolbar). Group every
    # node under the path of its nearest clickable ancestor-or-self, using the
    # hierarchy's own positional-xpath `path` (a literal path prefix means a
    # literal ancestor) — no coordinates or app knowledge involved — so a
    # label only counts as "for" a node when they share that owner, blocking
    # a label from being borrowed across sibling controls it doesn't belong
    # to, the same way the plain clickable-neighbor exclusion above blocks a
    # label from being borrowed FROM one.
    clickable_paths = sorted(
        (n.path for n in visible if n.attrs.get("clickable") == "true" and n.path),
        key=len, reverse=True,
    )

    def _owner_group(path: str) -> Optional[str]:
        if not path:
            return None
        for cp in clickable_paths:
            if path == cp or path.startswith(cp + "/"):
                return cp
        return None

    def nearest_label_text(node) -> str:
        box = node.bounds_box
        if not box:
            return ""
        node_group = _owner_group(node.path)
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        best, best_d = "", 1e9
        for lb in labels:
            if lb is node:
                continue
            lb_group = _owner_group(lb.path)
            if lb_group is not None and lb_group != node_group:
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
        # Nearest-label borrowing exists for ONE pattern (see its own
        # docstring): an element with no text/content-desc of its own — an
        # icon, an unlabelled input — reading a nearby caption as if it were
        # its label. An element that already HAS real text/content-desc
        # speaks for itself and should never borrow a neighbor's — that's
        # not filling a gap, it's contaminating a real signal with an
        # unrelated one. Confirmed live: a long descriptive paragraph with
        # its own complete sentence outscored the actual "Login" button
        # purely because a page-title heading ("Login") happened to sit
        # within the proximity radius — the paragraph never needed to
        # borrow anything, it already had 140+ characters of its own text.
        own_has_identity = bool((n.attrs.get("text") or "").strip() or (n.attrs.get("content-desc") or "").strip())
        # element_role() falls through to "other" for anything that is not
        # editable, not a toggle, not clickable, not an image, and has no
        # text/content-desc of its own — a bare layout container (FrameLayout,
        # LinearLayout, DrawerLayout, ...) or stray system-chrome view
        # (navigationBarBackground) always lands here. Its bounding box
        # routinely spans most of the screen, so its centroid can sit
        # "nearest" to almost any label purely by chance of geometry — letting
        # it "borrow" an unrelated element's identity and win purely on a
        # coincidence of layout, not any real relationship to that label.
        # Confirmed live: every ancestor container from the screen root down
        # to an unrelated image's own wrapper tied for the TOP score on an
        # unrelated hint, all having borrowed that image's content-desc this
        # way — beating the real target and resolving to an unlocatable
        # structural node instead. A CLICKABLE container (role "button" — a
        # whole card acting as one) is deliberately not excluded here: that
        # is a genuine, common UI target, not layout chrome.
        near = "" if (own_has_identity or element_role(n) == "other") else nearest_label_text(n)
        near_tok = _label_tokens(near)
        overlap = sum(_token_weight(t) for t in (htok & (own_tok | near_tok)))
        # Text is not the only place an element states its own identity —
        # content-desc is exactly as valid, and for an icon-only control
        # (no visible text at all, e.g. a header's cart icon) it is the ONLY
        # place. Comparing ratio against text alone structurally starves
        # every icon-only control of this signal while a nearby text-labelled
        # control gets it for free — not because the text-labelled one is a
        # better match, only because it happens to have a `text` attribute.
        ratio = max(
            _difflib.SequenceMatcher(None, hint.lower(), (n.attrs.get("text") or "").lower()).ratio() if n.attrs.get("text") else 0.0,
            _difflib.SequenceMatcher(None, hint.lower(), (n.attrs.get("content-desc") or "").lower()).ratio() if n.attrs.get("content-desc") else 0.0,
            _difflib.SequenceMatcher(None, hint.lower(), near.lower()).ratio() if near else 0.0,
        )
        s = overlap * 3 + ratio * 2
        if want_role == "input" and role == "input":
            s += 1.0  # a matching role is itself evidence when the hint is thin
        if want_role in ("button", "toggle") and role in ("button", "toggle"):
            # Same principle as the input bonus above, applied to the other
            # side of a real, generic ambiguity: a screen's own page-title
            # heading legitimately shares the same word as its submit button
            # ("Login" heading, "Login" button) and can score identically on
            # text/token match alone — confirmed live, an exact tie that fell
            # to whichever happened to sit earlier in the hierarchy (the
            # heading, not the button). want_role="button" already means
            # "this step needs to actually DO something," so a candidate
            # that's genuinely clickable/toggleable is strictly better
            # evidence than a same-scoring plain text label for that —
            # without this, a text-role candidate is never even at a
            # disadvantage in a tie it has no business winning.
            s += 1.0
        # A hint's own wording often states the expected WIDGET TYPE, not
        # just its content ("the ICON to open the cart" vs "the ADD TO CART
        # BUTTON") — a real, conventional Button widget is rarely what a
        # human/AI author calls "an icon." Confirmed live: on a screen with
        # both a labelled "Add to cart" Button and an unlabelled cart-icon
        # control, both matched the token "cart" equally, and only this
        # signal correctly favored the icon over the button for an
        # icon-hinted step. Generic — keys off the hint's own vocabulary and
        # the element's own class, not any specific app or screen.
        if "icon" in htok_raw and "Button" not in n.attrs.get("class", "") and role in ("button", "toggle", "image"):
            s += 1.0
        if s > 0:
            scored.append((s, n))

    if not scored:
        raise NoSuchElementException(f"resolve_by_hint: nothing matched hint {hint!r} (role={want_role})")
    scored.sort(key=lambda x: x[0], reverse=True)
    best_score, best_node = scored[0]
    # A bare "s > 0" let through near-zero-signal matches — a single stray
    # fuzzy-ratio point from an otherwise unrelated element (wrong text, wrong
    # resource-id, wrong neighbor) used to be accepted just as readily as a
    # real match, silently binding the step to whatever screen junk happened
    # to score highest. MIN_CONFIDENT_SCORE is the floor a genuine match
    # reliably clears — one shared token (overlap=1 -> 3.0), a strong fuzzy
    # match (ratio>=0.5 -> 1.0), or a role match on a thin input hint (1.0) —
    # while pure noise (a few incidentally-shared characters) stays under it.
    # Below it, this is honestly "nothing matched" and should raise the same
    # as an empty candidate list, so AutoHeal takes over instead of the step
    # silently asserting against the wrong element. Generic: no app, screen,
    # or hint text is special-cased here.
    MIN_CONFIDENT_SCORE = 1.0
    if best_score < MIN_CONFIDENT_SCORE:
        raise NoSuchElementException(
            f"resolve_by_hint: best candidate for hint {hint!r} scored {best_score:.2f}, "
            f"below the confidence floor ({MIN_CONFIDENT_SCORE}) — treating as not found."
        )

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


def tap_element(driver, element) -> bool:
    """Real touch simulation, not just a semantic click. Proven bug: Appium's
    element.click() can return success on a non-clickable element WITHOUT
    throwing and WITHOUT the app actually responding (the accessibility click
    action silently no-ops) — so checking for an exception is not enough to
    tell whether anything happened. If the element doesn't report itself as
    clickable, skip .click() and go straight to a coordinate-based W3C tap,
    which is a genuine touch event that Android's normal hit-testing will
    route to whatever is really interactive at that screen position (e.g. a
    clickable parent card wrapping a plain text label) — exactly what a real
    user's finger does. Generic: no app-specific logic involved.

    Returns True when the coordinate-tap fallback was used — the caller uses
    this to decide whether it's worth confirming the tap actually did
    anything, since that path has no built-in success signal the way
    element.click() raising an exception would (a coordinate tap "succeeds"
    even when it lands on dead space, e.g. a plain text label positioned
    outside any clickable container, not just inside one)."""
    is_clickable = False
    try:
        is_clickable = element.get_attribute("clickable") == "true"
    except Exception:
        pass

    if is_clickable:
        try:
            element.click()
            return False
        except Exception:
            pass

    try:
        rect = element.rect
        x = rect["x"] + rect["width"] // 2
        y = rect["y"] + rect["height"] // 2
        driver.tap([(x, y)], 50)
        return True
    except Exception:
        # last resort — the semantic click, even though clickable=false
        # suggested it might not do anything.
        element.click()
        return False


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
