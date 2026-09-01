"""
App explorer — a bounded, application-agnostic crawl of an APK on a real
device that produces a **ScreenMap**: the app's actual screens, the real
interactive elements on each, and the tap-path to reach each screen from a
cold launch.

Why this exists: AI test generation is only as good as its knowledge of the
app. Given nothing, the model invents locators (`text:"unknown_identifier"`)
that are guaranteed to fail. Given a ScreenMap built from the live
accessibility tree, it can only ever pick elements that provably exist and
must spell out the navigation to get to them.

Everything here is generic — it walks the standard UiAutomator2 view tree
(`resource-id` / `text` / `content-desc` / widget class), never anything
specific to a particular app. Works the same for a native, Compose, or
React-Native build; a Flutter build will simply yield a near-empty map
(correctly signalling "locator automation won't work here").
"""
from __future__ import annotations

import datetime
import time
from typing import Any, Dict, List, Optional

from mobile.locators import (
    ElementNode,
    build_screen_signature,
    capture_hierarchy_xml,
    element_role,
    get_current_activity,
    get_current_package,
    is_editable,
    is_meaningful_node,
    parse_hierarchy,
    tap_element,
    wait_for_stable_content,
)
from utils.logger import get_logger

logger = get_logger("mobile.explorer")

# Elements that just navigate backwards / open menus — following them wastes
# crawl budget and creates loops. Matched loosely, case-insensitively.
_SKIP_TAP_LABELS = {"back", "navigate up", "close", "cancel", "menu", "open navigation drawer", "more options"}


def _best_locator(node: ElementNode) -> Dict[str, Optional[str]]:
    a = node.attrs
    hint = (a.get("content-desc") or a.get("text") or "").strip() or None
    rid = a.get("resource-id")
    if rid:
        return {"strategy": "resource_id", "value": rid, "hint": hint}
    if a.get("content-desc"):
        return {"strategy": "accessibility_id", "value": a["content-desc"], "hint": hint}
    if a.get("text"):
        return {"strategy": "text", "value": a["text"].strip(), "hint": hint}
    return {"strategy": "xpath", "value": node.path or f"//{a.get('class','*')}", "hint": hint}


def _summarize_element(node: ElementNode) -> Dict[str, Any]:
    loc = _best_locator(node)
    return {
        "strategy": loc["strategy"],
        "value": loc["value"],
        "hint": loc["hint"],
        "role": element_role(node),
        "clickable": node.attrs.get("clickable") == "true",
        "editable": is_editable(node),
        "class": node.attrs.get("class", "").split(".")[-1],
    }


def _screen_title(nodes: List[ElementNode]) -> str:
    """Best-effort human label for a screen: the topmost non-trivial text."""
    texts = []
    for n in nodes:
        t = (n.attrs.get("text") or "").strip()
        box = n.bounds_box
        if t and 1 < len(t) < 60 and box:
            texts.append((box[1], t))
    texts.sort()
    return texts[0][1] if texts else (get_current_activity(None) or "screen")


def _interactive_elements(nodes: List[ElementNode]) -> List[ElementNode]:
    out = []
    for n in nodes:
        role = element_role(n)
        if role in ("button", "input", "toggle") or n.attrs.get("clickable") == "true":
            box = n.bounds_box
            if box and (box[2] - box[0]) > 0 and (box[3] - box[1]) > 0:
                out.append(n)
    return out


def _tap_targets(nodes: List[ElementNode], limit: int) -> List[ElementNode]:
    seen = set()
    targets = []
    for n in _interactive_elements(nodes):
        if is_editable(n):
            continue
        label = (n.attrs.get("text") or n.attrs.get("content-desc") or n.attrs.get("resource-id") or "").strip()
        if label.lower() in _SKIP_TAP_LABELS:
            continue
        key = label or n.path
        if key in seen:
            continue
        seen.add(key)
        targets.append(n)
        if len(targets) >= limit:
            break
    return targets


def _relaunch(driver, package: str) -> None:
    try:
        driver.execute_script("mobile: terminateApp", {"appId": package})
    except Exception:
        pass
    driver.execute_script("mobile: activateApp", {"appId": package})
    wait_for_stable_content(driver, timeout_ms=15000)


def _replay(driver, package: str, path: List[Dict[str, Any]]) -> bool:
    """Cold-launch and replay a tap path. Returns True if every step landed."""
    from mobile.locators import resolve_element
    from mobile.schemas import Locator

    _relaunch(driver, package)
    for step in path:
        try:
            loc = Locator(**step["locator"])
            el = resolve_element(driver, loc, prefer_clickable=True, want_role="button")
            tap_element(driver, el)
            wait_for_stable_content(driver, timeout_ms=6000, min_meaningful=2)
        except Exception as exc:
            logger.info("explore: replay step failed (%s) — pruning branch", exc)
            return False
    return True


def explore_app(
    driver,
    package: str,
    *,
    max_screens: int = 14,
    max_depth: int = 3,
    taps_per_screen: int = 6,
    time_budget_s: int = 210,
) -> Dict[str, Any]:
    """BFS crawl from a cold launch. Each queue entry is a tap-path; we
    relaunch and replay it to reach that screen deterministically (back-stack
    navigation is not reliable across frameworks). Bounded on screens, depth,
    and wall-clock time so it can't run away on a large app."""
    started = time.time()
    screens: List[Dict[str, Any]] = []
    visited: set = set()
    queue: List[List[Dict[str, Any]]] = [[]]

    while queue and len(screens) < max_screens and (time.time() - started) < time_budget_s:
        path = queue.pop(0)

        if path and not _replay(driver, package, path):
            continue
        if not path:
            _relaunch(driver, package)

        try:
            nodes = parse_hierarchy(capture_hierarchy_xml(driver))
        except Exception as exc:
            logger.warning("explore: hierarchy capture failed: %s", exc)
            continue

        if get_current_package(driver) not in (package, None):
            continue  # a tap left the app under test — don't map foreign screens

        sig = build_screen_signature(package, get_current_activity(driver), nodes)
        if sig in visited:
            continue
        visited.add(sig)

        depth = len(path)
        meaningful = [n for n in nodes if is_meaningful_node(n)]
        elements = [_summarize_element(n) for n in _interactive_elements(nodes)]
        # also expose pure text so the model knows what a screen *says*
        static_text = sorted({(n.attrs.get("text") or "").strip() for n in meaningful if (n.attrs.get("text") or "").strip()})[:40]

        screens.append({
            "sig": sig,
            "title": _screen_title(nodes),
            "activity": get_current_activity(driver),
            "depth": depth,
            "reached_by": path,
            "elements": elements,
            "static_text": static_text,
        })
        logger.info("explore: mapped screen '%s' (depth %d, %d interactive elements)", screens[-1]["title"], depth, len(elements))

        if depth < max_depth:
            for target in _tap_targets(nodes, taps_per_screen):
                queue.append(path + [{"action": "TAP", "locator": _best_locator(target)}])

    result = {
        "package": package,
        "captured_at": datetime.datetime.utcnow().isoformat(),
        "screen_count": len(screens),
        "screens": screens,
        "truncated": bool(queue) or len(screens) >= max_screens,
    }
    logger.info("explore: done — %d screens in %.0fs", len(screens), time.time() - started)
    return result


def run_exploration(application_version_id: int, device_id: int) -> Dict[str, Any]:
    """Full lifecycle: reserve device → Appium server + session → crawl →
    persist the ScreenMap onto the MobileApplicationVersion → tear everything
    down. Mirrors mobile/engine.run_execution's setup so exploration reuses
    the exact same device/session machinery. Safe to call in a background
    thread. Returns the screen map."""
    from mobile import device_manager
    from mobile.appium_manager import create_uiautomator2_session, quit_session, start_server, stop_server
    from mobile.database import SessionLocal
    from mobile.models import MobileApplication, MobileApplicationVersion, MobileDevice

    db = SessionLocal()
    driver = None
    appium_handle = None
    device = None
    try:
        version = db.get(MobileApplicationVersion, application_version_id)
        if version is None:
            raise RuntimeError(f"application version {application_version_id} not found")
        application = db.get(MobileApplication, version.application_id)
        device = db.get(MobileDevice, device_id)
        if device is None:
            raise RuntimeError(f"device {device_id} not found")

        device_manager.reserve_device(db, device.id, f"explore-v{application_version_id}")
        health = device_manager.health_check(device.serial)
        if not health["healthy"]:
            raise RuntimeError(f"device failed health check: {health}")

        appium_handle = start_server()
        driver = create_uiautomator2_session(
            appium_handle.base_url, device.serial,
            app_path=version.file_path, app_package=application.package_name,
            app_activity=version.launchable_activity, no_reset=False,
        )

        screen_map = explore_app(driver, application.package_name)

        version.screen_map = screen_map
        version.screen_map_captured_at = datetime.datetime.utcnow()
        db.commit()
        logger.info("explore: persisted ScreenMap (%d screens) for %s v%s",
                    screen_map["screen_count"], application.package_name, version.version_name)
        return screen_map
    finally:
        try:
            quit_session(driver)
        except Exception:
            pass
        try:
            if appium_handle:
                stop_server(appium_handle)
        except Exception:
            pass
        try:
            if device:
                device_manager.release_device(db, device.id)
        except Exception:
            pass
        db.close()


def compact_for_prompt(screen_map: Dict[str, Any], max_elements_per_screen: int = 25) -> str:
    """Render a ScreenMap as compact text for the generation prompt — real
    screens, real elements, real navigation paths, nothing invented."""
    if not screen_map or not screen_map.get("screens"):
        return ""
    lines: List[str] = []
    for i, s in enumerate(screen_map["screens"]):
        nav = " -> ".join(
            f'TAP {st["locator"].get("value") or st["locator"].get("hint")}' for st in s.get("reached_by", [])
        ) or "app launch (entry screen)"
        lines.append(f'### Screen {i}: "{s["title"]}"  (reach: {nav})')
        if s.get("static_text"):
            lines.append("  visible text: " + " | ".join(s["static_text"][:15]))
        for el in s.get("elements", [])[:max_elements_per_screen]:
            tag = "input" if el["editable"] else el["role"]
            lines.append(f'  - [{tag}] {el["strategy"]}={el["value"]!r}' + (f'  ({el["hint"]})' if el.get("hint") and el["hint"] != el["value"] else ""))
    return "\n".join(lines)
