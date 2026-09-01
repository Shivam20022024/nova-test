"""
HealingPolicy — autonomous healing decision logic (section 66/67). Pure
decision logic, no I/O, so it's trivially unit-testable and auditable.

Autonomous by explicit product decision: never blocks execution waiting for
a human to click approve. Whenever the candidate generator found at least
one element to try, that top candidate is applied and the run continues —
including on ambiguous ties and CRITICAL-risk steps. There is no unattended
operator to click "approve" during a live run, so a policy that blocks is
equivalent to a policy that fails the whole test.

This trades away the "refuse to guess" safety net that used to stop on a
close tie or a critical action — that tradeoff is intentional here, not an
oversight, but it does mean an auto-applied heal on an ambiguous or critical
step deserves a look afterward. Nothing about *auditability* changed: every
auto-applied heal is still recorded with its full candidate list, score, and
reasoning in mobile_healing_records exactly as before — reviewable after the
fact even though nothing paused for it during the run.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from mobile.schemas import HealingPolicy

AMBIGUITY_MARGIN = 5.0  # points — candidates within this margin of the top score are noted as a close call, not blocked on
CRITICAL_RISK_LEVELS = {"CRITICAL"}


@dataclass
class PolicyDecision:
    decision: str          # AUTO_APPLY | REQUIRES_REVIEW (REQUIRES_REVIEW only when there's truly nothing to apply)
    confidence: float
    reason: str


def decide(
    candidates: List[dict],
    policy: HealingPolicy,
    step_risk: str,
) -> PolicyDecision:
    if not candidates:
        return PolicyDecision("REQUIRES_REVIEW", 0.0, "No viable healing candidates were found in the current UI hierarchy — nothing to auto-apply.")

    top = candidates[0]
    confidence = float(top["score"])
    notes = []

    if len(candidates) > 1:
        runner_up = candidates[1]["score"]
        if (confidence - runner_up) < AMBIGUITY_MARGIN and confidence < 99.5:
            notes.append(f"candidates were close ({confidence:.1f} vs {runner_up:.1f})")

    if step_risk in CRITICAL_RISK_LEVELS:
        notes.append("step is CRITICAL risk")

    reason = f"Auto-applying top candidate (confidence {confidence:.1f}%) — autonomous healing, no approval required."
    if notes:
        reason += f" Flagged for review: {'; '.join(notes)}."

    return PolicyDecision("AUTO_APPLY", confidence, reason)
