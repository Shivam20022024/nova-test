"""
Set-of-Marks screenshot annotation — AutoHeal's visual-grounding fallback.

When several candidate elements look identical in their DOM attributes alone
(a repeated card grid, a cluster of small icons), a vision-capable model does
far better being asked "which of these numbered boxes on the screenshot is
the right one" than being asked to predict raw pixel coordinates — the
literature on GUI-agent grounding calls this Set-of-Marks. This module does
only the drawing: number each candidate element's bounds directly on the
screenshot so mobile/ai_gateway.py's suggest_locator() can hand a
vision-capable model an image whose numbers match its text candidate list.

Generic: works off ElementNode.bounds_box alone (already generic, screen-
resolution-relative bounds parsed from the live UI hierarchy) — no app,
screen, or element name is ever referenced here.
"""
from __future__ import annotations

import io
from typing import List, Optional

from mobile.locators import ElementNode

# A short, high-contrast rotation — enough to tell adjacent boxes apart
# without needing more colors than a screen realistically has candidates.
_BOX_COLORS = ["#FF3B30", "#007AFF", "#34C759", "#FF9500", "#AF52DE", "#00C7BE", "#FF2D55", "#5856D6"]


def annotate_candidates(screenshot_png: bytes, nodes: List[ElementNode]) -> Optional[bytes]:
    """Returns a new PNG with a numbered box over each node's bounds (index
    matches its position in `nodes`, the same order/indices the text
    candidate list uses), or None on any failure — missing Pillow, a corrupt
    screenshot, or no node having usable bounds. The caller always treats
    None as "fall back to text-only grounding," never as an error to raise."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None

    try:
        img = Image.open(io.BytesIO(screenshot_png)).convert("RGB")
    except Exception:
        return None

    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    drew_any = False
    for i, n in enumerate(nodes):
        box = n.bounds_box
        if not box or box[2] <= box[0] or box[3] <= box[1]:
            continue
        color = _BOX_COLORS[i % len(_BOX_COLORS)]
        draw.rectangle(box, outline=color, width=4)

        label = str(i)
        label_w = 10 * len(label) + 8
        label_h = 18
        # Anchor the label just above the box; if that would go off the top
        # edge, put it just inside the box's top edge instead so it's never
        # clipped out of frame.
        ly = box[1] - label_h if box[1] - label_h >= 0 else box[1]
        draw.rectangle([box[0], ly, box[0] + label_w, ly + label_h], fill=color)
        draw.text((box[0] + 4, ly + 2), label, fill="white", font=font)
        drew_any = True

    if not drew_any:
        return None

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()
