"""
Pydantic schemas for the AI Test Execution Platform.
Defines request/response models with strict validation.
"""
from __future__ import annotations

from enum import Enum
import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ActionType(str, Enum):
    GOTO = "goto"
    FILL = "fill"
    CLICK = "click"
    WAIT_FOR = "wait_for"
    ASSERT_VISIBLE = "assert_visible"
    ASSERT_TEXT = "assert_text"
    ASSERT_URL = "assert_url"
    ASSERT_COUNT = "assert_count"
    SCREENSHOT = "screenshot"


class ExecutionStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"


class ErrorType(str, Enum):
    NETWORK_CRITICAL_ERROR = "NETWORK_CRITICAL_ERROR"
    NETWORK_NON_CRITICAL_ERROR = "NETWORK_NON_CRITICAL_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"
    CONSOLE_CRITICAL_ERROR = "CONSOLE_CRITICAL_ERROR"
    CONSOLE_NON_CRITICAL_ERROR = "CONSOLE_NON_CRITICAL_ERROR"
    CONSOLE_ERROR = "CONSOLE_ERROR"
    ASSERTION_FAILURE = "ASSERTION_FAILURE"
    TIMEOUT_ERROR = "TIMEOUT_ERROR"
    NAVIGATION_ERROR = "NAVIGATION_ERROR"
    ELEMENT_NOT_FOUND = "ELEMENT_NOT_FOUND"
    EXECUTION_ERROR = "EXECUTION_ERROR"
    INVALID_INPUT = "INVALID_INPUT"
    PLAYWRIGHT_ENV_ERROR = "PLAYWRIGHT_ENV_ERROR"
    RUNNER_CRASH = "RUNNER_CRASH"
    UNKNOWN_ERROR = "UNKNOWN_ERROR"


# ---------------------------------------------------------------------------
# Runtime config
# ---------------------------------------------------------------------------




class RunConfig(BaseModel):
    """Optional runtime settings for the test execution engine."""

    headless: bool = Field(True, description="Run browser in headless mode")
    timeout: int = Field(
        30_000, ge=1_000, le=120_000, description="Default per-action timeout in ms"
    )
    retries: int = Field(2, ge=0, le=5, description="Default number of retries per step")
    fail_on_console_error: bool = Field(
        True,
        description="Fail the test when browser console errors or failed requests are detected",
    )
    strict_mode: bool = Field(
        False,
        description="In strict mode, any error fails the test. In relaxed mode, only critical errors fail.",
    )
    ignore_memory: bool = Field(
        False,
        description="Bypass selector memory lookup and force healing resolution path.",
    )
    slow_mo: int = Field(
        0,
        ge=0,
        le=2000,
        description="Optional browser slow motion delay in ms for visual demo runs.",
    )


# ---------------------------------------------------------------------------
# Step models
# ---------------------------------------------------------------------------

class TestStep(BaseModel):
    """A single test step with its action and parameters."""

    action: ActionType = Field(..., description="The action to perform")

    # goto
    url: Optional[str] = Field(None, description="URL or path for goto action")

    # fill / click / assert_visible / wait_for / screenshot
    selector: Optional[str] = Field(None, description="CSS/XPath selector")

    # fill / assertions
    value: Optional[str] = Field(None, description="Value for the action")

    # wait_for / per-step timeout
    timeout: Optional[int] = Field(
        None, ge=100, le=120_000, description="Timeout in ms (100–120 000)"
    )

    # screenshot
    name: Optional[str] = Field(None, description="Optional filename prefix for screenshot")

    # retry support
    retries: Optional[int] = Field(None, ge=0, le=5, description="Number of retries on failure")

    # capture screenshot after this step regardless of outcome
    capture_screenshot: bool = Field(
        False, description="Capture a screenshot after this step"
    )

    @field_validator("action", mode="before")
    @classmethod
    def normalize_action(cls, v: Any) -> Any:
        if isinstance(v, str) and v.lower() == "navigate":
            return "goto"
        return v

    @field_validator("url", mode="before")
    @classmethod
    def url_required_for_goto(cls, v: Any, info: Any) -> Any:  # noqa: N805
        return v

    @model_validator(mode="before")
    @classmethod
    def fix_goto_url(cls, data: Any) -> Any:
        if isinstance(data, dict):
            action = data.get("action")
            # If the LLM used 'target' instead of selector/url, map it over
            if "target" in data and not data.get("selector") and not data.get("url"):
                target_val = data.pop("target")
                if action in ("goto", "navigate") or str(action).split(".")[-1] == "GOTO":
                    data["url"] = target_val
                else:
                    data["selector"] = target_val
            
            if action in ("goto", "navigate") or str(action).split(".")[-1] == "GOTO":
                if not data.get("url"):
                    data["url"] = data.get("value") or data.get("selector")
        return data

    class Config:
        use_enum_values = True


class TestRequest(BaseModel):
    """Top-level test run request body."""

    test_name: str = Field(..., min_length=1, max_length=255, description="Human-readable test name")
    base_url: str = Field(..., description="Base URL for the test run")
    steps: List[TestStep] = Field(..., min_length=1, description="Ordered list of test steps")

    # Compatibility top-level settings
    headless: bool = Field(True, description="Run browser in headless mode")
    ignore_memory: bool = Field(
        False,
        description="Bypass selector memory lookup and force healing path for test scenarios.",
    )
    default_timeout: int = Field(
        30_000, ge=1_000, le=120_000, description="Default per-action timeout in ms"
    )
    browser: str = Field("chromium", description="Browser: chromium | firefox | webkit | chrome | edge")
    device: Optional[str] = Field(None, description="Device name for mobile/tablet emulation")
    config: RunConfig = Field(default_factory=RunConfig, description="Optional run configuration")
    screenshot_suite_id: Optional[str] = Field(
        None, description="Optional suite identifier used for screenshot storage grouping"
    )
    screenshot_test_name: Optional[str] = Field(
        None, description="Optional test case identifier used for screenshot storage grouping"
    )

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return v.rstrip("/")

    @field_validator("browser")
    @classmethod
    def validate_browser(cls, v: str) -> str:
        allowed = {"chromium", "firefox", "webkit", "chrome", "edge", "safari"}
        if v not in allowed:
            raise ValueError(f"browser must be one of {allowed}")
        return v



# ---------------------------------------------------------------------------
# Step result
# ---------------------------------------------------------------------------

class StepResult(BaseModel):
    """Result of a single executed step."""

    step_index: int
    action: str
    status: ExecutionStatus
    duration_ms: float = Field(..., description="Execution time in milliseconds")
    screenshot_path: Optional[str] = None
    screenshot_url: Optional[str] = None
    screenshot_exists: bool = False
    captured_at: Optional[str] = None
    before_screenshot_url: Optional[str] = None
    after_screenshot_url: Optional[str] = None
    failure_screenshot_url: Optional[str] = None
    assertion_screenshot_url: Optional[str] = None
    dom_snapshot_url: Optional[str] = None
    html_snapshot_url: Optional[str] = None
    selector_used: Optional[str] = None
    selector_validated: bool = False
    selector_visible: Optional[bool] = None
    selector_enabled: Optional[bool] = None
    selector_unique: Optional[bool] = None
    recovery_attempts: List[Dict[str, Any]] = Field(default_factory=list)
    artifacts: Dict[str, str] = Field(default_factory=dict)
    error: Optional[str] = None
    error_type: Optional[ErrorType] = None
    retries_used: int = 0
    healed: bool = False
    memory_used: bool = False
    healing_type: str = "none"
    original_selector: Optional[str] = None
    new_selector: Optional[str] = None
    selector_score_original: Optional[int] = None
    selector_score_new: Optional[int] = None
    expected_intent: Optional[str] = None
    actual_detected_type: Optional[str] = None
    intent_match: Optional[bool] = None
    logs: List[str] = Field(default_factory=list)
    timestamp: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    url_before: Optional[str] = None
    url_after: Optional[str] = None
    ai_reasoning: Optional[str] = None


# ---------------------------------------------------------------------------
# Test run result
# ---------------------------------------------------------------------------

class TestRunResult(BaseModel):
    """Final result returned after the full test run."""

    test_name: str
    status: ExecutionStatus
    steps_executed: List[StepResult]
    failed_step: Optional[int] = None
    error: Optional[str] = None
    error_type: Optional[ErrorType] = None
    bug_report: Optional[Dict[str, Any]] = None
    screenshot_path: Optional[str] = Field(
        None, description="Path to failure screenshot (if any)"
    )
    screenshot_url: Optional[str] = Field(
        None, description="Public URL to the final test screenshot"
    )
    screenshot_exists: bool = Field(
        False, description="Whether the final screenshot file exists on disk"
    )
    executed_at: Optional[str] = Field(
        None, description="ISO timestamp of test completion"
    )
    trace_url: Optional[str] = Field(None, description="Public URL to Playwright trace zip")
    video_url: Optional[str] = Field(None, description="Public URL to Playwright run video")
    artifact_dir_url: Optional[str] = Field(None, description="Public URL prefix to run artifacts")
    logs: List[str] = Field(default_factory=list)
    total_duration_ms: float = Field(..., description="Wall-clock time for the entire run")
    browser: str
    base_url: str
    warnings: List[Dict] = Field(default_factory=list, description="Non-critical errors that didn't fail the test")
    console_errors: List[Dict] = Field(default_factory=list, description="All console errors encountered")
    network_errors: List[Dict] = Field(default_factory=list, description="All network errors encountered")
    execution_id: Optional[str] = None
    suite_id: Optional[str] = None
    timeline: List[Dict[str, Any]] = Field(default_factory=list)
    test_case_video_url: Optional[str] = None
    test_case_video_path: Optional[str] = None


# ---------------------------------------------------------------------------
# AI Test Generation Models
# ---------------------------------------------------------------------------

class DomElement(BaseModel):
    """Compressed DOM element data for test generation."""

    tag: str = Field(..., description="HTML tag name (input, button, etc.)")
    id: Optional[str] = None
    name: Optional[str] = None
    data_testid: Optional[str] = Field(None, alias="data-testid")
    aria_label: Optional[str] = Field(None, alias="aria-label")
    role: Optional[str] = None
    type: Optional[str] = None
    placeholder: Optional[str] = None
    text: Optional[str] = None
    class_name: Optional[str] = Field(None, alias="class")
    href: Optional[str] = None
    value: Optional[str] = None

    class Config:
        populate_by_name = True


class GeneratedTestRequest(BaseModel):
    """Request to generate a test from natural language."""

    prompt: str = Field(..., min_length=1, max_length=1000, description="Natural language test description")
    base_url: Optional[str] = Field(None, description="Base URL for the test (optional, will be inferred if not provided)")
    dom_elements: Optional[List[DomElement]] = Field(None, description="Compressed DOM elements from the target page for accurate selector generation")


class GeneratedTestStep(BaseModel):
    """A generated test step (simplified version of TestStep)."""

    action: str = Field(..., description="Action type")
    url: Optional[str] = None
    selector: Optional[str] = None
    value: Optional[str] = None
    confidence: float = Field(0.8, ge=0.0, le=1.0, description="Confidence score for selector robustness (0.0-1.0)")

    @field_validator("action", mode="before")
    @classmethod
    def validate_action(cls, v: Any) -> Any:
        if isinstance(v, str) and v.lower() == "navigate":
            v = "goto"
        allowed = {"goto", "fill", "click", "assert_visible", "assert_text", "assert_url", "assert_count"}
        if v not in allowed:
            raise ValueError(f"Unsupported action: {v}. Allowed: {allowed}")
        return v

    @field_validator("url", mode="before")
    @classmethod
    def validate_url(cls, v: Any) -> Any:
        # Allow None for non-goto actions
        return v

    @field_validator("selector", mode="before")
    @classmethod
    def validate_selector(cls, v: Any) -> Any:
        # Allow None for actions that don't require selectors
        return v

    @field_validator("value", mode="before")
    @classmethod
    def validate_value(cls, v: Any) -> Any:
        # Allow None for actions that don't require values
        return v

    @field_validator("confidence", mode="before")
    @classmethod
    def set_confidence_based_on_selector(cls, v: Any, info: Any) -> float:
        """Set confidence score based on selector type if not explicitly provided."""
        if v is not None:
            return float(v)

        selector = info.data.get("selector")
        if not selector:
            return 0.5  # Default for non-selector actions

        action = info.data.get("action")
        selector = str(selector)

        if selector.startswith("#"):
            score = 0.95
        elif "[data-testid" in selector:
            score = 0.90
        elif "[name=" in selector:
            score = 0.85
        elif "[aria-label" in selector or "[role=" in selector:
            score = 0.80
        elif "has-text(" in selector:
            score = 0.70
        elif selector.startswith(".") and len(selector.split()) == 1:
            score = 0.60
        elif ":" in selector or ("[" in selector and "data-testid" not in selector):
            score = 0.40
        else:
            score = 0.50

        # Confidence adjustments
        if selector.startswith("#") or "[data-testid" in selector:
            score += 0.2
        if action == "assert_text":
            score -= 0.1

        return min(max(score, 0.0), 0.99)


class GeneratedTestResponse(BaseModel):
    """Response from test generation."""

    test_name: str = Field(..., min_length=1, max_length=255)
    base_url: str = Field(..., description="Base URL for the test")
    steps: List[GeneratedTestStep] = Field(..., min_length=1)
    is_fallback: bool = Field(False, description="Indicates whether a fallback test was returned")
    reason: Optional[str] = Field(None, description="Reason for fallback or null if LLM succeeded")
    job_id: Optional[str] = Field(None, description="Job ID for async generation result")

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return v.rstrip("/")


class GenerateAndRunRequest(BaseModel):
    """Request to generate and run a test."""

    prompt: Optional[str] = Field(None, min_length=1, max_length=1000, description="Natural language test description")
    job_id: Optional[str] = Field(None, description="Optional existing generation job_id to reuse")
    test: Optional[Dict[str, Any]] = Field(None, description="Direct structured test payload for immediate execution")
    base_url: Optional[str] = Field(None, description="Base URL for the test (optional, will be inferred if not provided)")
    dom_elements: Optional[List[DomElement]] = Field(None, description="Compressed DOM elements from the target page for accurate selector generation")
    browser: str = Field("chromium", description="Browser: chromium | firefox | webkit | chrome | edge")
    device: Optional[str] = Field(None, description="Device name for mobile/tablet emulation")
    headless: bool = Field(True, description="Run browser in headless mode")
    config: RunConfig = Field(default_factory=RunConfig, description="Optional run configuration")

    @field_validator("browser")
    @classmethod
    def validate_browser(cls, v: str) -> str:
        allowed = {"chromium", "firefox", "webkit", "chrome", "edge", "safari"}
        if v not in allowed:
            raise ValueError(f"browser must be one of {allowed}")
        return v


    @model_validator(mode="after")
    def validate_prompt_or_job_id(self) -> "GenerateAndRunRequest":
        if not self.prompt and not self.job_id and not self.test:
            raise ValueError("Either test, prompt, or job_id must be provided")
        return self


class GenerateAndRunResponse(BaseModel):
    """Response from generate-and-run."""

    executed_test: GeneratedTestResponse
    source: str = Field(..., description="Execution source: ai | fallback | direct")
    decision_reason: str = Field(..., description="Why ai or fallback was selected")
    execution_result: Optional[TestRunResult] = None
    job_id: Optional[str] = None


class JobPendingResponse(BaseModel):
    """Async generation job still in progress."""

    status: Literal["pending"] = Field("pending")


class JobRunningResponse(BaseModel):
    """Async generation job currently executing attempts."""

    status: Literal["running"] = Field("running")


class JobDoneResponse(BaseModel):
    """Async generation job completed successfully."""

    status: Literal["done"] = Field("done")
    result: GeneratedTestResponse


class JobFailedResponse(BaseModel):
    """Async generation job failed."""

    status: Literal["failed"] = Field("failed")
    error: str


JobStatusResponse = JobPendingResponse | JobRunningResponse | JobDoneResponse | JobFailedResponse


class SiteMapResponse(BaseModel):
    id: int
    project_id: int
    url: str
    page_title: Optional[str] = None
    metadata_json: Optional[Dict[str, Any]] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class DiscoveredFlowResponse(BaseModel):
    id: int
    project_id: int
    name: str
    description: Optional[str] = None
    flow_type: Optional[str] = None
    generated_steps: Optional[Dict[str, Any]] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}
