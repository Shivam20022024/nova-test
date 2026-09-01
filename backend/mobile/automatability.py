"""
Automatability classifier — decides, from a test case's own text, whether a
UiAutomator2 / Appium UI-automation engine can meaningfully execute it at
all.

Some test cases describe things that are simply outside what any on-device
UI driver can do: inspecting TLS traffic, performing a MITM, reading the
clipboard or app-private storage, killing the process, checking the
recent-apps screenshot, injecting a backend failure. Generating fake UI
steps for those and "running" them produces misleading PASS/FAIL noise. We
detect them up front and record them as SKIPPED with the reason, so the
client report distinguishes "the platform can't test this" from "the app
has a bug".

Completely generic: it keys off keywords in the test description / steps /
type column, never off a specific app.
"""
from __future__ import annotations

import re
from typing import Dict, Optional, Tuple

# (reason label, needed external capability) -> regexes that imply it.
_RULES: list[Tuple[str, str, list[str]]] = [
    ("network traffic / TLS inspection", "a proxy or packet-capture harness", [
        r"\btls\b", r"\bhttps?\b.*\b(inspect|scheme|plaintext|transport)", r"\bmitm\b",
        r"man-in-the-middle", r"intercept(ion)?", r"certificate pinning", r"\bpinning\b",
        r"packet capture", r"burp|charles|mitmproxy",
    ]),
    ("device/OS storage inspection", "filesystem/ADB inspection outside the app", [
        r"inspect .*(storage|filesystem|shared ?prefs|sqlite|keychain|keystore)",
        r"stored? (in )?plaintext", r"app-accessible storage", r"insecure(ly)? (stored|persisted)",
        r"\blogcat\b", r"review .*(test )?logs", r"data (not )?persisted insecurely",
    ]),
    ("clipboard access", "clipboard inspection APIs", [
        r"\bclipboard\b",
    ]),
    ("screenshot / recent-apps privacy", "FLAG_SECURE / screen-capture inspection", [
        r"screenshot.*(privacy|preview|recent)", r"recent-?apps preview", r"screen privacy",
        r"\bFLAG_SECURE\b",
    ]),
    ("process death / force-stop", "a controlled process-kill harness", [
        r"process death", r"force[- ]stop", r"process[- ]kill", r"killed by the (os|system)",
    ]),
    ("controlled network / backend fault injection", "a network-condition or backend-fault harness", [
        r"disable (the )?network", r"airplane mode", r"offline device", r"network (loss|disconnect|unavailable)",
        r"controlled (backend )?(failure|slow|transient)", r"endpoint unavailable", r"server rejects",
        r"during (a )?(controlled )?failure", r"timeout handling", r"slow/unavailable network",
    ]),
    ("screen reader / TalkBack semantics", "an accessibility-service assertion harness", [
        r"screen reader", r"talkback", r"accessible (label|role)s?", r"accessibility service",
    ]),
    ("server-side authorization / IDOR", "backend/API-level testing", [
        r"server-?side", r"\bIDOR\b", r"object access", r"access .*user b'?s? data",
        r"through (a )?controlled request", r"direct access to .*(endpoint|function)",
    ]),
]

_COMPILED = [(label, cap, [re.compile(p, re.I) for p in pats]) for label, cap, pats in _RULES]

# Test-tracker "Type" values that are almost always out of UI-automation scope.
_NON_UI_TYPES = {"security", "resilience", "performance"}
# ...unless the text is clearly a plain UI check despite the type.
_UI_ANYWAY = re.compile(r"\b(tap|click|enter|button|screen|field|display|visible|navigat|scroll|form)\b", re.I)


def classify(text: str, test_type: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Returns {"automatable": bool, "reason": str|None, "needs": str|None}.

    `text` should be the combined test case / steps / expected-result text.
    `test_type` is the tracker's Type column when available (advisory only).
    """
    blob = text or ""

    for label, capability, patterns in _COMPILED:
        hits = sum(1 for rx in patterns if rx.search(blob))
        if hits:
            return {"automatable": False, "reason": label, "needs": capability}

    t = (test_type or "").strip().lower()
    if t in _NON_UI_TYPES and not _UI_ANYWAY.search(blob):
        return {
            "automatable": False,
            "reason": f"{t} test with no directly automatable UI assertion",
            "needs": "a specialised security/resilience/performance harness",
        }

    return {"automatable": True, "reason": None, "needs": None}
