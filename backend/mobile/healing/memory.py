"""
LocatorMemory — persisted history of locators that were validated as working
for a given (application, screen, element). Never blindly reused: callers
must still validate a historical locator against the *current* live state
before trusting it (rule 61).
"""
from __future__ import annotations

import datetime
import json
from typing import Optional

from sqlalchemy.orm import Session

from mobile.models import MobileLocatorMemory
from mobile.schemas import Locator


def _locator_key(locator: Locator) -> str:
    return f"{locator.strategy}::{locator.value}"


def find_memory(
    db: Session, application_id: int, screen_signature: str, element_signature: str
) -> Optional[MobileLocatorMemory]:
    return (
        db.query(MobileLocatorMemory)
        .filter(
            MobileLocatorMemory.application_id == application_id,
            MobileLocatorMemory.screen_signature == screen_signature,
            MobileLocatorMemory.element_signature == element_signature,
        )
        .first()
    )


def find_by_original_locator(
    db: Session, application_id: int, package_name: str, original_locator: Locator
) -> Optional[MobileLocatorMemory]:
    """Shortcut lookup used on repeat runs: 'have we already healed *this exact*
    broken locator before?' (section 139 — learned locator reuse)."""
    key = _locator_key(original_locator)
    rows = (
        db.query(MobileLocatorMemory)
        .filter(
            MobileLocatorMemory.application_id == application_id,
            MobileLocatorMemory.package_name == package_name,
        )
        .all()
    )
    for row in rows:
        try:
            stored = Locator(**row.original_locator)
        except Exception:
            continue
        if _locator_key(stored) == key:
            return row
    return None


def record_success(
    db: Session,
    application_id: int,
    package_name: str,
    screen_signature: str,
    element_signature: str,
    original_locator: Locator,
    successful_locator: Locator,
    element_attributes: Optional[dict],
    app_version: Optional[str],
    was_healing: bool,
) -> MobileLocatorMemory:
    row = find_memory(db, application_id, screen_signature, element_signature)
    now = datetime.datetime.utcnow()
    if row is None:
        row = MobileLocatorMemory(
            application_id=application_id,
            package_name=package_name,
            screen_signature=screen_signature,
            element_signature=element_signature,
            original_locator=original_locator.dict(),
            successful_locator=successful_locator.dict(),
            element_attributes=element_attributes,
            app_version=app_version,
            first_seen=now,
            last_success=now,
            success_count=1,
            failure_count=0,
            healing_count=1 if was_healing else 0,
        )
        db.add(row)
    else:
        row.successful_locator = successful_locator.dict()
        row.element_attributes = element_attributes
        row.app_version = app_version
        row.last_success = now
        row.success_count += 1
        if was_healing:
            row.healing_count += 1
    db.commit()
    db.refresh(row)
    return row


def record_failure(db: Session, memory_row: MobileLocatorMemory) -> None:
    memory_row.failure_count += 1
    db.commit()


def invalidate(db: Session, memory_row: MobileLocatorMemory) -> None:
    """Rollback support: never overwrite the original locator — just drop the
    learned successful_locator back to the original so future runs re-heal
    from scratch instead of trusting a now-unstable candidate."""
    memory_row.successful_locator = memory_row.original_locator
    memory_row.failure_count = 0
    db.commit()
