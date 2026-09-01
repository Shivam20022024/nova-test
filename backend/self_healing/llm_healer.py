from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Dict, Optional

from execution.selector_utils import filter_candidates, generate_candidates_from_dom, score_selector
from llm.generator import generator
from utils.logger import get_logger

logger = get_logger("llm_healer")

LLM_HEAL_TIMEOUT_SECONDS = 4.0


def _extract_json_object(text: str) -> Optional[dict]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


async def _selector_exists(page: Any, selector: str) -> bool:
    try:
        return await page.locator(selector).count() > 0
    except Exception:
        return False


async def _dom_excerpt(page: Any) -> str:
    try:
        html = await page.content()
        return html[:5000]
    except Exception:
        return ""


def _intent_for_action(action: str) -> str:
    normalized = (action or "").strip().lower()
    if normalized == "assert_visible":
        return "verify target element is visible after the relevant user action"
    if normalized == "click":
        return "click the intended interactive element"
    if normalized == "fill":
        return "fill the intended input field"
    return "recover a robust selector for the current step"


async def heal_selector_with_llm(context: Dict[str, Any]) -> Optional[str]:
    page = context.get("page")
    if page is None:
        logger.info("[LLM_HEAL] suggestion=")
        logger.info("[LLM_HEAL] success=false")
        return None

    failed_selector = str(context.get("failed_selector") or "").strip()
    action = str(context.get("action") or "").strip()
    base_url = str(context.get("url") or "").strip()
    step_index = context.get("step_index")
    previous_steps = context.get("previous_steps") or []
    expected_intent = str(context.get("expected_intent") or _intent_for_action(action)).strip()

    logger.info("[LLM_HEAL] triggered=true")
    logger.info(f"[LLM_HEAL] failed_selector={failed_selector}")

    try:
        raw_candidates = await generate_candidates_from_dom(page)
        filtered = filter_candidates(raw_candidates, action)
        ranked = sorted(filtered, key=score_selector, reverse=True)
        candidates = ranked[:30]
    except Exception:
        candidates = []

    if not candidates:
        logger.info("[LLM_HEAL] suggestion=")
        logger.info("[LLM_HEAL] success=false")
        return None

    client = getattr(generator, "client", None)
    if client is None:
        logger.info("[LLM_HEAL] suggestion=")
        logger.info("[LLM_HEAL] success=false")
        return None

    page_dom_excerpt = await _dom_excerpt(page)
    prompt_context = {
        "url": base_url,
        "action": action,
        "failed_selector": failed_selector,
        "step_index": step_index,
        "page_dom_excerpt": page_dom_excerpt,
        "previous_steps": previous_steps,
        "expected_intent": expected_intent,
        "candidate_selectors": candidates,
    }

    model = os.getenv("OPENAI_SELECTOR_HEAL_MODEL", "gpt-4o-mini")

    def _call_llm() -> str:
        response = client.chat.completions.create(
            model=model,
            temperature=0.0,
            max_tokens=160,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Return only strict JSON: "
                        "{\"selector\":\"<css selector>\",\"confidence\":0.0}. "
                        "Choose a visible selector from candidate_selectors. "
                        "Prefer id, data-testid, stable class names, then text selectors. "
                        "Avoid nth-child unless no alternative exists."
                    ),
                },
                {"role": "user", "content": json.dumps(prompt_context)},
            ],
        )
        return (response.choices[0].message.content or "").strip()

    suggestion = ""
    try:
        content = await asyncio.wait_for(
            asyncio.to_thread(_call_llm),
            timeout=LLM_HEAL_TIMEOUT_SECONDS,
        )
        parsed = _extract_json_object(content)
        candidate = str((parsed or {}).get("selector") or "").strip()
        if not candidate:
            candidate = re.sub(r"^['\"]|['\"]$", "", content.strip())
        suggestion = candidate
    except Exception:
        suggestion = ""

    logger.info(f"[LLM_HEAL] suggestion={suggestion}")
    if suggestion and await _selector_exists(page, suggestion):
        logger.info("[LLM_HEAL] success=true")
        return suggestion

    logger.info("[LLM_HEAL] success=false")
    return None

