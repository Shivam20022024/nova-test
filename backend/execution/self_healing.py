"""
Self-healing selector engine with persistent selector memory.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from playwright.async_api import Page

from execution.selector_utils import filter_candidates, generate_candidates_from_dom, score_selector, score_selector_quality
from self_healing.llm_healer import heal_selector_with_llm
from utils.logger import get_logger

logger = get_logger("self_healing")

_MEMORY_PATH = Path(__file__).resolve().parent.parent / "storage" / "selector_memory.json"
_LEGACY_MEMORY_PATH = Path(__file__).resolve().parent.parent / "selector_memory.json"


def load_memory() -> dict:
    if _MEMORY_PATH.exists():
        try:
            with _MEMORY_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
                if isinstance(data, dict):
                    logger.info(f"[MEMORY] Loaded {len(data)} entries")
                    return data
        except Exception:
            logger.info("[MEMORY] Loaded 0 entries")
            return {}

    if _LEGACY_MEMORY_PATH.exists():
        try:
            with _LEGACY_MEMORY_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
                if isinstance(data, dict):
                    save_memory(data)
                    logger.info(f"[MEMORY] Loaded {len(data)} entries")
                    return data
        except Exception:
            logger.info("[MEMORY] Loaded 0 entries")
            return {}

    save_memory({})
    logger.info("[MEMORY] Loaded 0 entries")
    return {}


def save_memory(memory: dict) -> None:
    _MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _MEMORY_PATH.open("w", encoding="utf-8") as file:
        json.dump(memory, file, indent=2)


SELECTOR_MEMORY: dict = load_memory()

GENERIC_SELECTORS = {
    "button",
    "a",
    "div",
    "span",
    "input",
    "form",
    "body",
    "#root",
    "#react-burger-menu-btn",
}


def _memory_key(base_url: str, action: str, original_selector: str) -> str:
    return f"{base_url}|{action}|{original_selector}"


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def remember_selector_mapping(
    *,
    base_url: str,
    action: str,
    original_selector: str,
    healed_selector: str,
    confidence: float = 1.0,
) -> None:
    key = _memory_key(
        (base_url or "").strip().rstrip("/"),
        (action or "").strip(),
        (original_selector or "").strip(),
    )
    SELECTOR_MEMORY[key] = {
        "healed_selector": (healed_selector or "").strip(),
        "confidence": float(confidence),
        "last_used": _iso_utc_now(),
    }
    save_memory(SELECTOR_MEMORY)
    logger.info(f"[MEMORY] SAVED key={key}")


async def _selector_exists(page: Page, selector: str) -> bool:
    try:
        return await page.locator(selector).count() > 0
    except Exception:
        return False


async def heal_selector(page: Page, selector: str) -> Optional[str]:
    for candidate in await _build_recovery_candidates(page, selector):
        if candidate == selector:
            continue
        try:
            if await page.locator(candidate).count() > 0:
                return candidate
        except Exception:
            continue
    return None


def _selector_tokens(selector: str) -> List[str]:
    tokens = re.split(r"[^A-Za-z0-9]+", (selector or "").lower())
    stopwords = {
        "input",
        "button",
        "label",
        "text",
        "aria",
        "role",
        "name",
        "class",
        "list",
        "item",
        "container",
        "content",
        "main",
        "root",
        "link",
        "menu",
        "sidebar",
        "header",
        "footer",
        "wrap",
    }
    return [token for token in tokens if len(token) >= 3 and token not in stopwords]


def _is_generic_selector(selector: str) -> bool:
    normalized = (selector or "").strip().lower()
    if normalized in GENERIC_SELECTORS:
        return True
    if normalized.startswith("button") or normalized.startswith("div") or normalized.startswith("span"):
        return True
    return False


def _selectors_semantically_related(original: str, candidate: str) -> bool:
    original_tokens = set(_selector_tokens(original))
    candidate_tokens = set(_selector_tokens(candidate))
    if not original_tokens or not candidate_tokens:
        return False
    overlap = original_tokens.intersection(candidate_tokens)
    if not overlap:
        return False
    return any(len(token) >= 4 for token in overlap)


def _action_selector_compatible(original: str, candidate: str, action: str) -> bool:
    original_l = (original or "").lower()
    candidate_l = (candidate or "").lower()
    action_l = (action or "").lower()

    if action_l != "click":
        return True

    # Prevent drift from intent-critical click targets.
    strict_pairs = [
        ("add-to-cart", "add-to-cart"),
        ("shopping_cart_link", "shopping_cart_link"),
        ("cart-link", "shopping_cart_link"),
        ("checkout-button", "checkout"),
        ("place-order", "finish"),
        ("finish", "finish"),
        ("back-to-products", "back-to-products"),
    ]
    for marker, required in strict_pairs:
        if marker in original_l and required not in candidate_l:
            return False
    return True


def _sanitize_memory_store(memory: dict) -> dict:
    cleaned: dict = {}
    removed = 0
    for key, value in (memory or {}).items():
        if not isinstance(value, dict):
            removed += 1
            continue
        healed_selector = str(value.get("healed_selector") or "").strip()
        if not healed_selector:
            removed += 1
            continue
        if _is_generic_selector(healed_selector):
            removed += 1
            continue
        try:
            _, action_name, original_selector = key.split("|", 2)
        except ValueError:
            removed += 1
            continue
        if not _selectors_semantically_related(original_selector, healed_selector):
            removed += 1
            continue
        if not _action_selector_compatible(original_selector, healed_selector, action_name):
            removed += 1
            continue
        cleaned[key] = value
    if removed:
        logger.info(f"[MEMORY] Sanitized memory entries removed={removed}")
    return cleaned


SELECTOR_MEMORY = _sanitize_memory_store(SELECTOR_MEMORY)
save_memory(SELECTOR_MEMORY)


async def _build_recovery_candidates(page: Page, selector: str) -> List[str]:
    tokens = _selector_tokens(selector)
    candidates: List[str] = []
    if not tokens:
        tokens = [selector.strip("#.[]'\" ").lower()]

    for token in tokens:
        candidates.extend(
            [
                f"[data-testid*='{token}' i]",
                f"[aria-label*='{token}' i]",
                f"[name*='{token}' i]",
                f"[id*='{token}' i]",
                f"[placeholder*='{token}' i]",
                f"label:text-is('{token}')",
                f"text={token}",
                f"[class*='{token}' i]",
            ]
        )
        if any(word in token for word in {"user", "email", "login", "name"}):
            candidates.extend(["input[type='text']", "input:not([type='hidden'])"])
        if any(word in token for word in {"pass", "pwd"}):
            candidates.extend(["input[type='password']"])
        if any(word in token for word in {"submit", "login", "sign", "checkout", "save"}):
            candidates.extend(["button", "input[type='submit']", "[role='button']"])

    try:
        dom_candidates = await generate_candidates_from_dom(page)
        for candidate in filter_candidates(dom_candidates, "click"):
            lowered = candidate.lower()
            if any(token in lowered for token in tokens):
                candidates.append(candidate)
    except Exception:
        pass

    ranked = sorted(dict.fromkeys(candidates), key=score_selector, reverse=True)
    return ranked[:40]


async def validate_selector(
    page: Page,
    selector: str,
    base_url: str,
    action: str,
    ignore_memory: bool = False,
) -> Dict[str, Any]:
    """
    Validate selector and return resolution metadata:
    {
      selector, used_memory, healed, original_selector, new_selector
    }
    """
    original_selector = (selector or "").strip()
    action_name = (action or "").strip()
    url = (base_url or "").strip().rstrip("/")
    key = _memory_key(url, action_name, original_selector)

    default_result = {
        "selector": original_selector,
        "used_memory": False,
        "healed": False,
        "original_selector": None,
        "new_selector": None,
        "selector_score_original": score_selector_quality(original_selector),
        "selector_score_new": score_selector_quality(original_selector),
        "recovery_attempts": [],
    }

    if not original_selector:
        raise Exception("Selector not found")

    logger.info("[MEMORY] Checking selector memory...")
    logger.info(f"[MEMORY] Lookup key={key}")
    if not SELECTOR_MEMORY:
        logger.info("[MEMORY] Memory store empty")

    if not ignore_memory:
        cached_entry = SELECTOR_MEMORY.get(key)
        if isinstance(cached_entry, dict):
            cached_selector = str(cached_entry.get("healed_selector") or "").strip()
            if cached_selector:
                if _is_generic_selector(cached_selector):
                    logger.info("[MEMORY] cached_selector_rejected generic=true")
                    cached_selector = ""
                elif not _selectors_semantically_related(original_selector, cached_selector):
                    logger.info("[MEMORY] cached_selector_rejected semantic_mismatch=true")
                    cached_selector = ""
                elif not _action_selector_compatible(original_selector, cached_selector, action_name):
                    logger.info("[MEMORY] cached_selector_rejected action_mismatch=true")
                    cached_selector = ""
            if cached_selector:
                original_score = score_selector_quality(original_selector)
                memory_score = score_selector_quality(cached_selector)
                logger.info("[MEMORY] HIT")
                if memory_score >= original_score:
                    cached_entry["last_used"] = _iso_utc_now()
                    save_memory(SELECTOR_MEMORY)
                    logger.info("[MEMORY] Reusing cached selector")
                    logger.info(f"[MEMORY] original={original_selector}")
                    logger.info(f"[MEMORY] reused={cached_selector}")
                    return {
                        "selector": cached_selector,
                        "used_memory": True,
                        "healed": False,
                        "original_selector": original_selector,
                        "new_selector": cached_selector,
                        "selector_score_original": original_score,
                        "selector_score_new": memory_score,
                    }
                logger.info("[MEMORY] quality_downgrade=true")
                logger.info(f"[MEMORY] original_score={original_score}")
                logger.info(f"[MEMORY] cached_score={memory_score}")
        logger.info("[MEMORY] MISS")
    else:
        logger.info("[MEMORY] MISS")
        logger.info("[MEMORY] lookup_skipped ignore_memory=true")

    if await _selector_exists(page, original_selector):
        return default_result

    cached_selector_for_conflict = None
    if not ignore_memory:
        cached_entry = SELECTOR_MEMORY.get(key)
        if isinstance(cached_entry, dict):
            cached_selector_for_conflict = str(cached_entry.get("healed_selector") or "").strip() or None

    recovery_attempts: List[Dict[str, Any]] = []
    used_llm = False
    new_selector = await heal_selector(page, original_selector)
    if new_selector:
        recovery_attempts.append({"strategy": "heuristic", "candidate": new_selector, "success": True})
    if not new_selector:
        used_llm = True
        new_selector = await heal_selector_with_llm(
            {
                "page": page,
                "url": getattr(page, "url", url) or url,
                "action": action_name,
                "failed_selector": original_selector,
                "step_index": None,
                "previous_steps": [],
                "expected_intent": f"recover selector for action '{action_name}'",
            }
        )
        recovery_attempts.append({"strategy": "llm", "candidate": new_selector, "success": bool(new_selector)})
    if not new_selector:
        raise Exception("Selector not found")

    if _is_generic_selector(new_selector):
        raise Exception(f"Healed selector too generic: {new_selector}")
    if not _selectors_semantically_related(original_selector, new_selector):
        raise Exception(
            f"Healed selector semantic mismatch: original={original_selector} new={new_selector}"
        )
    if not _action_selector_compatible(original_selector, new_selector, action_name):
        raise Exception(
            f"Healed selector action mismatch: original={original_selector} new={new_selector}"
        )

    if cached_selector_for_conflict and used_llm:
        cached_score = score_selector_quality(cached_selector_for_conflict)
        new_score = score_selector_quality(new_selector)
        if new_score > cached_score:
            logger.info("[MEMORY] llm_override=true")
            logger.info(f"[MEMORY] cached_score={cached_score}")
            logger.info(f"[MEMORY] new_score={new_score}")

    logger.info(f"[SELF-HEAL] original={original_selector}")
    logger.info(f"[SELF-HEAL] new={new_selector}")

    # Store only when original failed and healed selector is validated.
    if await _selector_exists(page, new_selector):
        SELECTOR_MEMORY[key] = {
            "healed_selector": new_selector,
            "confidence": 1.0,
            "last_used": _iso_utc_now(),
        }
        save_memory(SELECTOR_MEMORY)
        logger.info(f"[MEMORY] SAVED key={key}")
        logger.info(f"[MEMORY] original={original_selector}")
        logger.info(f"[MEMORY] new={new_selector}")

    return {
        "selector": new_selector,
        "used_memory": False,
        "healed": True,
        "original_selector": original_selector,
        "new_selector": new_selector,
        "selector_score_original": score_selector_quality(original_selector),
        "selector_score_new": score_selector_quality(new_selector),
        "recovery_attempts": recovery_attempts,
    }
