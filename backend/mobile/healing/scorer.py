"""
Deterministic candidate scoring (section 65). Weights are configuration-
driven constants here (not hardcoded per-app conditions) and versioned via
ALGORITHM_VERSION so healing records stay reproducible/auditable.
"""
from __future__ import annotations

import difflib
import re
from typing import Dict, List, Optional

from mobile.locators import ElementNode

ALGORITHM_VERSION = "1.0.0"

WEIGHTS = {
    "exact_resource_id": 35,
    "exact_accessibility_id": 35,
    "exact_content_desc": 30,
    "exact_text": 25,
    "fuzzy_text": 10,        # scaled by similarity ratio
    "fuzzy_resource_id": 15,  # scaled by token overlap
    "class_match": 10,
    "hint_semantic_match": 12,
    "historical_locator_reuse": 25,
    "historical_healing_success": 30,
}
PENALTIES = {
    "coordinate_only": -30,
    "not_clickable_for_interactive_action": -20,
    "outside_visible_bounds": -20,
}


def _tokenize(value: str) -> List[str]:
    if not value:
        return []
    # split snake_case, camelCase, kebab-case, and dots/slashes (e.g. resource-id ids)
    value = re.sub(r"[._/\-]", " ", value)
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", value)
    return [t.lower() for t in value.split() if t]


def _fuzzy_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _token_overlap(a: str, b: str) -> float:
    ta, tb = set(_tokenize(a)), set(_tokenize(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def score_candidate(
    node: ElementNode,
    original_value: str,
    original_strategy: str,
    hint: Optional[str],
    requires_interactive: bool,
    historical_locator: Optional[Dict[str, str]] = None,
    historically_successful_before: bool = False,
) -> Dict[str, object]:
    """Score one live element as a healing candidate for a broken locator.
    Returns {"score": float 0-100, "signals": {...}}."""
    a = node.attrs
    signals: Dict[str, float] = {}
    score = 0.0

    resource_id = a.get("resource-id", "")
    content_desc = a.get("content-desc", "")
    text = a.get("text", "")
    klass = a.get("class", "")

    # Resource-id: exact match is the strongest single signal; a near-exact
    # rename (one token added/changed — the common real-world case, e.g.
    # "login_button" -> "sign_in_button") should score close to, not a third
    # of, an exact match — it's continuous evidence of the same identity,
    # not a categorically weaker one.
    if resource_id and (resource_id == original_value or resource_id.endswith(f"id/{original_value}")):
        score += WEIGHTS["exact_resource_id"]; signals["exact_resource_id"] = True
    elif resource_id:
        overlap = _token_overlap(resource_id, original_value)
        if hint:
            overlap = max(overlap, _token_overlap(resource_id, hint))
        if overlap > 0.3:
            score += WEIGHTS["exact_resource_id"] * overlap * 0.9
            signals["fuzzy_resource_id"] = round(overlap, 3)

    # Content-desc backs Android's accessibility-id lookup strategy (section 19
    # ranks accessibility identity above resource id), so an exact content-desc
    # match to the locator's own value — or to the step's declared semantic
    # hint — is scored at that same top tier, not a discounted fuzzy tier.
    if content_desc and content_desc == original_value:
        score += WEIGHTS["exact_accessibility_id"]; signals["exact_accessibility_id"] = True
    elif content_desc and hint and _fuzzy_ratio(content_desc, hint) > 0.6:
        ratio = _fuzzy_ratio(content_desc, hint)
        score += WEIGHTS["exact_accessibility_id"] * ratio
        signals["content_desc_hint_match"] = round(ratio, 3)

    if text and text == original_value:
        score += WEIGHTS["exact_text"]; signals["exact_text"] = True
    elif text:
        ratio = max(_fuzzy_ratio(text, original_value), _fuzzy_ratio(text, hint or ""))
        if ratio > 0.5:
            score += WEIGHTS["fuzzy_text"] * ratio
            signals["fuzzy_text"] = round(ratio, 3)

    # Hint-vs-resource-id is scored separately from hint-vs-content-desc
    # (already folded into the accessibility-tier signal above) to avoid
    # double-counting the same evidence under two weight buckets.
    if hint:
        hint_ratio = max(_fuzzy_ratio(text, hint), _token_overlap(resource_id, hint))
        if hint_ratio > 0.5:
            score += WEIGHTS["hint_semantic_match"] * hint_ratio
            signals["hint_semantic_match"] = round(hint_ratio, 3)

    if original_strategy == "class_name" and klass == original_value:
        score += WEIGHTS["class_match"]; signals["class_match"] = True

    if historical_locator and historical_locator.get("value") in (resource_id, content_desc, text):
        score += WEIGHTS["historical_locator_reuse"]; signals["historical_locator_reuse"] = True
        if historically_successful_before:
            score += WEIGHTS["historical_healing_success"]; signals["historical_healing_success"] = True

    if requires_interactive and a.get("clickable") != "true" and a.get("checkable") != "true":
        score += PENALTIES["not_clickable_for_interactive_action"]
        signals["not_clickable"] = True

    box = node.bounds_box
    if not box or (box[2] - box[0] <= 0) or (box[3] - box[1] <= 0):
        score += PENALTIES["outside_visible_bounds"]
        signals["degenerate_bounds"] = True

    return {"score": max(0.0, min(100.0, score)), "signals": signals}
