"""
AutoHealEngine — orchestrates the full pipeline from section 59:

  failure -> capture state -> retrieve memory -> generate candidates ->
  score -> confidence -> policy -> validate -> (execute) -> validate ->
  record -> persist -> (re-run handled by the caller, mobile/engine.py)

This module never overwrites a MobileTest's original step locator (rule 23)
and never auto-executes a CRITICAL-risk healing candidate (rule 67) — those
guarantees live in policy.py / this orchestration, not in the caller.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from mobile.healing import memory as locator_memory
from mobile.healing.candidate_generator import generate_candidates, node_to_best_locator
from mobile.healing.policy import PolicyDecision, decide
from mobile.healing.validator import validate_candidate_pre_execution, validate_post_execution
from mobile.locators import ElementNode, capture_hierarchy_xml, element_attributes_snapshot, parse_hierarchy
from mobile.models import MobileHealingRecord
from mobile.schemas import HealingPolicy, Locator

REQUIRES_INTERACTIVE_ACTIONS = {
    "TAP", "DOUBLE_TAP", "LONG_PRESS", "ENTER_TEXT", "REPLACE_TEXT",
    "APPEND_TEXT", "CLEAR_TEXT", "DELETE_TEXT",
}


@dataclass
class HealAnalysis:
    healing_record: MobileHealingRecord
    decision: PolicyDecision
    candidates: List[Dict[str, Any]]
    replacement_locator: Optional[Locator]
    used_memory_shortcut: bool


def analyze(
    db: Session,
    driver,
    execution_id: int,
    step_index: int,
    test_id: int,
    original_locator: Locator,
    action: str,
    step_risk: str,
    application_id: Optional[int],
    package_name: Optional[str],
    app_version: Optional[str],
    healing_policy: HealingPolicy,
) -> HealAnalysis:
    requires_interactive = action in REQUIRES_INTERACTIVE_ACTIONS
    xml = capture_hierarchy_xml(driver)
    nodes = parse_hierarchy(xml)

    used_memory_shortcut = False
    candidates: List[Dict[str, Any]] = []
    memory_row = None

    if application_id and package_name:
        memory_row = locator_memory.find_by_original_locator(db, application_id, package_name, original_locator)

    if memory_row is not None:
        try:
            historical_candidate = Locator(**memory_row.successful_locator)
        except Exception:
            historical_candidate = None
        if historical_candidate is not None:
            check = validate_candidate_pre_execution(driver, historical_candidate, requires_interactive)
            if check.valid:
                candidates = [{
                    "locator": historical_candidate.dict(),
                    "score": 99.0,
                    "signals": {"historical_locator_reuse": True, "healing_count": memory_row.healing_count},
                    "element_attributes": memory_row.element_attributes,
                }]
                used_memory_shortcut = True

    if not candidates:
        historical_locator_dict = memory_row.successful_locator if memory_row else None
        candidates = generate_candidates(
            nodes=nodes,
            original_locator=original_locator,
            hint=original_locator.hint,
            requires_interactive=requires_interactive,
            historical_locator=historical_locator_dict,
            historically_successful_before=bool(memory_row and memory_row.healing_count > 0),
        )

    # Last resort, section 57: "use OpenAI only if deterministic evidence is
    # insufficient" — never the first-line classifier. The AI's opinion is
    # added as ONE more scored candidate and re-sorted; it still has to clear
    # the exact same ambiguity-margin and confidence-threshold gates in
    # decide() below as every deterministic candidate does. It never
    # bypasses policy on its own.
    top_score = candidates[0]["score"] if candidates else 0.0
    if top_score < healing_policy.auto_apply_threshold:
        ai_candidate = _maybe_ai_candidate(nodes, original_locator, requires_interactive)
        if ai_candidate is not None:
            candidates = sorted(candidates + [ai_candidate], key=lambda c: c["score"], reverse=True)

    decision = decide(candidates, healing_policy, step_risk)

    replacement_locator: Optional[Locator] = None
    if decision.decision == "AUTO_APPLY" and candidates:
        try:
            replacement_locator = Locator(**candidates[0]["locator"])
        except Exception:
            replacement_locator = None
            decision = PolicyDecision("REQUIRES_REVIEW", decision.confidence, "Top candidate locator was malformed.")

    record = MobileHealingRecord(
        execution_id=execution_id,
        step_index=step_index,
        test_id=test_id,
        original_locator=original_locator.dict(),
        candidate_locators=candidates,
        replacement_locator=replacement_locator.dict() if replacement_locator else None,
        confidence=decision.confidence,
        risk_level=step_risk,
        status="PENDING_VALIDATION" if decision.decision == "AUTO_APPLY" else decision.decision,
        reason=decision.reason,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    return HealAnalysis(
        healing_record=record,
        decision=decision,
        candidates=candidates,
        replacement_locator=replacement_locator,
        used_memory_shortcut=used_memory_shortcut,
    )


def _maybe_ai_candidate(
    nodes: List[ElementNode],
    original_locator: Locator,
    requires_interactive: bool,
) -> Optional[Dict[str, Any]]:
    """Ask the AI Gateway for one more opinion when deterministic scoring
    wasn't confident. Returns a candidate dict in the exact same shape
    generate_candidates() produces, or None (AI disabled, call failed, or
    the model itself declined to guess) — in every case the caller falls
    back to deterministic-only behavior."""
    try:
        from mobile.ai_gateway import is_enabled, suggest_locator
    except ImportError:
        return None
    if not is_enabled():
        return None

    pool = [n for n in nodes if not requires_interactive or n.attrs.get("clickable") == "true" or n.attrs.get("checkable") == "true"]
    if not pool:
        pool = nodes
    pool = pool[:60]
    candidate_payload = [element_attributes_snapshot(n) for n in pool]

    suggestion = suggest_locator(original_locator.dict(), candidate_payload)
    if suggestion is None:
        return None

    node = pool[suggestion["index"]]
    return {
        "locator": node_to_best_locator(node).dict(),
        "score": suggestion["confidence"],
        "signals": {"ai_suggested": True, "rationale": suggestion.get("rationale", "")},
        "element_attributes": element_attributes_snapshot(node),
    }


def finalize_after_execution(
    db: Session,
    driver,
    analysis: HealAnalysis,
    execution_succeeded: bool,
    expected_package: Optional[str],
    application_id: Optional[int],
    package_name: Optional[str],
    app_version: Optional[str],
    screen_signature: Optional[str] = None,
) -> MobileHealingRecord:
    """Called by mobile/engine.py after it has actually re-run the action with
    the replacement locator. Persists validation outcome and, only on full
    success, writes the healed locator into LocatorMemory."""
    record = analysis.healing_record

    if not execution_succeeded:
        record.status = "VALIDATION_FAILED"
        record.validation_result = {"valid": False, "reason": "Action execution with candidate locator raised or failed."}
        record.resolved_at = datetime.datetime.utcnow()
        db.commit()
        db.refresh(record)
        return record

    post = validate_post_execution(driver, expected_package)
    record.validation_result = {"valid": post.valid, "reason": post.reason}

    if not post.valid:
        record.status = "VALIDATION_FAILED"
        record.resolved_at = datetime.datetime.utcnow()
        db.commit()
        db.refresh(record)
        return record

    record.status = "VALIDATED"
    record.resolved_at = datetime.datetime.utcnow()
    db.commit()

    if application_id and package_name and analysis.replacement_locator and screen_signature:
        original = Locator(**record.original_locator)
        locator_memory.record_success(
            db=db,
            application_id=application_id,
            package_name=package_name,
            screen_signature=screen_signature,
            element_signature=build_element_signature_stub(original),
            original_locator=original,
            successful_locator=analysis.replacement_locator,
            element_attributes=analysis.candidates[0].get("element_attributes") if analysis.candidates else None,
            app_version=app_version,
            was_healing=True,
        )

    db.refresh(record)
    return record


def build_element_signature_stub(original_locator: Locator) -> str:
    """The learned-locator-reuse shortcut in analyze() keys off the *original*
    locator's identity, not a live element signature (which would itself
    change when the app changes) — this derives a stable key from it."""
    import hashlib
    return hashlib.sha1(f"{original_locator.strategy}::{original_locator.value}".encode()).hexdigest()[:24]
