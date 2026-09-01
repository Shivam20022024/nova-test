"""
Selector utilities for self-healing.
"""
from __future__ import annotations

import re
from typing import List

from playwright.async_api import Page

INTENT_KEYWORDS = ["error", "alert", "invalid", "warning", "success"]


def _dedupe_keep_order(values: List[str]) -> List[str]:
    seen: set[str] = set()
    output: List[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            output.append(value)
    return output


def _is_token_safe(token: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+", token))


def score_selector(selector: str) -> int:
    """Score selector according to healing rules."""
    value = selector.lower()
    score = 0

    if "error" in value:
        score += 5
    if "alert" in value:
        score += 4
    if selector.startswith("#"):
        score += 4
    if selector.startswith("."):
        score += 2
    if "*=" in selector:
        score += 1
    return score


def score_selector_quality(selector: str) -> int:
    """
    Deterministic selector quality score used to prevent quality downgrade.

    Rules:
    - id selector (#id): +5
    - data-testid selector: +4
    - class combination (.a.b): +3
    - single class (.a): +2
    - nth-child usage: +1
    """
    value = (selector or "").strip()
    if not value:
        return 0

    score = 0
    if value.startswith("#"):
        score += 5
    if "data-testid" in value:
        score += 4
    if value.startswith("."):
        class_parts = [part for part in value.split(".") if part]
        if len(class_parts) >= 2:
            score += 3
        elif len(class_parts) == 1:
            score += 2
    if "nth-child" in value:
        score += 1
    return score


async def generate_candidates_from_dom(page: Page) -> List[str]:
    """Generate selector candidates from current DOM state."""
    candidates: List[str] = []

    try:
        id_handles = await page.query_selector_all("[id]")
        for handle in id_handles[:200]:
            element_id = (await handle.get_attribute("id")) or ""
            element_id = element_id.strip()
            if element_id and _is_token_safe(element_id):
                candidates.append(f"#{element_id}")
    except Exception:
        pass

    try:
        class_values = await page.eval_on_selector_all(
            "[class]",
            """
            (els) => els
                .map((el) => el.className || "")
                .filter(Boolean)
                .slice(0, 500)
            """,
        )
        for class_value in class_values or []:
            for token in str(class_value).split():
                token = token.strip()
                if token and _is_token_safe(token):
                    candidates.append(f".{token}")
                    lowered = token.lower()
                    for keyword in INTENT_KEYWORDS:
                        if keyword in lowered:
                            candidates.append(f"[class*='{keyword}']")
    except Exception:
        pass

    try:
        role_values = await page.eval_on_selector_all(
            "[role]",
            "(els) => els.map((el) => el.getAttribute('role')).filter(Boolean).slice(0, 200)",
        )
        for role in role_values or []:
            role_value = str(role).strip()
            if role_value and _is_token_safe(role_value):
                candidates.append(f"[role='{role_value}']")
    except Exception:
        pass

    try:
        text_values = await page.eval_on_selector_all(
            "*",
            """
            (els) => {
                const out = [];
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    const visible =
                        style &&
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        el.getBoundingClientRect().width > 0 &&
                        el.getBoundingClientRect().height > 0;
                    if (!visible) continue;
                    const text = (el.innerText || el.textContent || "").trim();
                    if (!text) continue;
                    if (text.length > 60) continue;
                    out.push(text.split("\\n")[0].trim());
                    if (out.length >= 120) break;
                }
                return out;
            }
            """,
        )
        for text in text_values or []:
            text_value = str(text).strip()
            if text_value and "'" not in text_value:
                candidates.append(f"text={text_value}")
    except Exception:
        pass

    return _dedupe_keep_order(candidates)


def filter_candidates(candidates: List[str], action: str) -> List[str]:
    """Filter and prioritize candidates by step intent."""
    if not candidates:
        return []

    action_name = (action or "").lower().strip()
    if action_name not in {"assert_visible", "click"}:
        return candidates

    preferred: List[str] = []
    secondary: List[str] = []
    for candidate in candidates:
        lowered = candidate.lower()
        if any(keyword in lowered for keyword in INTENT_KEYWORDS):
            preferred.append(candidate)
        else:
            secondary.append(candidate)
    return preferred + secondary
