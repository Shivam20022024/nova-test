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


def _center(node: ElementNode) -> Optional[tuple]:
    box = node.bounds_box
    if not box:
        return None
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


# A repeated-card grid (a product list, a search-results feed, any RecyclerView
# of near-identical items) gives every card's icon/image the SAME resource-id
# and content-desc — "which one is Sauce Labs Backpack's" isn't answerable
# from attributes alone, only from which card it's physically inside. When the
# original locator's own text/value literally appears elsewhere on screen as a
# DIFFERENT element's text/content-desc (the card's own title/label — the
# reason a broken locator often still names the right thing even though it
# points at a non-interactive node), that occurrence anchors "the right card":
# a candidate close to it is almost certainly that card's control, while an
# identical-looking candidate three cards down is not. Generic — this never
# looks at what the anchor or candidate actually say, only where they sit
# relative to each other, so it applies to a product grid exactly as it would
# to a contact list, a search feed, or a settings list with repeated rows.
_ANCHOR_PROXIMITY_BONUS = 65.0
_ANCHOR_PROXIMITY_RADIUS = 500.0


def generate_candidates(
    nodes: List[ElementNode],
    original_locator: Locator,
    hint: Optional[str],
    requires_interactive: bool,
    historical_locator: Optional[Dict[str, str]] = None,
    historically_successful_before: bool = False,
    top_k: int = 5,
) -> List[Dict[str, object]]:
    anchor_value = (original_locator.value or "").strip()
    anchor_nodes = []
    if anchor_value and requires_interactive:
        for n in nodes:
            if n.attrs.get("text", "").strip() == anchor_value or n.attrs.get("content-desc", "").strip() == anchor_value:
                anchor_nodes.append(n)

    scored = []
    for node in nodes:
        # A node scored for being close to the anchor when it IS the anchor
        # is a distance-zero tautology, not evidence — it would let a
        # non-clickable label that matches the broken locator's own text
        # (already scored on its own merits above) win purely by being
        # "next to itself," even though it's exactly the kind of target that
        # produced the broken locator in the first place. The signal only
        # means something for a DIFFERENT element sitting near the anchor.
        anchor_centers = [c for c in (_center(a) for a in anchor_nodes if a is not node) if c]
        result = score_candidate(
            node=node,
            original_value=original_locator.value,
            original_strategy=original_locator.strategy,
            hint=hint,
            requires_interactive=requires_interactive,
            historical_locator=historical_locator,
            historically_successful_before=historically_successful_before,
        )
        score = result["score"]
        signals = dict(result["signals"])

        # Only a genuinely interactive node is eligible for the bonus — proximity to
        # the anchor is evidence of "the right card," not evidence of being tappable
        # at all, and score_candidate's own not-clickable penalty is already clamped
        # into `score` by this point (never negative), so gating on the node's own
        # clickable/checkable attribute is the only reliable way left to keep a
        # decorative, non-interactive neighbor from being promoted by proximity alone.
        node_is_interactive = node.attrs.get("clickable") == "true" or node.attrs.get("checkable") == "true"
        if anchor_centers and node_is_interactive:
            node_center = _center(node)
            if node_center:
                nearest_d = min(
                    ((node_center[0] - ax) ** 2 + (node_center[1] - ay) ** 2) ** 0.5
                    for ax, ay in anchor_centers
                )
                if nearest_d < _ANCHOR_PROXIMITY_RADIUS:
                    # Being the only candidate anywhere near the anchor is
                    # itself most of the evidence — a repeated-card layout's
                    # OTHER cards sit a full card-width/height away, well
                    # outside this radius, so anything inside it is already
                    # exclusive to the right card. Distance inside the radius
                    # is a secondary tiebreaker, not the primary signal, so
                    # it only softens the bonus down to half, never toward
                    # zero, for a candidate at the very edge of "same card."
                    proximity = 1.0 - 0.5 * (nearest_d / _ANCHOR_PROXIMITY_RADIUS)
                    score += _ANCHOR_PROXIMITY_BONUS * proximity
                    signals["anchor_proximity"] = round(proximity, 3)

        if score <= 0:
            continue
        scored.append({
            "locator": node_to_best_locator(node).dict(),
            "score": max(0.0, min(100.0, score)),
            "signals": signals,
            "element_attributes": element_attributes_snapshot(node),
        })

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored[:top_k]
