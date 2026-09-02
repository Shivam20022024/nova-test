"""
Visual regression for mobile — calls into the SAME pixel-diff engine the web
execution agent uses (backend-node's VisualRegressionAgent.compareAgainstBaseline)
over HTTP, rather than reimplementing image diffing a second time in Python.
The mobile sprint plan is explicit that mobile should hand off to one shared
visual engine, not build its own — this module is that hand-off.

Opt-in only, via VISUAL_BASELINE_ENABLED. Unset (the default), this module is
completely inert and mobile execution behavior is unchanged.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx

from utils.logger import get_logger

logger = get_logger("mobile.visual")

_ENABLED = os.environ.get("VISUAL_BASELINE_ENABLED", "").strip().lower() in ("1", "true", "yes")
_NODE_BASE_URL = os.environ.get("BACKEND_NODE_INTERNAL_URL", "http://127.0.0.1:8080").rstrip("/")
# Same shared secret already used the other direction (Python's
# verify_internal_key in api.py trusts Node's outbound x-internal-key) —
# reused here for the reverse call instead of inventing a new credential.
_INTERNAL_KEY = os.environ.get("INTERNAL_PROXY_KEY", "")


def is_enabled() -> bool:
    return _ENABLED and bool(_INTERNAL_KEY)


def compare_screenshot_to_baseline(key: str, png_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Best-effort only: any failure (Node unreachable, timeout, non-2xx)
    returns None rather than raising, so an optional visual check can never
    fail a mobile test for a reason unrelated to its own steps."""
    if not is_enabled():
        return None
    try:
        resp = httpx.post(
            f"{_NODE_BASE_URL}/api/v1/visual/compare",
            params={"key": key},
            content=png_bytes,
            headers={"x-internal-key": _INTERNAL_KEY, "Content-Type": "application/octet-stream"},
            timeout=20.0,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning("Visual baseline comparison unavailable (non-fatal): %s", exc)
        return None
