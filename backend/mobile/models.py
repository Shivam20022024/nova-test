"""
SQLAlchemy models for the Android Mobile Testing Engine.

These register on this module's own declarative `Base` (mobile.database) —
a dedicated local SQLite database with no external dependency.
"""
from __future__ import annotations

import datetime
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from mobile.database import Base


def _uid() -> str:
    return uuid.uuid4().hex


class MobileApplication(Base):
    __tablename__ = "mobile_applications"

    id = Column(Integer, primary_key=True, index=True)
    # Loose reference to the shared platform's projects.id (a different
    # database/engine — see mobile/database.py) — intentionally not a real
    # ForeignKey, since SQLite can't enforce a constraint across databases.
    project_id = Column(Integer, nullable=True)
    # The actual project scope. project_id above is dead: it is an Integer and
    # the platform's Project.id is a uuid string, so it can never hold a real
    # project reference — it is only ever written, never read. This column is
    # what /applications filters on, and it is the ONLY scoping anchor in this
    # schema: tests, suites and executions all reach a project by way of their
    # application_id, so nothing else needs its own copy.
    project_uuid = Column(String(64), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    package_name = Column(String(255), index=True, nullable=False)
    platform = Column(String(20), nullable=False, default="android")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    versions = relationship("MobileApplicationVersion", back_populates="application", cascade="all, delete-orphan")


class MobileApplicationVersion(Base):
    __tablename__ = "mobile_application_versions"

    id = Column(Integer, primary_key=True, index=True)
    application_id = Column(Integer, ForeignKey("mobile_applications.id", ondelete="CASCADE"), nullable=False)

    version_name = Column(String(100), nullable=True)
    version_code = Column(String(50), nullable=True)
    sha256 = Column(String(64), index=True, nullable=False)
    size = Column(Integer, nullable=False, default=0)
    file_path = Column(Text, nullable=False)
    original_filename = Column(String(500), nullable=True)

    min_sdk = Column(String(10), nullable=True)
    target_sdk = Column(String(10), nullable=True)
    permissions = Column(JSON, nullable=True)     # list[str]
    activities = Column(JSON, nullable=True)      # list[str]
    launchable_activity = Column(String(500), nullable=True)
    framework_hint = Column(String(50), nullable=True)  # NATIVE_VIEWS | COMPOSE | REACT_NATIVE | FLUTTER | WEBVIEW | UNKNOWN

    # Cached result of the on-device exploration crawl (mobile/explorer.py) for
    # THIS exact build — a map of the app's real screens + real interactive
    # elements + how to navigate between them. Grounds AI test generation in
    # what the app actually is, instead of what the model imagines. Crawled
    # once per APK build (keyed by this row), reused for every generation after.
    screen_map = Column(JSON, nullable=True)
    screen_map_captured_at = Column(DateTime, nullable=True)

    # UPLOADING | VALIDATING | VALID | INVALID | QUARANTINED | DELETED
    status = Column(String(30), nullable=False, default="UPLOADING")
    validation_error = Column(Text, nullable=True)
    uploaded_at = Column(DateTime, default=datetime.datetime.utcnow)

    application = relationship("MobileApplication", back_populates="versions")


class MobileDevice(Base):
    __tablename__ = "mobile_devices"

    id = Column(Integer, primary_key=True, index=True)
    serial = Column(String(255), unique=True, index=True, nullable=False)
    manufacturer = Column(String(100), nullable=True)
    model = Column(String(100), nullable=True)
    android_version = Column(String(20), nullable=True)
    api_level = Column(String(10), nullable=True)
    architecture = Column(String(30), nullable=True)
    resolution = Column(String(30), nullable=True)
    density = Column(String(20), nullable=True)
    is_emulator = Column(Boolean, default=True)
    battery_level = Column(Integer, nullable=True)  # 0-100, or null if unreadable
    battery_status = Column(String(20), nullable=True)  # charging|discharging|full|not_charging|unknown

    # AVAILABLE | RESERVED | UNHEALTHY | OFFLINE | QUARANTINED
    status = Column(String(30), nullable=False, default="OFFLINE")
    last_health_check = Column(DateTime, nullable=True)
    last_health_detail = Column(JSON, nullable=True)
    reserved_by_execution = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class MobileTest(Base):
    __tablename__ = "mobile_tests"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, nullable=True)  # loose reference — see MobileApplication.project_id
    application_id = Column(Integer, ForeignKey("mobile_applications.id", ondelete="SET NULL"), nullable=True)
    suite_id = Column(Integer, ForeignKey("mobile_test_suites.id", ondelete="SET NULL"), nullable=True)

    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    steps = Column(JSON, nullable=False)  # list[TestStep dict] — the TestIntent step sequence

    evidence_policy = Column(JSON, nullable=True)   # {screenshot_mode, video_mode}
    healing_policy = Column(JSON, nullable=True)     # {enabled, auto_apply_threshold, review_threshold}
    risk_level = Column(String(20), nullable=False, default="LOW_RISK")  # LOW_RISK|MEDIUM_RISK|HIGH_RISK|CRITICAL

    # Traceability back to the client's original test-case document, when this
    # test came from an import/generation: {test_case_id, module, expected_result,
    # type, priority, data, automatable, not_automatable_reason}. Nullable —
    # hand-built tests don't have a source row. Lets the suite report answer
    # "what did the client ask for vs what actually happened".
    source_meta = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    suite = relationship("MobileTestSuite", back_populates="tests")


class MobileTestSuite(Base):
    """A group of tests that were created together from one upload — a CSV/
    XLSX test-case sheet, a bulk JSON import, a natural-language/document
    generation — and run together as one unit against one device, so the
    dashboard shows 'these 124 tests came from this one file, for this one
    app' instead of 124 unrelated-looking rows. Status/counts are always
    computed from the actual child executions, never hand-set."""
    __tablename__ = "mobile_test_suites"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    application_id = Column(Integer, ForeignKey("mobile_applications.id", ondelete="SET NULL"), nullable=True)
    device_id = Column(Integer, ForeignKey("mobile_devices.id", ondelete="SET NULL"), nullable=True)
    source = Column(String(30), nullable=False, default="MANUAL")  # CSV_IMPORT|XLSX_BATCH|NL_GENERATE|MANUAL

    # QUEUED|RUNNING|COMPLETED|INTERRUPTED (INTERRUPTED = backend restarted
    # mid-run; never auto-resumed, re-run manually via POST /suites/{id}/run)
    status = Column(String(20), nullable=False, default="QUEUED")
    combined_video_path = Column(Text, nullable=True)  # set once the whole-suite recording is cut/finalized

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    tests = relationship("MobileTest", back_populates="suite")
    executions = relationship("MobileExecution", back_populates="suite")


class MobileCompatibilityRun(Base):
    """One test definition fanned out across several devices at once, so a
    single 'does this work everywhere' question gets one authoritative
    report instead of N separately-tracked executions the user has to
    correlate by hand."""
    __tablename__ = "mobile_compatibility_runs"

    id = Column(Integer, primary_key=True, index=True)
    test_id = Column(Integer, ForeignKey("mobile_tests.id", ondelete="CASCADE"), nullable=False)

    # RUNNING while any child execution is non-terminal, else COMPLETED —
    # computed from the child executions, never hand-set (rule: status must
    # always reflect real child state, not be asserted independently of it).
    status = Column(String(20), nullable=False, default="RUNNING")

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    executions = relationship("MobileExecution", back_populates="compatibility_run")


class MobileExecution(Base):
    __tablename__ = "mobile_executions"

    id = Column(Integer, primary_key=True, index=True)
    execution_uid = Column(String(64), unique=True, index=True, default=_uid)
    idempotency_key = Column(String(255), unique=True, index=True, nullable=True)

    test_id = Column(Integer, ForeignKey("mobile_tests.id", ondelete="CASCADE"), nullable=False)
    application_version_id = Column(Integer, ForeignKey("mobile_application_versions.id", ondelete="SET NULL"), nullable=True)
    device_id = Column(Integer, ForeignKey("mobile_devices.id", ondelete="SET NULL"), nullable=True)
    compatibility_run_id = Column(Integer, ForeignKey("mobile_compatibility_runs.id", ondelete="SET NULL"), nullable=True)
    suite_id = Column(Integer, ForeignKey("mobile_test_suites.id", ondelete="SET NULL"), nullable=True)

    # Where in the suite's one continuous recording this execution's steps
    # actually happened — lets a per-test video be cut from the master
    # recording after the fact instead of running a second concurrent
    # recorder (Android doesn't reliably support two at once).
    suite_video_offset_start_ms = Column(Integer, nullable=True)
    suite_video_offset_end_ms = Column(Integer, nullable=True)
    video_path = Column(Text, nullable=True)  # this execution's own cut/standalone video, once ready

    environment = Column(String(50), nullable=False, default="DEV")

    # CREATED|QUEUED|ALLOCATING_DEVICE|STARTING_APPIUM|STARTING_SESSION|RUNNING|HEALING|RETRYING|
    # WAITING_APPROVAL|CLEANUP|PASSED|FAILED|BLOCKED|CANCELLED|TIMEOUT|INFRA_FAILURE|REQUIRES_REVIEW
    status = Column(String(30), nullable=False, default="CREATED")

    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)

    appium_session_id = Column(String(255), nullable=True)
    result_json = Column(JSON, nullable=True)     # full ExecutionResult snapshot
    environment_snapshot = Column(JSON, nullable=True)
    adapter_version = Column(String(20), nullable=False, default="1.0.0")
    cancel_requested = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    step_results = relationship("MobileStepResult", back_populates="execution", cascade="all, delete-orphan")
    compatibility_run = relationship("MobileCompatibilityRun", back_populates="executions")
    suite = relationship("MobileTestSuite", back_populates="executions")


class MobileStepResult(Base):
    __tablename__ = "mobile_step_results"

    id = Column(Integer, primary_key=True, index=True)
    execution_id = Column(Integer, ForeignKey("mobile_executions.id", ondelete="CASCADE"), nullable=False)

    step_index = Column(Integer, nullable=False)
    action = Column(String(50), nullable=False)
    status = Column(String(20), nullable=False)  # PASSED|FAILED|HEALED|SKIPPED|BLOCKED

    locator = Column(JSON, nullable=True)
    resolved_locator = Column(JSON, nullable=True)
    fallback_strategy = Column(String(50), nullable=True)

    expected = Column(Text, nullable=True)
    actual = Column(Text, nullable=True)

    started_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)

    failure_id = Column(Integer, ForeignKey("mobile_failures.id", ondelete="SET NULL"), nullable=True)
    healing_id = Column(Integer, ForeignKey("mobile_healing_records.id", ondelete="SET NULL"), nullable=True)

    execution = relationship("MobileExecution", back_populates="step_results")


class MobileEvidence(Base):
    __tablename__ = "mobile_evidence"

    id = Column(Integer, primary_key=True, index=True)
    execution_id = Column(Integer, ForeignKey("mobile_executions.id", ondelete="CASCADE"), nullable=False)
    step_index = Column(Integer, nullable=True)

    # SCREENSHOT|VIDEO|UI_HIERARCHY|LOGCAT|APPIUM_LOG|CRASH_LOG|DEVICE_METADATA|
    # HEALING_RECORD|FAILURE_REPORT
    artifact_type = Column(String(30), nullable=False)
    storage_path = Column(Text, nullable=False)
    sha256 = Column(String(64), nullable=True)
    mime_type = Column(String(100), nullable=True)
    size = Column(Integer, nullable=True)
    redaction_status = Column(String(20), nullable=False, default="NONE")  # NONE|REDACTED
    captured_at = Column(DateTime, default=datetime.datetime.utcnow)
    evidence_metadata = Column(JSON, nullable=True)


class MobileLocatorMemory(Base):
    __tablename__ = "mobile_locator_memory"

    id = Column(Integer, primary_key=True, index=True)
    application_id = Column(Integer, ForeignKey("mobile_applications.id", ondelete="CASCADE"), nullable=False)
    package_name = Column(String(255), index=True, nullable=False)

    screen_signature = Column(String(128), index=True, nullable=False)
    element_signature = Column(String(128), index=True, nullable=False)

    original_locator = Column(JSON, nullable=False)
    successful_locator = Column(JSON, nullable=False)
    element_attributes = Column(JSON, nullable=True)

    app_version = Column(String(100), nullable=True)
    first_seen = Column(DateTime, default=datetime.datetime.utcnow)
    last_success = Column(DateTime, default=datetime.datetime.utcnow)
    success_count = Column(Integer, default=0)
    failure_count = Column(Integer, default=0)
    healing_count = Column(Integer, default=0)


class MobileHealingRecord(Base):
    __tablename__ = "mobile_healing_records"

    id = Column(Integer, primary_key=True, index=True)
    execution_id = Column(Integer, ForeignKey("mobile_executions.id", ondelete="CASCADE"), nullable=False)
    step_index = Column(Integer, nullable=False)
    test_id = Column(Integer, ForeignKey("mobile_tests.id", ondelete="CASCADE"), nullable=False)

    original_locator = Column(JSON, nullable=False)
    candidate_locators = Column(JSON, nullable=False)   # list of {locator, score, signals}
    replacement_locator = Column(JSON, nullable=True)

    confidence = Column(Float, nullable=False, default=0.0)
    risk_level = Column(String(20), nullable=False, default="LOW_RISK")

    # PENDING_VALIDATION|APPLIED|VALIDATED|VALIDATION_FAILED|PENDING_APPROVAL|
    # APPROVED|REJECTED|ROLLED_BACK|REQUIRES_REVIEW
    status = Column(String(30), nullable=False, default="PENDING_VALIDATION")
    reason = Column(Text, nullable=True)
    validation_result = Column(JSON, nullable=True)

    algorithm_version = Column(String(20), nullable=False, default="1.0.0")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)


class MobileFailure(Base):
    __tablename__ = "mobile_failures"

    id = Column(Integer, primary_key=True, index=True)
    execution_id = Column(Integer, ForeignKey("mobile_executions.id", ondelete="CASCADE"), nullable=False)
    step_index = Column(Integer, nullable=True)

    category = Column(String(50), nullable=False)      # e.g. LOCATOR_FAILURE, APP_CRASH, ...
    error_code = Column(String(50), nullable=True)      # e.g. ELEMENT_NOT_FOUND
    message = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)
    rationale = Column(Text, nullable=True)
    recommended_action = Column(String(100), nullable=True)
    evidence_refs = Column(JSON, nullable=True)          # list[int] evidence ids

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
