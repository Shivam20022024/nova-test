"""
CandidateGenerator — turns a broken locator + current UI hierarchy into a
ranked list of replacement-locator candidates. Application-agnostic: works
off generic element attributes (class/resource-id/text/content-desc/bounds),
never anything specific to a particular app or screen (rule 60).
"""
from __future__ import annotations

from typing import Dict, List, Optional

from mobile.healing.scorer import score_candidate
from mobile.locators import ElementNode, element_attributes_snapshot
from mobile.schemas import Locator


def node_to_best_locator(node: ElementNode) -> Locator:
    """Prefer the most stable available attribute, in the priority order from
    section 19: accessibility identity > resource id > content-desc > text >
    class+xpath, coordinates only as an absolute last resort elsewhere."""
    a = node.attrs
    if a.get("resource-id"):
        return Locator(strategy="resource_id", value=a["resource-id"])
    if a.get("content-desc"):
        return Locator(strategy="accessibility_id", value=a["content-desc"])
    if a.get("text"):
        return Locator(strategy="text", value=a["text"])
    return Locator(strategy="xpath", value=f"//{a.get('class', '*')}[{node.sibling_index}]")


def generate_candidates(
    nodes: List[ElementNode],
    original_locator: Locator,
    hint: Optional[str],
    requires_interactive: bool,
    historical_locator: Optional[Dict[str, str]] = None,
    historically_successful_before: bool = False,
    top_k: int = 5,
) -> List[Dict[str, object]]:
    scored = []
    for node in nodes:
        result = score_candidate(
            node=node,
            original_value=original_locator.value,
            original_strategy=original_locator.strategy,
            hint=hint,
            requires_interactive=requires_interactive,
            historical_locator=historical_locator,
            historically_successful_before=historically_successful_before,
        )
        if result["score"] <= 0:
            continue
        scored.append({
            "locator": node_to_best_locator(node).dict(),
            "score": result["score"],
            "signals": result["signals"],
            "element_attributes": element_attributes_snapshot(node),
        })

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored[:top_k]
