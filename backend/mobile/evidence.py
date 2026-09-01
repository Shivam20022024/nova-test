"""
Evidence capture — screenshots and UI hierarchy dumps, hashed and persisted
as immutable MobileEvidence rows (rule 22/86: never overwrite evidence).
"""
from __future__ import annotations

import datetime
import hashlib
import re
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from mobile import artifact_store
from mobile.locators import capture_hierarchy_xml
from mobile.models import MobileEvidence
from utils.logger import get_logger

logger = get_logger("mobile.evidence")

STORAGE_ROOT = Path(__file__).resolve().parent.parent / "storage" / "mobile"
SCREENSHOT_DIR = STORAGE_ROOT / "screenshots"
HIERARCHY_DIR = STORAGE_ROOT / "hierarchy"
VIDEO_DIR = STORAGE_ROOT / "videos"


def _persisted_path(path: Path, key: str, data: bytes, content_type: str) -> str:
    """The value stored in MobileEvidence.storage_path.

    Prefers a Supabase Storage URL so evidence survives this machine, and falls
    back to the repo-relative local path when object storage is unconfigured or
    unreachable. Both forms are valid: the API layer renders an absolute URL
    as-is and prefixes the local form with "/".

    The local file is always written first and never removed — the engine reads
    its own artifacts back mid-run (video stitching, re-parsing a hierarchy for
    AI grounding), so the disk copy is load-bearing, not a cache.
    """
    uploaded = artifact_store.upload(key, data, content_type)
    return uploaded or str(path.relative_to(STORAGE_ROOT.parent.parent))


def _redact_hierarchy(xml_string: str) -> tuple[str, bool]:
    """Mask text on password-flagged EditText nodes before persisting (rule 51)."""
    redacted = False

    def _mask(match: re.Match) -> str:
        nonlocal redacted
        redacted = True
        return 'text="[REDACTED]"'

    # Only mask text="..." on nodes that also carry password="true" in the same tag.
    def _process_tag(tag_match: re.Match) -> str:
        nonlocal redacted
        tag = tag_match.group(0)
        if 'password="true"' in tag:
            tag = re.sub(r'text="[^"]*"', _mask, tag)
        return tag

    out = re.sub(r"<node[^>]*/>", _process_tag, xml_string)
    return out, redacted


def capture_screenshot(db: Session, execution_id: int, step_index: Optional[int], driver) -> MobileEvidence:
    exec_dir = SCREENSHOT_DIR / str(execution_id)
    exec_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    filename = f"step{step_index if step_index is not None else 'x'}_{ts}.png"
    path = exec_dir / filename

    png_bytes = driver.get_screenshot_as_png()
    path.write_bytes(png_bytes)
    sha256 = hashlib.sha256(png_bytes).hexdigest()

    row = MobileEvidence(
        execution_id=execution_id,
        step_index=step_index,
        artifact_type="SCREENSHOT",
        storage_path=_persisted_path(path, f"{execution_id}/screenshots/{filename}", png_bytes, "image/png"),
        sha256=sha256,
        mime_type="image/png",
        size=len(png_bytes),
        redaction_status="NONE",
        captured_at=datetime.datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def capture_hierarchy(db: Session, execution_id: int, step_index: Optional[int], driver) -> MobileEvidence:
    exec_dir = HIERARCHY_DIR / str(execution_id)
    exec_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    filename = f"step{step_index if step_index is not None else 'x'}_{ts}.xml"
    path = exec_dir / filename

    xml_string = capture_hierarchy_xml(driver)
    redacted_xml, was_redacted = _redact_hierarchy(xml_string)
    data = redacted_xml.encode("utf-8")
    path.write_bytes(data)
    sha256 = hashlib.sha256(data).hexdigest()

    row = MobileEvidence(
        execution_id=execution_id,
        step_index=step_index,
        artifact_type="UI_HIERARCHY",
        storage_path=_persisted_path(path, f"{execution_id}/hierarchy/{filename}", data, "application/xml"),
        sha256=sha256,
        mime_type="application/xml",
        size=len(data),
        redaction_status="REDACTED" if was_redacted else "NONE",
        captured_at=datetime.datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


SUITE_VIDEO_DIR = STORAGE_ROOT / "suite_videos"


def save_suite_video(suite_id: int, source_path: Path) -> Optional[str]:
    """Moves the ffmpeg-concatenated whole-suite recording into stable
    storage and returns its path (relative to the repo root, matching the
    convention every other stored-file path in this module uses). Not a
    MobileEvidence row — a suite isn't an execution, so there's nothing for
    a per-execution evidence row to attach to; MobileTestSuite.
    combined_video_path points at it directly instead."""
    if not source_path.exists() or source_path.stat().st_size == 0:
        return None
    dest_dir = SUITE_VIDEO_DIR / str(suite_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "combined.mp4"
    data = source_path.read_bytes()
    dest.write_bytes(data)
    try:
        source_path.unlink()
    except OSError:
        pass
    return str(dest.relative_to(STORAGE_ROOT.parent.parent))


def save_appium_log(db: Session, execution_id: int, source_path: Optional[Path]) -> Optional[MobileEvidence]:
    """Copy the Appium server's drained log (see appium_manager._drain_to_file)
    into evidence storage and link it to this execution. Returns None when
    there's no log to link — an externally-managed Appium server (no process
    we own) or a log file that somehow ended up empty — rather than inventing
    an empty evidence row."""
    if source_path is None or not source_path.exists() or source_path.stat().st_size == 0:
        return None

    exec_dir = STORAGE_ROOT / "appium_logs" / str(execution_id)
    exec_dir.mkdir(parents=True, exist_ok=True)
    dest = exec_dir / "appium.log"

    data = source_path.read_bytes()
    dest.write_bytes(data)
    try:
        source_path.unlink()
    except OSError:
        pass
    sha256 = hashlib.sha256(data).hexdigest()

    row = MobileEvidence(
        execution_id=execution_id,
        step_index=None,
        artifact_type="APPIUM_LOG",
        storage_path=_persisted_path(dest, f"{execution_id}/appium.log", data, "text/plain"),
        sha256=sha256,
        mime_type="text/plain",
        size=len(data),
        redaction_status="NONE",
        captured_at=datetime.datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_video(db: Session, execution_id: int, source_path: Path) -> Optional[MobileEvidence]:
    """Move an already-pulled recording (see mobile/video.py) into evidence
    storage and register it. Returns None if the source file is missing/empty
    (recording can legitimately fail — never invent an evidence row for it)."""
    if not source_path.exists() or source_path.stat().st_size == 0:
        return None

    exec_dir = VIDEO_DIR / str(execution_id)
    exec_dir.mkdir(parents=True, exist_ok=True)
    dest = exec_dir / "recording.mp4"

    data = source_path.read_bytes()
    dest.write_bytes(data)
    try:
        source_path.unlink()
    except OSError:
        pass
    sha256 = hashlib.sha256(data).hexdigest()

    row = MobileEvidence(
        execution_id=execution_id,
        step_index=None,
        artifact_type="VIDEO",
        storage_path=_persisted_path(dest, f"{execution_id}/recording.mp4", data, "video/mp4"),
        sha256=sha256,
        mime_type="video/mp4",
        size=len(data),
        redaction_status="NONE",
        captured_at=datetime.datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
