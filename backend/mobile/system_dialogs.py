"""
Generic detection of OS-level system dialogs (ANR / "app isn't responding",
and similar platform interstitials) that can obstruct testing of ANY app,
regardless of which one is under test.

These resource-ids are AOSP platform constants — "android:id/aerr_wait" is
the same literal string on every stock Android build, independent of the
app under test. Detecting and safely recovering from these is universal,
and it is not a security bypass (rule 20/78): we're doing exactly what a
human tester would do with an OS-level interstitial that has nothing to do
with the app itself, never touching anything that belongs to the app or its
actual security/auth flow.
"""
from __future__ import annotations

from typing import List, Optional

from mobile.locators import ElementNode

# resource-id -> (failure_error_code, safe_recovery_resource_id_or_None)
# Recovery is only ever a non-destructive "Wait"/"OK"-style action — never
# "Close app" or anything that could discard the app's state, since that's
# not this engine's call to make (rule 20: never silently bypass, rule 24:
# never lose partial evidence).
_KNOWN_SYSTEM_DIALOGS = {
    "android:id/aerr_wait": ("ANR", "android:id/aerr_wait"),
    "android:id/aerr_close": ("ANR", None),
    "android:id/aerr_report": ("ANR", None),
    "android:id/aerr_restart": ("ANR", None),
}


def detect_system_dialog(nodes: List[ElementNode]) -> Optional[dict]:
    """Returns {"error_code": str, "recovery_resource_id": str|None} if a
    known OS-level dialog is present in the given hierarchy, else None."""
    present = {n.attrs.get("resource-id") for n in nodes if n.attrs.get("resource-id")}
    for rid, (error_code, recovery) in _KNOWN_SYSTEM_DIALOGS.items():
        if rid in present:
            return {"error_code": error_code, "recovery_resource_id": recovery, "matched_resource_id": rid}
    return None
