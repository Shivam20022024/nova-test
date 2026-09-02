"""
Pydantic contracts for the Android Mobile Testing Engine.

Mirrors the platform-wide execution contract:

    TestEngine.execute(TestIntent, Environment, DataSet, ExecutionPolicy) -> ExecutionResult

kept local to the mobile module for now (rule: AutoHeal/mobile owns its own
working implementation this phase, but must stay contract-compatible with a
future shared execution service).
"""
from __future__ import annotations

import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ── Action vocabulary (baseline — ActionRegistry is data-driven, not a closed enum) ──

BASELINE_ACTIONS = [
    "LAUNCH", "TERMINATE", "RESTART", "RESET_APP", "INSTALL", "UNINSTALL", "CLEAR_DATA",
    "TAP", "DOUBLE_TAP", "LONG_PRESS", "ENTER_TEXT", "REPLACE_TEXT", "APPEND_TEXT",
    "CLEAR_TEXT", "DELETE_TEXT", "PRESS_KEY", "BACK", "HOME", "RECENT_APPS",
    "SWIPE", "SCROLL", "SCROLL_TO_TEXT", "DRAG", "PINCH", "ZOOM", "SET_ORIENTATION",
    "WAIT", "WAIT_FOR_ELEMENT", "WAIT_FOR_TEXT", "WAIT_FOR_ACTIVITY", "WAIT_FOR_GONE",
    "ASSERT_VISIBLE", "ASSERT_NOT_VISIBLE", "ASSERT_TEXT", "ASSERT_ENABLED",
    "ASSERT_DISABLED", "ASSERT_SELECTED", "ASSERT_CHECKED", "ASSERT_ATTRIBUTE",
    "ASSERT_ACTIVITY", "ASSERT_CRASH_FREE",
    "TAKE_SCREENSHOT", "CAPTURE_HIERARCHY",
    # Device-condition actions (integration plan Phase 1) — grant/deny a runtime
    # permission, send the app to background and back, post a local system
    # notification, toggle/throttle the network, and mock GPS location.
    "GRANT_PERMISSION", "DENY_PERMISSION", "SET_BACKGROUND",
    "POST_LOCAL_NOTIFICATION", "SET_NETWORK_PROFILE", "SET_MOCK_LOCATION",
]

CRITICAL_ACTION_HINTS = {"transfer", "submit", "delete", "pay", "confirm_payment", "approve"}


class Locator(BaseModel):
    """A single locator strategy + value. `strategy` in accessibility_id|resource_id|
    content_desc|text|class_name|xpath|coordinates."""
    strategy: str
    value: str
    # Optional semantic hint used to build the initial element signature (never required).
    hint: Optional[str] = None


class TestStep(BaseModel):
    action: str
    locator: Optional[Locator] = None
    value: Optional[str] = None
    timeout_ms: int = 10000
    risk: str = "LOW_RISK"  # LOW_RISK|MEDIUM_RISK|HIGH_RISK|CRITICAL
    expected: Optional[str] = None
    description: Optional[str] = None


class EvidencePolicy(BaseModel):
    screenshot_mode: str = "IMPORTANT_STEPS"  # NONE|FAILURE_ONLY|IMPORTANT_STEPS|EVERY_STEP|FULL
    capture_hierarchy_on_failure: bool = True
    video_mode: str = "FULL_TEST"  # OFF|FAILURE_ONLY|FULL_TEST — section 52


class HealingPolicy(BaseModel):
    enabled: bool = True
    auto_apply_threshold: float = 95.0
    review_threshold: float = 80.0
    critical_action_approval_required: bool = True


class ExecutionPolicy(BaseModel):
    healing: HealingPolicy = Field(default_factory=HealingPolicy)
    evidence: EvidencePolicy = Field(default_factory=EvidencePolicy)
    retry_transient_failures: bool = True
    max_retries: int = 1
    step_timeout_ms: int = 15000
    test_timeout_ms: int = 300000
    # Suite context only: bring the app back to a known clean state before each
    # test so one test's failure can't cascade into the next. Generic — just
    # terminate + relaunch (optionally clear data) via the existing actions.
    reset_between_tests: bool = True
    clear_data_between_tests: bool = False
    # Suite context only: if a step's locator can't be confidently healed,
    # mark that one test BLOCKED and move on to the next test instead of
    # leaving the whole suite stalled waiting for a human.
    continue_on_blocked_heal: bool = True


class TestIntent(BaseModel):
    """Canonical execution input: a named, ordered sequence of steps against an app."""
    name: str
    description: Optional[str] = None
    steps: List[TestStep]
    application_id: Optional[int] = None
    application_version_id: Optional[int] = None


class Environment(BaseModel):
    name: str = "DEV"  # DEV|QA|STAGING|PROD|LIVE


class DataSet(BaseModel):
    values: Dict[str, Any] = Field(default_factory=dict)


# ── Application / device / execution API I/O ─────────────────────────────────

class ApplicationVersionOut(BaseModel):
    id: int
    version_name: Optional[str]
    version_code: Optional[str]
    sha256: str
    size: int
    min_sdk: Optional[str]
    target_sdk: Optional[str]
    permissions: Optional[List[str]]
    activities: Optional[List[str]]
    launchable_activity: Optional[str]
    framework_hint: Optional[str]
    status: str
    validation_error: Optional[str]

    class Config:
        from_attributes = True


class ApplicationOut(BaseModel):
    id: int
    name: str
    package_name: str
    platform: str
    versions: List[ApplicationVersionOut] = []

    class Config:
        from_attributes = True


class DeviceOut(BaseModel):
    id: int
    serial: str
    manufacturer: Optional[str]
    model: Optional[str]
    android_version: Optional[str]
    api_level: Optional[str]
    is_emulator: bool
    battery_level: Optional[int] = None
    battery_status: Optional[str] = None
    status: str
    last_health_check: Optional[datetime.datetime] = None

    class Config:
        from_attributes = True


class TestCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    application_id: Optional[int] = None
    steps: List[TestStep]
    evidence_policy: Optional[EvidencePolicy] = None
    healing_policy: Optional[HealingPolicy] = None
    risk_level: str = "LOW_RISK"
    device_id: Optional[int] = None  # when set, wraps this test in a suite-of-one and auto-runs it immediately
    release_id: Optional[str] = None  # optional Release tag for the auto-run, if device_id is also set


class ExecutionCreateRequest(BaseModel):
    test_id: int
    device_id: Optional[int] = None
    device_serial: Optional[str] = None
    application_version_id: Optional[int] = None
    environment: str = "DEV"
    data_set: Optional[Dict[str, Any]] = None
    execution_policy: Optional[ExecutionPolicy] = None
    idempotency_key: Optional[str] = None
    # Optional tag linking this run to a web-side Release (see
    # ExecutionCreateRequest's release_id on the Node side for the same
    # concept) — a plain id string, not validated against anything here.
    release_id: Optional[str] = None


class CompatibilityRunCreateRequest(BaseModel):
    """Fan the same test out across several devices at once — the
    compatibility-coverage use case (does this app behave the same way on
    different Android versions/manufacturers/screen sizes), not the
    throughput use case (run many unrelated tests concurrently)."""
    test_id: int
    device_ids: List[int] = Field(..., min_length=2)
    application_version_id: Optional[int] = None
    environment: str = "DEV"
    execution_policy: Optional[ExecutionPolicy] = None


class HealingManualFixRequest(BaseModel):
    """Body for POST /healing/{id}/approve. AutoHeal itself never needs this
    — it only matters for a REQUIRES_REVIEW record, the genuine dead-end
    where the engine found zero candidate locators to try on its own. In
    that case there is nothing to "approve"; this is a person supplying a
    replacement locator to retry with. Ignored for any record that already
    has a candidate of its own."""
    locator: Optional[Locator] = None


class SuiteParallelRunRequest(BaseModel):
    """Fan a suite's tests out across several devices at once instead of
    running them one after another on a single shared device/session (that's
    what POST /suites/{id}/run does) — the throughput use case (integration
    plan Phase 2), distinct from CompatibilityRunCreateRequest's coverage
    use case (same test, many devices)."""
    device_ids: List[int] = Field(..., min_length=2)


class StepResultOut(BaseModel):
    step_index: int
    action: str
    status: str
    locator: Optional[Dict[str, Any]]
    resolved_locator: Optional[Dict[str, Any]]
    expected: Optional[str]
    actual: Optional[str]
    duration_ms: Optional[int]
    failure_id: Optional[int]
    healing_id: Optional[int]

    class Config:
        from_attributes = True


class ExecutionOut(BaseModel):
    id: int
    execution_uid: str
    status: str
    test_id: int
    device_id: Optional[int]
    environment: str = "DEV"
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int]
    step_results: List[StepResultOut] = []
    result_json: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class HealingRecordOut(BaseModel):
    id: int
    execution_id: int
    step_index: int
    original_locator: Dict[str, Any]
    candidate_locators: List[Dict[str, Any]]
    replacement_locator: Optional[Dict[str, Any]]
    confidence: float
    risk_level: str
    status: str
    reason: Optional[str]
    created_at: Optional[datetime.datetime] = None

    class Config:
        from_attributes = True
