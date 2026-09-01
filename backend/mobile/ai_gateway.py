"""
MobileAIGateway — the ONLY place OpenAI is called from (rule 70: never
scatter AI calls through the codebase). Two jobs, both advisory:

  1. Turn free text (a natural-language objective, a pasted requirement, an
     uploaded doc's extracted text) into a DRAFT sequence of TestSteps. The
     draft is always returned for human review — nothing here ever creates
     or runs a test on its own (rule 43).

  2. Suggest ONE additional healing candidate when deterministic AutoHeal
     scoring comes up empty/weak. The suggestion is schema-validated and fed
     into the SAME scored-candidate list AutoHeal already uses — it never
     bypasses policy/confidence/ambiguity gating (rule 71: AI output cannot
     directly execute an action).

Disabled by default. Enabled only when OPENAI_API_KEY is set and
AI_MODE != "AI_DISABLED".
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from mobile.schemas import BASELINE_ACTIONS, Locator, TestStep
from utils.logger import get_logger

logger = get_logger("mobile.ai_gateway")

AI_MODE = os.environ.get("AI_MODE", "AI_ALLOWED")  # AI_DISABLED|SANITIZED_ONLY|AI_ALLOWED|AI_APPROVAL_REQUIRED
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

_client = None


def is_enabled() -> bool:
    return bool(OPENAI_API_KEY) and AI_MODE != "AI_DISABLED"


def _get_client():
    global _client
    if _client is None:
        from openai import OpenAI
        _client = OpenAI(api_key=OPENAI_API_KEY)
    return _client


GENERATE_SYSTEM_PROMPT = f"""You are a test-step generator for an Android UI automation engine (Appium + UiAutomator2).

Input: a plain-English testing objective, optionally the app's real Screen Map (its actual
screens, the real interactive elements on each, and the tap-path to reach each screen), and
optionally concrete test data. Output ONLY a JSON object: {{"steps": [...]}}.

Each step object:
- action: one of {BASELINE_ACTIONS}
- locator: null, or {{"strategy": one of ["resource_id","accessibility_id","text","semantic"], "value": string, "hint": string}}
    * "semantic" means "find this by its human description" — always allowed, and the safest
      choice when you are not certain of an exact identifier. Put the description in BOTH value and hint.
- value: string or null — text to type (use the given test data verbatim), or a WAIT duration in ms
- timeout_ms: integer (default 8000)
- risk: one of ["LOW_RISK","MEDIUM_RISK","HIGH_RISK","CRITICAL"] — CRITICAL for irreversible
  actions (payments, transfers, deletions)
- expected: string or null — for ASSERT_* steps, what you expect to be true

Hard rules:
- Start every test with a LAUNCH step.
- If a Screen Map is given: you may ONLY use a resource_id / accessibility_id / text value that
  literally appears in it. Anything else MUST use strategy "semantic". Never invent an identifier.
- Include the real navigation. If the target screen's "reach" path in the map is
  "TAP Login -> ...", emit those TAP steps first. Do not jump straight to a field on a screen
  you haven't navigated to.
- ENTER_TEXT / REPLACE_TEXT must target an actual input field (role "input" in the map). If the
  map has no matching input, use strategy "semantic" with a hint like "the username field".
- One element per purpose: two different actions must not reuse the same locator value unless
  they genuinely act on the same control.
- Use the provided test data for the corresponding fields; don't invent credentials or amounts
  when data is given.
- No Screen Map given: use strategy "semantic" for every locator, with a clear hint. The engine
  resolves these against the live app at run time.
- Keep it minimal and realistic. No filler WAIT steps. If a wait is needed, one WAIT with an
  explicit ms value (e.g. "1500"), never several in a row.
- Output ONLY the JSON object.
"""

_PLACEHOLDER_RX = __import__("re").compile(
    r"^\s*(unknown|unknown_\w+|example|placeholder|todo|tbd|n/?a|none|null|value|input|text|"
    r"your[_ ]?\w+|enter[_ ]\w+|<[^>]+>|\{\{?[^}]+\}?\})\s*$",
    __import__("re").IGNORECASE,
)
_EDITABLE_OK_STRATEGIES = {"resource_id", "accessibility_id", "semantic", "xpath"}
_TEXT_ENTRY_ACTIONS = {"ENTER_TEXT", "REPLACE_TEXT", "APPEND_TEXT", "CLEAR_TEXT", "DELETE_TEXT"}
_NOOP_ACTIONS = {"WAIT"}


def _sanitize_steps(step_dicts: List[Dict[str, Any]], warnings: List[str]) -> List[Dict[str, Any]]:
    """Defensive normalisation of raw model output — applied ALWAYS, grounded
    or not. Fixes the degenerate patterns seen in practice: placeholder tokens
    used as real locator values, text-entry aimed at a static label, runs of
    empty WAITs, unbounded step counts. Never silently changes a *plausible*
    locator — only clearly-broken ones, and every change is recorded in
    warnings for the human reviewer."""
    out: List[Dict[str, Any]] = []
    consecutive_noop = 0

    for i, s in enumerate(step_dicts):
        action = (s.get("action") or "").upper()
        loc = s.get("locator")

        if isinstance(loc, dict):
            for k in ("value", "hint"):
                if isinstance(loc.get(k), str):
                    loc[k] = loc[k].strip()
            val, hint = loc.get("value") or "", loc.get("hint") or ""

            if val and _PLACEHOLDER_RX.match(val):
                if hint and not _PLACEHOLDER_RX.match(hint):
                    warnings.append(f"Step {i} ({action}): placeholder locator {val!r} → resolving by hint {hint!r}.")
                    loc = {"strategy": "semantic", "value": hint, "hint": hint}
                else:
                    warnings.append(f"Step {i} ({action}): dropped — placeholder locator {val!r} with no usable hint.")
                    continue

            if action in _TEXT_ENTRY_ACTIONS and loc.get("strategy") not in _EDITABLE_OK_STRATEGIES:
                seed = hint or val
                warnings.append(f"Step {i} ({action}): {loc.get('strategy')}={val!r} is not an input — will locate the field semantically ({seed!r}).")
                loc = {"strategy": "semantic", "value": seed, "hint": seed or "the target input field"}

            s["locator"] = loc

        if action in _NOOP_ACTIONS:
            raw = str(s.get("value") or "").strip()
            try:
                ms = int(float(raw))
            except (TypeError, ValueError):
                ms = 0
            if ms <= 0:
                s["value"] = "1000"
            consecutive_noop += 1
            if consecutive_noop > 2:
                warnings.append(f"Step {i}: collapsed a run of empty WAIT steps.")
                continue
        else:
            consecutive_noop = 0

        out.append(s)
        if len(out) >= 40:
            warnings.append(f"Truncated to 40 steps (model produced {len(step_dicts)}).")
            break

    return out


def generate_test_steps(
    objective_text: str,
    screen_map: Optional[Dict[str, Any]] = None,
    grounding_elements: Optional[List[Dict[str, str]]] = None,
    test_data: Optional[str] = None,
) -> Dict[str, Any]:
    """Returns {"steps": [...], "warnings": [...]}. Steps are TestStep-schema
    validated then sanitized; anything unrecoverable is dropped and reported
    in warnings rather than silently kept or crashing the whole generation.

    Grounding priority: a real Screen Map (mobile/explorer.py) > a flat list
    of previously-seen elements > nothing (semantic locators + run-time
    resolution)."""
    if not is_enabled():
        raise RuntimeError(
            "AI generation is disabled — set OPENAI_API_KEY (and AI_MODE if you want something other "
            "than the default AI_ALLOWED) in Apptesting/backend/.env."
        )

    user_content = f"Testing objective:\n{objective_text}\n"
    if test_data:
        user_content += f"\nConcrete test data to use for this test (use these exact values):\n{test_data}\n"

    map_text = ""
    if screen_map and screen_map.get("screens"):
        from mobile.explorer import compact_for_prompt
        map_text = compact_for_prompt(screen_map)
    if map_text:
        user_content += (
            f"\n=== APP SCREEN MAP (the app's REAL screens & elements — only use identifiers that appear here; "
            f"otherwise use strategy \"semantic\") ===\n{map_text}\n"
        )
    elif grounding_elements:
        user_content += (
            "\nPreviously-seen elements on this app (may be partial/stale — prefer strategy \"semantic\" if unsure):\n"
            + json.dumps(grounding_elements[:80], indent=2) + "\n"
        )
    else:
        user_content += "\nNo Screen Map available — use strategy \"semantic\" for every locator with a clear hint; the engine resolves them against the live app at run time.\n"

    client = _get_client()
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": GENERATE_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )
    raw = response.choices[0].message.content
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"AI Gateway returned non-JSON output: {exc}") from exc

    raw_steps = parsed.get("steps", [])
    if not isinstance(raw_steps, list):
        raise RuntimeError("AI Gateway response did not contain a 'steps' array.")

    validated: List[TestStep] = []
    warnings: List[str] = []
    for i, s in enumerate(raw_steps):
        try:
            validated.append(TestStep(**s))
        except ValidationError as exc:
            warnings.append(f"Step {i} dropped — failed schema validation: {exc.errors()[0].get('msg', exc)}")

    if not validated:
        raise RuntimeError("AI Gateway produced no valid steps." + (f" Warnings: {warnings}" if warnings else ""))

    step_dicts = _sanitize_steps([s.dict() for s in validated], warnings)
    if not step_dicts:
        raise RuntimeError("AI Gateway produced no usable steps after sanitization." + (f" Warnings: {warnings}" if warnings else ""))

    _flag_hallucinated_locators(step_dicts, screen_map, grounding_elements, warnings)

    return {"steps": step_dicts, "warnings": warnings}


# Fields a locator strategy can be checked against in the grounding pool, and
# which grounding-element field holds the comparable value. xpath/class_name
# are intentionally excluded: xpath is a synthesized path (never "given" to
# the model, so there's nothing to compare), and class_name alone (e.g.
# "android.widget.Button") is a generic widget type shared across dozens of
# real elements — flagging it as "ungrounded" would be noise, not signal.
_GROUNDABLE_STRATEGIES = {
    "resource_id": "resource_id",
    "accessibility_id": "content_desc",
    "text": "text",
}


def _screen_map_value_pool(screen_map: Optional[Dict[str, Any]]) -> Dict[str, set]:
    pools: Dict[str, set] = {"resource_id": set(), "content_desc": set(), "text": set()}
    if not screen_map:
        return pools
    for scr in screen_map.get("screens", []):
        for el in scr.get("elements", []):
            strat, val = el.get("strategy"), el.get("value")
            if not val:
                continue
            if strat == "resource_id":
                pools["resource_id"].add(val)
            elif strat == "accessibility_id":
                pools["content_desc"].add(val)
            elif strat == "text":
                pools["text"].add(val)
        for t in scr.get("static_text", []) or []:
            pools["text"].add(t)
    return pools


def _flag_hallucinated_locators(
    step_dicts: List[Dict[str, Any]],
    screen_map: Optional[Dict[str, Any]],
    grounding_elements: Optional[List[Dict[str, str]]],
    warnings: List[str],
) -> None:
    """Annotates every step with a `grounded` flag (True/False/None) and warns
    on any literal identifier the model used that does NOT appear in the real
    Screen Map / evidence — the "no hallucination" guarantee made visible to
    the reviewer. `strategy: "semantic"` steps are intentionally not literal
    and are marked grounded=None (they resolve against the live app at run
    time), so they never raise a false hallucination flag."""
    pools = _screen_map_value_pool(screen_map)
    if not any(pools.values()) and grounding_elements:
        for el in grounding_elements:
            for k, field in (("resource_id", "resource_id"), ("content_desc", "content_desc"), ("text", "text")):
                if el.get(k):
                    pools[field].add(el[k])

    have_reference = any(pools.values())

    for i, step in enumerate(step_dicts):
        locator = step.get("locator")
        if not locator:
            step["grounded"] = None
            continue
        strategy = locator.get("strategy")
        field = _GROUNDABLE_STRATEGIES.get(strategy)
        if field is None or not have_reference:
            step["grounded"] = None
            continue
        value = locator.get("value") or ""
        is_grounded = value in pools[field]
        step["grounded"] = is_grounded
        if not is_grounded:
            warnings.append(
                f"Step {i} ({step.get('action')}): locator {strategy}={value!r} is not in the app's real "
                f"Screen Map — possible hallucination. Consider strategy \"semantic\". Review before running."
            )


SUGGEST_LOCATOR_SYSTEM_PROMPT = """You are assisting a deterministic self-healing locator engine for Android UI
automation. Deterministic scoring already ran and could not confidently identify which live element
corresponds to a broken locator. You get ONE more attempt, using the same information a human reviewer
would use.

Given the broken locator's original value/hint and a numbered list of candidate elements currently on
screen, respond with a JSON object:
{"index": <int index into the candidates list, or null if none look right>,
 "resource_id_echo": "<the exact resource_id field of the candidate at that index, or \"\" if it has none — this must match exactly what's printed at that index; it exists purely to catch you picking the wrong index>",
 "confidence": <0-100>, "rationale": "<one sentence>"}.

Be conservative: if multiple candidates look equally plausible, or none look clearly right, return index: null.
Double-check that resource_id_echo actually matches the element at `index` before answering — a mismatch
means you miscounted and the whole suggestion will be discarded.
"""


def suggest_locator(
    original_locator: Dict[str, Any],
    candidates: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Returns {"index", "confidence", "rationale"} or None. Caller is
    responsible for merging this into the deterministic candidate list and
    re-running policy — this function never applies anything itself."""
    if not is_enabled() or not candidates:
        return None

    # Number the candidates explicitly in the prompt text itself (not just
    # relying on JSON array position) — models miscount plain array indices
    # far more often than they misread an inline "[3]" label.
    numbered = "\n".join(f"[{i}] {json.dumps(c)}" for i, c in enumerate(candidates))
    user_content = f"Original (broken) locator:\n{json.dumps(original_locator)}\n\nCandidates:\n{numbered}"

    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": SUGGEST_LOCATOR_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        parsed = json.loads(response.choices[0].message.content)
    except Exception as exc:
        logger.warning("AI locator suggestion failed (falling back to deterministic-only): %s", exc)
        return None

    idx = parsed.get("index")
    if idx is None or not isinstance(idx, int) or not (0 <= idx < len(candidates)):
        return None

    # Self-consistency check: reject the whole suggestion if the model's own
    # echo of the resource-id at `index` doesn't match what's actually there.
    # This is the fix for a real bug found during testing — the model's prose
    # rationale named one element while its numeric index pointed at a
    # completely different one (a miscounted list position), and without this
    # check that mismatch would have silently reached the approval queue at
    # high confidence.
    actual_resource_id = candidates[idx].get("resource_id", "")
    echoed = parsed.get("resource_id_echo", "")
    if (actual_resource_id or echoed) and actual_resource_id != echoed:
        logger.warning(
            "AI locator suggestion discarded: index %d points to resource_id=%r but model echoed %r "
            "(rationale: %r) — treating as a miscounted index, not a real suggestion.",
            idx, actual_resource_id, echoed, parsed.get("rationale"),
        )
        return None

    confidence = parsed.get("confidence", 0)
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "index": idx,
        "confidence": max(0.0, min(90.0, confidence)),  # never let a single AI opinion alone claim near-certainty
        "rationale": parsed.get("rationale", ""),
    }
