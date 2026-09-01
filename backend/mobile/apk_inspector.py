"""
APK ingestion: validation, hashing, and static metadata extraction.

Treats every uploaded APK as untrusted (rule 39): validates extension/size/
zip-structure before ever touching it, never executes it on the backend
host, and only shells out to the Android SDK's `aapt` for read-only manifest
inspection. Runtime discovery (launching it on a device) is a separate step
in engine.py — static extraction here is best-effort and must never be
assumed complete on its own (rule: "Do not assume discovery can be completed
entirely from APK metadata").
"""
from __future__ import annotations

import glob
import hashlib
import os
import re
import subprocess
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

MAX_APK_SIZE_BYTES = 500 * 1024 * 1024  # 500MB — generous ceiling for a mobile APK
ANDROID_HOME = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")


class ApkValidationError(Exception):
    pass


@dataclass
class ApkMetadata:
    package_name: str
    version_name: Optional[str]
    version_code: Optional[str]
    min_sdk: Optional[str]
    target_sdk: Optional[str]
    permissions: List[str] = field(default_factory=list)
    activities: List[str] = field(default_factory=list)
    launchable_activity: Optional[str] = None
    framework_hint: str = "UNKNOWN"
    sha256: str = ""
    size: int = 0


def _find_aapt() -> Optional[str]:
    if not ANDROID_HOME:
        return None
    candidates = sorted(glob.glob(os.path.join(ANDROID_HOME, "build-tools", "*", "aapt.exe")))
    if not candidates:
        candidates = sorted(glob.glob(os.path.join(ANDROID_HOME, "build-tools", "*", "aapt")))
    return candidates[-1] if candidates else None


def validate_apk_file(file_path: str, original_filename: str) -> None:
    """Reject anything that isn't a plausible, well-formed APK before it's trusted further."""
    if not original_filename.lower().endswith(".apk"):
        raise ApkValidationError("File must have a .apk extension.")

    size = os.path.getsize(file_path)
    if size == 0:
        raise ApkValidationError("Uploaded file is empty.")
    if size > MAX_APK_SIZE_BYTES:
        raise ApkValidationError(f"APK exceeds maximum allowed size of {MAX_APK_SIZE_BYTES} bytes.")

    # Path-traversal / non-APK-content guard: must be a valid zip containing AndroidManifest.xml
    try:
        with zipfile.ZipFile(file_path) as zf:
            bad = zf.testzip()
            if bad is not None:
                raise ApkValidationError(f"Corrupt entry in APK archive: {bad}")
            names = zf.namelist()
            if "AndroidManifest.xml" not in names:
                raise ApkValidationError("Not a valid APK: AndroidManifest.xml missing.")
            for n in names:
                # zip-slip guard — reject any entry that would escape extraction root
                if n.startswith("/") or ".." in Path(n).parts:
                    raise ApkValidationError(f"Unsafe path traversal entry in archive: {n}")
    except zipfile.BadZipFile as exc:
        raise ApkValidationError(f"Not a valid zip/APK archive: {exc}") from exc


def compute_sha256(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _detect_framework_hint(file_path: str) -> str:
    try:
        with zipfile.ZipFile(file_path) as zf:
            names = zf.namelist()
            joined = "\n".join(names)
            if "assets/flutter_assets/" in joined or any("libflutter.so" in n for n in names):
                return "FLUTTER"
            if "assets/index.android.bundle" in joined or any("libreactnativejni.so" in n for n in names):
                return "REACT_NATIVE"
            classes = [n for n in names if re.match(r"classes\d*\.dex$", n)]
            for entry in classes[:3]:
                try:
                    data = zf.read(entry)
                except Exception:
                    continue
                if b"androidx/compose" in data:
                    return "COMPOSE"
            return "NATIVE_VIEWS"
    except Exception:
        return "UNKNOWN"


def _run_aapt_badging(aapt_path: str, file_path: str) -> str:
    # aapt's badging dump includes localized strings in dozens of languages —
    # decode as UTF-8 (replacing anything invalid) instead of the platform's
    # default locale codec (cp1252 on Windows), which silently kills the
    # subprocess reader thread on non-Latin-1 bytes.
    result = subprocess.run(
        [aapt_path, "dump", "badging", file_path],
        capture_output=True, encoding="utf-8", errors="replace", timeout=60,
    )
    if result.returncode != 0:
        raise ApkValidationError(f"aapt failed to parse APK: {(result.stderr or '').strip()[:500]}")
    return result.stdout


def _run_aapt_xmltree(aapt_path: str, file_path: str) -> str:
    result = subprocess.run(
        [aapt_path, "dump", "xmltree", file_path, "AndroidManifest.xml"],
        capture_output=True, encoding="utf-8", errors="replace", timeout=60,
    )
    return result.stdout if result.returncode == 0 else ""


def _parse_badging(output: str) -> dict:
    info: dict = {"permissions": [], "activities": []}
    m = re.search(r"package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'", output)
    if m:
        info["package_name"] = m.group(1)
        info["version_code"] = m.group(2)
        info["version_name"] = m.group(3)
    m = re.search(r"sdkVersion:'(\d+)'", output)
    if m:
        info["min_sdk"] = m.group(1)
    m = re.search(r"targetSdkVersion:'(\d+)'", output)
    if m:
        info["target_sdk"] = m.group(1)
    info["permissions"] = sorted(set(re.findall(r"uses-permission(?:-sdk-\d+)?: name='([^']+)'", output)))
    m = re.search(r"launchable-activity: name='([^']+)'", output)
    if m:
        info["launchable_activity"] = m.group(1)
    return info


def _parse_activities_from_xmltree(xmltree: str) -> List[str]:
    """Extract every <activity android:name=...> from the raw manifest xmltree dump."""
    activities: List[str] = []
    blocks = re.split(r"\n(?=\s*E: )", xmltree)
    for block in blocks:
        if re.match(r"\s*E: activity(?:-alias)? ", block):
            m = re.search(r'A: android:name\([^)]*\)="([^"]+)"', block)
            if m:
                activities.append(m.group(1))
    return activities


def extract_metadata(file_path: str, original_filename: str) -> ApkMetadata:
    """Best-effort static extraction. Falls back to raw zip inspection if `aapt`
    isn't available on this machine — runtime discovery covers the rest."""
    sha256 = compute_sha256(file_path)
    size = os.path.getsize(file_path)
    framework_hint = _detect_framework_hint(file_path)

    aapt_path = _find_aapt()
    if aapt_path:
        badging = _run_aapt_badging(aapt_path, file_path)
        parsed = _parse_badging(badging)
        xmltree = _run_aapt_xmltree(aapt_path, file_path)
        activities = _parse_activities_from_xmltree(xmltree) if xmltree else []
        if not parsed.get("package_name"):
            raise ApkValidationError("Could not determine package name from APK — invalid manifest.")
        return ApkMetadata(
            package_name=parsed["package_name"],
            version_name=parsed.get("version_name"),
            version_code=parsed.get("version_code"),
            min_sdk=parsed.get("min_sdk"),
            target_sdk=parsed.get("target_sdk"),
            permissions=parsed.get("permissions", []),
            activities=activities,
            launchable_activity=parsed.get("launchable_activity"),
            framework_hint=framework_hint,
            sha256=sha256,
            size=size,
        )

    # No aapt on PATH/ANDROID_HOME — degrade to a raw manifest presence check only.
    # We still refuse to guess a package name; downstream registration is blocked
    # until runtime discovery resolves it after install (never silently invent metadata).
    raise ApkValidationError(
        "Android build-tools `aapt` was not found (ANDROID_HOME/build-tools/<ver>/aapt). "
        "Static APK metadata extraction requires it."
    )
