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
- fallback_locators: null, or a list of 1-2 locator objects (same shape as `locator`) — ONLY when a
  Screen Map is given AND that same element carries more than one real identifier in it (e.g. it has
  both a resource_id and a content-desc, or the same text also appears via accessibility_id). Every
  fallback MUST be a DIFFERENT real identifier for the EXACT SAME element `locator` already points at
  — never a different element, and never invented. Omit entirely (null) when the element only has one
  identifier, or when ungrounded (no Screen Map). This is redundancy for the one element, not a second
  candidate location.
- value: string or null — text to type (use the given test data verbatim), or a WAIT duration in
  ms. NEVER put an assertion's expected value here — that always goes in `expected` below, even
  for ASSERT_TEXT. `value` is exclusively for actions that supply/type data.
- timeout_ms: integer (default 8000)
- risk: one of ["LOW_RISK","MEDIUM_RISK","HIGH_RISK","CRITICAL"] — CRITICAL for irreversible
  actions (payments, transfers, deletions)
- expected: string or null — REQUIRED for every ASSERT_* step, and it is what the executor
  literally compares against, so its shape depends on the assertion:
    * ASSERT_VISIBLE, ASSERT_NOT_VISIBLE, ASSERT_ENABLED, ASSERT_DISABLED, ASSERT_SELECTED,
      ASSERT_CHECKED: the string "true" or "false".
    * ASSERT_TEXT: the EXACT text (or content-description) the element must equal — e.g. "1",
      "Sauce Labs Backpack", "$ 29.99". Never "true"/"false" here; the executor does a literal
      string comparison against this value, and would compare against the literal word "true"
      if that is what you put here.
    * ASSERT_ACTIVITY: the activity name (or a recognizable fragment of it).
  Non-assertion actions (LAUNCH, TAP, ENTER_TEXT, WAIT, ...) leave `expected` null.

Hard rules:
- Start every test with a LAUNCH step.
- Only emit steps that are a direct, necessary consequence of the objective. Do not add
  exploratory or "just in case" taps, menu opens, or extra verifications the objective never
  asked for — every unrequested step is a place the test can fail for a reason the person who
  wrote the objective never intended.
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
- For a TAP/DOUBLE_TAP/LONG_PRESS step on an item that the Screen Map shows as BOTH a
  non-interactive label (role "text") AND a separate, nearby interactive element (role "button"
  or "toggle") representing the same thing — e.g. a product's name label next to its product
  image, both on one card — target the interactive element, never the label. A label may still be
  the right locator for an ASSERT_VISIBLE/ASSERT_TEXT step checking that item is present; only
  actions that must actually cause something to happen need the real control.
- A sentence describing more than one user action or check (e.g. "tap X to open it and verify Y
  is visible") is more than one step. Decompose every clause with its own verb into its own step —
  never combine a navigation and a check into a single step, and never silently drop a clause.
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
# Assertions the executor compares against a literal free-text `expected` value
# (mobile/actions.py's _assert_text/_assert_activity/_assert_attribute), as
# opposed to ASSERT_VISIBLE-style booleans. Generic across every app: these are
# the action names, not any particular app's screens or copy.
_FREE_TEXT_ASSERTIONS = {"ASSERT_TEXT", "ASSERT_ACTIVITY", "ASSERT_ATTRIBUTE"}
_BOOLEAN_RX = __import__("re").compile(r"^\s*(true|false)\s*$", __import__("re").IGNORECASE)


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

        if action in _FREE_TEXT_ASSERTIONS:
            expected, value = s.get("expected"), s.get("value")
            expected_is_boolean = expected is None or _BOOLEAN_RX.match(str(expected))
            value_has_real_text = isinstance(value, str) and value.strip() and not _BOOLEAN_RX.match(value)
            if expected_is_boolean and value_has_real_text:
                # The model put the actual value to compare against in `value`
                # (its natural home for TAP/ENTER_TEXT) and left `expected` as a
                # generic true/false — but the executor always reads `expected`
                # for these assertions (mobile/actions.py's _expected_value()
                # prefers it), so left alone this step would compare the live
                # element against the literal word "true"/"false" and fail no
                # matter what the app actually shows. Same fix regardless of
                # which app or scenario produced it.
                warnings.append(
                    f"Step {i} ({action}): expected value {value!r} was in `value` instead of "
                    f"`expected` — corrected so the assertion compares against the real value."
                )
                s["expected"] = value
                s["value"] = None

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
    # Generous but explicit — a long, multi-clause objective can otherwise
    # produce a response that runs past whatever the API's own default
    # would allow and gets cut off mid-JSON (confirmed live: a 10-sentence
    # checkout scenario truncated at ~58KB, mid-object). Setting this
    # explicitly removes any doubt the default was the limiting factor,
    # rather than the retry below being the only mitigation.
    GENERATE_MAX_TOKENS = 8000
    system_prompt = GENERATE_SYSTEM_PROMPT
    parsed = None
    last_exc: Optional[Exception] = None
    for attempt in range(2):
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=GENERATE_MAX_TOKENS,
        )
        raw = response.choices[0].message.content
        try:
            parsed = json.loads(raw)
            break
        except json.JSONDecodeError as exc:
            last_exc = exc
            logger.warning(
                "AI Gateway returned non-JSON output on attempt %d/2 (likely truncated — %d chars): %s",
                attempt + 1, len(raw or ""), exc,
            )
            # One retry only, with an explicit instruction to be shorter —
            # not blind chunking (that would need to track which screen the
            # plan is on after each chunk to ground the next one correctly,
            # real complexity for a failure mode this rare). Same objective,
            # same Screen Map, just a pointed nudge toward brevity.
            system_prompt = GENERATE_SYSTEM_PROMPT + (
                "\n\nYour previous attempt was too long and got cut off before finishing valid JSON. "
                "Produce the SHORTEST correct step list possible for this same objective — combine where "
                "you safely can, and do not describe more than what was asked."
            )

    if parsed is None:
        raise RuntimeError(
            "The objective was too complex for the AI to convert into a single test in one pass. "
            "Try splitting it into two shorter scenarios."
        ) from last_exc

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
    _self_correct_hallucinated_locators(step_dicts, screen_map, warnings)
    step_dicts = _ensure_navigation(step_dicts, screen_map, warnings)
    step_dicts = _self_correct_missing_actions(step_dicts, objective_text, screen_map, warnings)

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
            # An element's primary identifier and its alt_locators (other
            # real identifiers the SAME element carries — see explorer.py's
            # _all_locators) are equally real and groundable; only the
            # primary/alt distinction matters for which one generation
            # picked, not for whether a value is a genuine hallucination.
            candidates = [(el.get("strategy"), el.get("value"))] + [
                (a.get("strategy"), a.get("value")) for a in (el.get("alt_locators") or [])
            ]
            for strat, val in candidates:
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

        # fallback_locators get the same check, but silently trimmed rather
        # than warned about — a fallback that turns out ungrounded just
        # never helps (it will fail the same as any other unresolvable
        # locator would, one quick bounded try, see actions.py's _resolve),
        # it's not worth alarming the reviewer over the way a bad PRIMARY
        # locator is.
        fallbacks = step.get("fallback_locators")
        if isinstance(fallbacks, list) and have_reference:
            kept = []
            for fb in fallbacks:
                if not isinstance(fb, dict):
                    continue
                fb_field = _GROUNDABLE_STRATEGIES.get(fb.get("strategy"))
                if fb_field is None or (fb.get("value") or "") in pools[fb_field]:
                    kept.append(fb)
            step["fallback_locators"] = kept or None


SELF_CHECK_SYSTEM_PROMPT = """You just generated a set of test steps for an Android app, grounded in that
app's real Screen Map. A deterministic check found some of your own locators use a value that does NOT
literally appear anywhere in that Screen Map — this is your chance to fix them before a human ever sees
them, the same way a careful engineer reviews their own work before sending it.

For each flagged step, look at its `hint` (what you meant to target) and find the real Screen Map element
that actually represents that thing, or — if genuinely nothing in the map matches — fall back to strategy
"semantic" with the same hint (the engine resolves semantic locators against the live app at run time, so
this is always a safe fallback, never a failure).

Output ONLY a JSON object: {"corrections": [{"index": int, "locator": {"strategy": ..., "value": ...,
"hint": ...}}]} — one entry per flagged step index you were given. Never invent an identifier that isn't
literally in the Screen Map unless you use strategy "semantic"."""


def _self_correct_hallucinated_locators(
    step_dicts: List[Dict[str, Any]],
    screen_map: Optional[Dict[str, Any]],
    warnings: List[str],
) -> None:
    """One extra, narrowly-scoped LLM call: for every step `_flag_hallucinated_locators` just marked
    grounded=False, ask the model — now shown exactly which of its own locators didn't match the real
    Screen Map — to propose a real replacement grounded in that same map, or fall back to strategy
    "semantic". This is the generator getting a chance to self-correct before a human reviewer ever sees
    the output, rather than the hallucination just sitting there as a warning. Only runs when there's
    something to fix and a Screen Map exists to fix it against, so the common (already-grounded) case
    never pays for this call. The model's own correction is re-verified against the real Screen Map
    before being trusted — same self-consistency principle as suggest_locator's resource_id_echo check —
    so a still-wrong correction is silently discarded rather than trusted blind."""
    if not screen_map or not screen_map.get("screens"):
        return
    flagged_indices = [i for i, s in enumerate(step_dicts) if s.get("grounded") is False]
    if not flagged_indices or not is_enabled():
        return

    from mobile.explorer import compact_for_prompt
    map_text = compact_for_prompt(screen_map)
    flagged_payload = [
        {
            "index": i,
            "action": step_dicts[i].get("action"),
            "locator": step_dicts[i].get("locator"),
        }
        for i in flagged_indices
    ]
    user_content = (
        f"=== APP SCREEN MAP ===\n{map_text}\n\n"
        f"Flagged steps (locator not found in the map above):\n{json.dumps(flagged_payload, indent=2)}"
    )
    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": SELF_CHECK_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        parsed = json.loads(response.choices[0].message.content)
    except Exception as exc:
        logger.warning("Locator self-check pass failed (keeping the already-flagged locators as-is): %s", exc)
        return

    corrections = parsed.get("corrections")
    if not isinstance(corrections, list):
        return
    pools = _screen_map_value_pool(screen_map)
    flagged_set = set(flagged_indices)
    for c in corrections:
        if not isinstance(c, dict):
            continue
        idx, loc = c.get("index"), c.get("locator")
        if not isinstance(idx, int) or idx not in flagged_set or not isinstance(loc, dict):
            continue
        strategy, value = loc.get("strategy"), (loc.get("value") or "")
        field = _GROUNDABLE_STRATEGIES.get(strategy)
        if strategy != "semantic" and (field is None or value not in pools.get(field, set())):
            continue  # the "correction" still isn't grounded — leave the original flagged locator + warning as-is
        original_hint = (step_dicts[idx].get("locator") or {}).get("hint")
        step_dicts[idx]["locator"] = {"strategy": strategy, "value": value, "hint": loc.get("hint") or original_hint}
        step_dicts[idx]["grounded"] = None if strategy == "semantic" else True
        # Drop the now-stale "possible hallucination, review before running" warning
        # _flag_hallucinated_locators left for this exact step — it's fixed now, and
        # leaving both messages would tell the reviewer to double-check something
        # that was already corrected automatically.
        warnings[:] = [w for w in warnings if not (w.startswith(f"Step {idx} (") and "possible hallucination" in w)]
        warnings.append(f"Step {idx}: self-corrected locator to {strategy}={value!r} after the original didn't match the Screen Map.")


def _build_element_screen_index(screen_map: Dict[str, Any]) -> Dict[tuple, int]:
    index: Dict[tuple, int] = {}
    for i, screen in enumerate(screen_map.get("screens", [])):
        for el in screen.get("elements", []):
            strat, val = el.get("strategy"), el.get("value")
            if strat and val:
                index.setdefault((strat, val), i)
    return index


def _reach_path_taps(screen: Dict[str, Any]) -> List[tuple]:
    """The (strategy, value) tap sequence needed to reach this screen from
    the entry screen, per the Screen Map's own `reached_by` (already the
    FULL path from entry, not just the last hop — see explorer.py's BFS,
    which accumulates it that way). Empty for the entry screen itself."""
    out = []
    for step in screen.get("reached_by", []) or []:
        loc = step.get("locator") or {}
        strat, val = loc.get("strategy"), loc.get("value")
        if strat and val:
            out.append((strat, val))
    return out


def _is_subsequence(needle: List[tuple], haystack: List[tuple]) -> bool:
    """Does `needle` appear in `haystack`, in the same order (not
    necessarily contiguous)? The classic single-pass idiom: advance a shared
    iterator over haystack, and each `n in it` consumes it up to and
    including the first remaining match, or exhausts it."""
    it = iter(haystack)
    return all(n in it for n in needle)


_NAV_BARRIER_ACTIONS = {"BACK", "RESTART", "LAUNCH", "HOME", "TERMINATE"}


def _ensure_navigation(step_dicts: List[Dict[str, Any]], screen_map: Optional[Dict[str, Any]], warnings: List[str]) -> List[Dict[str, Any]]:
    """Deterministic pass, no AI call: a step can correctly reference a
    real, grounded element and still be wrong because the plan never
    navigated to the screen that element lives on (confirmed live — a
    generated test asserted "the login screen is visible" against a landing
    page's Login BUTTON, then tried to type into fields that only exist on
    the screen that button actually opens, which the plan never tapped its
    way into). The Screen Map already records exactly how to reach every
    screen it found (`reached_by`); this splices in the missing TAP steps
    right before the first step that needed them — literal locators straight
    from the map, never invented.

    Two passes, because a locator strategy of "semantic" (the generator's
    own safe fallback whenever it isn't sure of an exact identifier — used
    constantly, on every app) can't be matched to a Screen Map element
    directly, so a semantic step's own required screen is otherwise
    invisible to this check. Confirmed live: ENTER_TEXT into "the username
    field" (semantic) came out ungrounded by design, and a naive one-pass
    walk only caught the LATER, literally-grounded login-button tap that
    needed the same navigation — leaving the earlier semantic field entries
    still targeting a screen the plan hadn't reached yet.

    Pass 1 (backward fill): a step's own literal locator gives it a required
    screen directly; a locator-less/semantic step inherits the required
    screen of the NEXT step that has one, since an unresolved-until-runtime
    locator overwhelmingly belongs with whatever grounded step immediately
    follows it in a natural sequence (two field entries, then the button
    that submits them) — never inherited across a navigation/lifecycle
    barrier (LAUNCH/BACK/RESTART/HOME/TERMINATE).
    Pass 2 (forward walk): insert each screen's reach path once, right
    before the FIRST step that needs it, not once per step.

    Generic across every app: works off (strategy, value) tuples, action
    names, and the map's own reach paths alone. No screen title, resource-id
    value, or app is ever referenced by this function."""
    if not screen_map or not screen_map.get("screens"):
        return step_dicts
    screens = screen_map["screens"]
    element_screen = _build_element_screen_index(screen_map)
    if not element_screen:
        return step_dicts

    n = len(step_dicts)
    required_screen: List[Optional[int]] = [None] * n
    for i, step in enumerate(step_dicts):
        if (step.get("action") or "").upper() in _NAV_BARRIER_ACTIONS:
            continue
        loc = step.get("locator")
        if loc:
            required_screen[i] = element_screen.get((loc.get("strategy"), loc.get("value")))
    for i in range(n - 2, -1, -1):
        if (step_dicts[i].get("action") or "").upper() in _NAV_BARRIER_ACTIONS:
            continue
        if required_screen[i] is None:
            required_screen[i] = required_screen[i + 1]

    performed: List[tuple] = []
    out: List[Dict[str, Any]] = []
    for i, step in enumerate(step_dicts):
        action = (step.get("action") or "").upper()

        if action in _NAV_BARRIER_ACTIONS:
            # The app's navigation state may have genuinely changed — safer
            # to insert a redundant re-navigation later than to risk missing
            # one that's now actually required again.
            performed = []
            out.append(step)
            continue

        target_screen_idx = required_screen[i]
        if target_screen_idx is not None:
            needed = _reach_path_taps(screens[target_screen_idx])
            if needed and not _is_subsequence(needed, performed):
                for n_strat, n_val in needed:
                    out.append({
                        "action": "TAP",
                        "locator": {"strategy": n_strat, "value": n_val, "hint": None},
                        "value": None, "timeout_ms": 8000, "risk": "LOW_RISK",
                        "expected": None, "description": None, "grounded": True,
                    })
                    performed.append((n_strat, n_val))
                warnings.append(
                    f"Inserted {len(needed)} navigation step(s) before step {i} ({action}) — the "
                    f"generated plan never actually navigated to the screen that step needs."
                )

        loc = step.get("locator")
        if action == "TAP" and loc:
            key = (loc.get("strategy"), loc.get("value"))
            if key[0] and key[1]:
                performed.append(key)

        out.append(step)
    return out


NARRATION_CHECK_SYSTEM_PROMPT = """You previously turned a natural-language testing objective into a
sequence of test steps for an Android app. You now get a chance to check your own work: does the step
sequence actually PERFORM every action the objective describes, or did something get silently dropped
(e.g. the objective says "add it to the cart" but no step actually taps the button that does that)?

You are given the original objective, the app's real Screen Map (only use identifiers that literally
appear in it; otherwise use strategy "semantic"), and the numbered step sequence you already produced.

Respond with a JSON object: {"missing": [{"after_index": <int — the step index to insert after; use -1
to insert before the first step>, "step": {"action": ..., "locator": {...} or null, "value": ...,
"expected": ...}}]}. Each `step` follows the exact same schema the original steps use.

Only report a TRUE gap — an action the objective clearly describes that the step sequence never performs
at all. Do not add extra verification steps, extra taps, or anything the objective didn't ask for — that
is a different concern this check is not for. If the sequence already covers everything, return
{"missing": []}.
"""


def _self_correct_missing_actions(
    step_dicts: List[Dict[str, Any]],
    objective_text: str,
    screen_map: Optional[Dict[str, Any]],
    warnings: List[str],
) -> List[Dict[str, Any]]:
    """One more narrowly-scoped LLM call: does the generated step sequence
    actually perform every action the objective describes, or did the model
    narrate an action without ever emitting the step that does it? Confirmed
    live — a generated test's own plan summary said "add it to the cart" and
    no step actually tapped ADD TO CART, so the cart stayed empty for the
    rest of the run.

    Only runs when there's a Screen Map to ground any inserted step against
    (same bounded-cost guard as the existing self-check pass) and a real
    objective to compare against. Every inserted step is re-validated
    through TestStep and the same groundedness rule every other step
    follows before being trusted — never spliced in blind, same
    self-consistency principle as suggest_locator's resource_id_echo check."""
    if not screen_map or not screen_map.get("screens") or not objective_text or not is_enabled():
        return step_dicts

    numbered = "\n".join(
        f"[{i}] {json.dumps({k: v for k, v in s.items() if k != 'grounded'})}" for i, s in enumerate(step_dicts)
    )
    from mobile.explorer import compact_for_prompt
    map_text = compact_for_prompt(screen_map)
    user_content = (
        f"Objective:\n{objective_text}\n\n"
        f"=== APP SCREEN MAP ===\n{map_text}\n\n"
        f"Your generated steps:\n{numbered}"
    )
    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": NARRATION_CHECK_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        parsed = json.loads(response.choices[0].message.content)
    except Exception as exc:
        logger.warning("Narration-consistency self-check failed (keeping steps as generated): %s", exc)
        return step_dicts

    missing = parsed.get("missing")
    if not isinstance(missing, list) or not missing:
        return step_dicts

    pools = _screen_map_value_pool(screen_map)
    insertions: Dict[int, List[Dict[str, Any]]] = {}
    for m in missing:
        if not isinstance(m, dict):
            continue
        after_index, raw_step = m.get("after_index"), m.get("step")
        if not isinstance(after_index, int) or not isinstance(raw_step, dict):
            continue
        if not (-1 <= after_index < len(step_dicts)):
            continue
        try:
            validated_step = TestStep(**raw_step).dict()
        except ValidationError:
            continue
        loc = validated_step.get("locator")
        if loc and loc.get("strategy") != "semantic":
            field = _GROUNDABLE_STRATEGIES.get(loc.get("strategy"))
            if field is None or (loc.get("value") or "") not in pools.get(field, set()):
                continue  # not grounded — discard rather than insert something invented
        insertions.setdefault(after_index, []).append(validated_step)

    if not insertions:
        return step_dicts

    out: List[Dict[str, Any]] = []
    for idx in range(-1, len(step_dicts)):
        if idx == -1:
            out.extend(insertions.get(-1, []))
            continue
        out.append(step_dicts[idx])
        out.extend(insertions.get(idx, []))
    warnings.append(
        f"Narration self-check inserted {sum(len(v) for v in insertions.values())} step(s) the objective "
        f"described but the original generation silently skipped."
    )
    return out


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

# Used instead of the text-only prompt above whenever an annotated screenshot
# is available — same task, but the candidates are ALSO visible on screen as
# numbered boxes (Set-of-Marks), so a case pure attribute text can't resolve
# (several near-identical elements — e.g. a repeated card grid, or a handful
# of small icons clustered together) can be told apart by what they actually
# look like / where they visually sit, not just their DOM attributes.
SUGGEST_LOCATOR_VISION_SYSTEM_PROMPT = """You are assisting a deterministic self-healing locator engine for Android UI
automation. Deterministic scoring already ran and could not confidently identify which live element
corresponds to a broken locator — often because several candidates look identical in their DOM
attributes alone (e.g. repeated cards in a list/grid, or several small icons in a cluster).

You are given: the broken locator's original value/hint, a numbered list of candidate elements' DOM
attributes, AND a screenshot of the current screen with each candidate's on-screen region outlined by a
colored box labeled with that SAME number. Use the image as your primary evidence — what does the
broken locator's hint actually describe, and which numbered box on screen matches that description? The
text attributes are secondary, supporting evidence only.

Respond with a JSON object:
{"index": <int index into the candidates list, or null if none look right>,
 "box_number_echo": <the same integer as "index" — restate it here as your own confirmation that the
   numbered box you looked at in the image is the one you are answering with>,
 "resource_id_echo": "<the exact resource_id field of the candidate at that index, or \"\" if it has none>",
 "confidence": <0-100>, "rationale": "<one sentence describing what you saw in the image at that box>"}.

Be conservative: if the image doesn't clearly distinguish the candidates, or none look clearly right,
return index: null. box_number_echo and index must match — a mismatch means you looked at one box in the
image but are answering with a different index, and the whole suggestion will be discarded.
"""


def suggest_locator(
    original_locator: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    screenshot_png: Optional[bytes] = None,
) -> Optional[Dict[str, Any]]:
    """Returns {"index", "confidence", "rationale"} or None. Caller is
    responsible for merging this into the deterministic candidate list and
    re-running policy — this function never applies anything itself.

    `screenshot_png`: optional, pre-annotated (see mobile/som_annotate.py) so
    each candidate's on-screen region is boxed with its list index — the
    Set-of-Marks technique for grounding a vision model's answer to a
    specific, checkable index rather than raw coordinates. When omitted (or
    annotation failed upstream), falls back to the original text-only
    prompt/behavior exactly as before — this is a pure additive signal."""
    if not is_enabled() or not candidates:
        return None

    # Number the candidates explicitly in the prompt text itself (not just
    # relying on JSON array position) — models miscount plain array indices
    # far more often than they misread an inline "[3]" label.
    numbered = "\n".join(f"[{i}] {json.dumps(c)}" for i, c in enumerate(candidates))
    text_content = f"Original (broken) locator:\n{json.dumps(original_locator)}\n\nCandidates:\n{numbered}"

    if screenshot_png:
        import base64
        b64 = base64.b64encode(screenshot_png).decode("ascii")
        system_prompt = SUGGEST_LOCATOR_VISION_SYSTEM_PROMPT
        user_content: Any = [
            {"type": "text", "text": text_content},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]
    else:
        system_prompt = SUGGEST_LOCATOR_SYSTEM_PROMPT
        user_content = text_content

    try:
        client = _get_client()
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
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

    if screenshot_png and parsed.get("box_number_echo") != idx:
        # Same self-consistency principle as resource_id_echo below, for the
        # vision path specifically: the model's own restated box number has
        # to match the index it's answering with, or it looked at one box in
        # the image and answered with a different candidate — a miscount,
        # not a real grounded answer.
        logger.warning(
            "AI vision locator suggestion discarded: index %d but box_number_echo=%r — treating as a "
            "miscounted box, not a real suggestion.", idx, parsed.get("box_number_echo"),
        )
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
