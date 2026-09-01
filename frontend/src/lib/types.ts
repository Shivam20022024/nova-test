/**
 * Shapes returned by the Node backend (`backend-node`).
 *
 * These mirror `prisma/schema.prisma` and the JSON each route actually sends —
 * not what we wish it sent. Where the backend stores JSON inside a TEXT column
 * (`logs`, `stepLogs`, `traceData`, `planData`) the field is typed as `string`
 * here, because that is genuinely what arrives over the wire.
 */

/* ── Core entities ────────────────────────────────────────────────────── */

export type Project = {
  id: string
  name: string
  description: string | null
  userId: string
  createdAt: string
  updatedAt: string
}

/** A suite's `type` decides which execution pipeline a run uses. */
export type SuiteType = 'WEB' | 'API' | 'DB'

export type TestSuite = {
  id: string
  name: string
  description: string | null
  type: SuiteType
  projectId: string
  createdAt: string
  updatedAt: string
}

/**
 * The backend model is `TestRun`; the UI calls these "test cases".
 * `/suites/:id/cases` parses `steps` from its stored string before responding,
 * so it arrives as an array.
 */
export type TestCase = {
  id: string
  name: string
  /** Stored as `intent` on the model; the create route maps `description` onto it. */
  intent: string
  steps: unknown[]
  suiteId: string
  createdAt: string
  updatedAt: string
}

/* ── Executions ───────────────────────────────────────────────────────── */

/**
 * Every status the worker and routes can write. `COMPLETED` is the success
 * terminal state for autonomous runs, while `PASSED` comes from older rows —
 * both must be treated as success. `'Completed With Warnings'` is written
 * verbatim (mixed case) when Jira syncing fails after an otherwise finished run.
 */
export type ExecutionStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'GENERATING_SCRIPT'
  | 'HEALING'
  | 'PASSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'Completed With Warnings'

export type ExecutionType = 'WEB' | 'API' | 'DB'

export type Artifact = {
  id: string
  executionLogId: string
  storagePath: string
  url: string
  createdAt: string
}

export type HealingEventStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export type HealingEvent = {
  id: string
  executionLogId: string
  originalSelector: string
  healedSelector: string
  success: boolean
  status: HealingEventStatus
  testName: string | null
  stepIndex: number | null
  createdAt: string
  /**
   * `/healing` embeds only the suite/project chain, not the full execution
   * row — the execution's own logs/stepLogs/traceData are large text blobs
   * that this list doesn't need and that made the query time out at scale.
   */
  executionLog?: {
    suite?: Pick<TestSuite, 'name' | 'projectId'> & { project?: Pick<Project, 'id' | 'name'> }
  }
}

export type ExecutionLog = {
  id: string
  suiteId: string
  status: ExecutionStatus
  browser: string
  executionType: ExecutionType
  testName: string | null
  targetUrl: string | null
  description: string | null
  excelBatchId: string | null
  excelBatchName: string | null
  durationMs: number | null
  startedAt: string | null
  completedAt: string | null
  logs: string | null
  stepLogs: string | null
  traceData: string | null
  planData: string | null
  jiraTicketId: string | null
  jiraTicketUrl: string | null
  jiraAttachmentCount: number | null
  jiraSyncTimestamp: string | null
  visualRegressionData: string | null
  createdAt: string
  updatedAt: string
}

/** `GET /executions` includes the suite and its project for display. */
export type ExecutionListItem = ExecutionLog & {
  suite?: TestSuite & { project?: Project }
}

/**
 * `GET /executions/:id`. Note the route parses `stepLogs` into an array before
 * responding, overriding the string on `ExecutionLog`. While a run is still
 * `QUEUED` or `RUNNING` the route returns a deliberately reduced payload with
 * empty artifact arrays, so treat every collection here as possibly empty.
 */
export type ExecutionDetail = Omit<ExecutionLog, 'stepLogs'> & {
  stepLogs: unknown[]
  screenshots: Artifact[]
  videos: Artifact[]
  reports: Artifact[]
  healingEvents?: HealingEvent[]
  /** Only present on the reduced in-progress payload. */
  message?: string
}

export type ExecutionTrace = {
  id: string
  status: ExecutionStatus
  traceEvents: unknown[]
  screenshots: Artifact[]
  videos: Artifact[]
}

export type ExecutionPlan = {
  id: string
  plan: Record<string, unknown>
}

/* ── Dashboard ────────────────────────────────────────────────────────── */

export type DashboardSummary = {
  totalExecutions: number
  passedCount: number
  failedCount: number
  selfHealingCount: number
  successRate: number
  /** Seconds, already rounded by the backend. */
  avgDuration: number
}

export type ExecutionTrendPoint = {
  date: string
  passed: number
  failed: number
}

export type BrowserDistributionEntry = {
  browser: string
  count: number
}

/**
 * `recent-executions` returns a mixed list: plain runs, plus one collapsed
 * folder per Excel batch. Statuses here are lower-cased by the backend, unlike
 * everywhere else.
 */
export type RecentExecutionRow = {
  type: 'execution'
  id: string
  run_id: string
  testName: string
  browser: string
  projectName: string
  status: string
  /** Seconds. */
  duration: number
  startedAt: string | null
}

export type RecentExecutionFolder = {
  type: 'folder'
  id: string
  batchId: string
  name: string
  projectName: string
  count: number
  passed: number
  failed: number
  totalDuration: number
  startedAt: string | null
  executions: Array<{
    id: string
    run_id: string
    testName: string
    browser: string
    status: string
    duration: number
    startedAt: string | null
  }>
}

export type RecentExecutionItem = RecentExecutionRow | RecentExecutionFolder

/* ── Discovery (AppGraph) ─────────────────────────────────────────────── */

/** The discovery routes rename model fields, so this is not `DiscoveredFlow`. */
export type DiscoveredFlow = {
  id: string
  name: string
  description: string
  flow_type: string
  generated_steps: unknown[]
}

/* ── Jira ─────────────────────────────────────────────────────────────── */

export type JiraConfig = {
  id: string
  projectId: string
  baseUrl: string
  email: string
  /** Always masked as `********` when read back. */
  apiToken: string
  projectKey: string
  issueType: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type JiraHealth = {
  jiraConnected: boolean
  authenticationStatus: string
  projectVerified: boolean
  availableProjects?: Array<{ key: string; name?: string }>
}

/* ── Runs ─────────────────────────────────────────────────────────────── */

export type ExcelTestCase = {
  id: string
  name: string
  steps: string
  testData: string
  expectedResult: string
  targetUrl: string
}

export type ExcelImportResult = {
  success: boolean
  count: number
  testcases: ExcelTestCase[]
  detectedUrl: string | null
}

export type QueuedRun = {
  message: string
  executionIds: string[]
  jobs?: string[]
  jobId?: string
}

/* ── Mobile testing (Android engine, backend/mobile) ──────────────────── */

/**
 * Shapes from the Python mobile engine, proxied through backend-node at
 * `/api/v1/mobile`. Two things differ from every other type in this file and
 * are deliberate, not sloppiness:
 *
 *  - Numeric ids. That engine uses SQLAlchemy autoincrement integers, not the
 *    string uuids the Node backend uses. Do not "normalise" them.
 *  - snake_case fields. FastAPI serialises Python attribute names verbatim;
 *    renaming them here would misrepresent the wire format.
 *
 * Mobile records are NOT scoped to the active Project. `project_id` exists on
 * the models but is unenforced and ignored by every query (IMPLEMENTATION.md
 * §12), so every signed-in user sees every APK and every run.
 */

export type MobileApplicationVersion = {
  id: number
  version_name: string | null
  version_code: string | null
  sha256: string
  size: number
  min_sdk: string | null
  target_sdk: string | null
  permissions: string[]
  activities: string[]
  launchable_activity: string | null
  /** Drives the upload-time warning; FLUTTER means locators cannot work at all. */
  framework_hint:
    | 'NATIVE_VIEWS' | 'COMPOSE' | 'REACT_NATIVE' | 'FLUTTER' | 'WEBVIEW' | 'UNKNOWN' | null
  status: string
  validation_error: string | null
}

export type MobileApplication = {
  id: number
  name: string
  package_name: string
  platform: string
  versions?: MobileApplicationVersion[]
}

export type MobileUploadResult = {
  application: MobileApplication
  version_id: number
  /** True when this exact APK (by sha256) was already uploaded. */
  duplicate: boolean
  compatibility_warning: string | null
}

export type MobileDeviceStatus =
  | 'AVAILABLE' | 'RESERVED' | 'UNHEALTHY' | 'OFFLINE' | 'QUARANTINED'

export type MobileDevice = {
  id: number
  serial: string
  manufacturer: string | null
  model: string | null
  android_version: string | null
  api_level: number | null
  is_emulator: boolean
  battery_level: number | null
  battery_status: string | null
  status: MobileDeviceStatus
  last_health_check: string | null
}

export type MobileDeviceHealth = {
  healthy: boolean
  checks: Record<string, boolean>
}

export type MobileLocator = {
  strategy: 'resource_id' | 'accessibility_id' | 'text' | 'xpath' | 'class_name' | 'semantic'
  value: string
  hint?: string
}

export type MobileTestStep = {
  action: string
  locator: MobileLocator | null
  value?: string | null
  timeout_ms?: number
  risk?: 'LOW_RISK' | 'MEDIUM_RISK' | 'HIGH_RISK' | 'CRITICAL'
  expected?: string | null
}

export type MobileTest = {
  id: number
  name: string
  description: string | null
  application_id: number | null
  steps: MobileTestStep[]
  risk_level: string
  created_at: string
}

/** Every status the engine can write (IMPLEMENTATION.md §11). */
export type MobileExecutionStatus =
  | 'CREATED' | 'QUEUED' | 'ALLOCATING_DEVICE' | 'STARTING_APPIUM' | 'STARTING_SESSION'
  | 'RUNNING' | 'HEALING' | 'RETRYING' | 'WAITING_APPROVAL' | 'CLEANUP'
  | 'PASSED' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT'
  | 'INFRA_FAILURE' | 'REQUIRES_REVIEW' | 'SKIPPED'

/** Anything not in here is still in flight, so polling should continue. */
export const MOBILE_TERMINAL_STATUSES: readonly MobileExecutionStatus[] = [
  'PASSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'REQUIRES_REVIEW', 'INFRA_FAILURE', 'SKIPPED',
]

export type MobileStepResult = {
  step_index: number
  action: string
  status: 'PASSED' | 'FAILED' | 'HEALED' | 'SKIPPED' | 'BLOCKED'
  locator: MobileLocator | null
  resolved_locator: MobileLocator | null
  actual: string | null
  duration_ms: number | null
  failure_id: number | null
  healing_id: number | null
}

export type MobileExecution = {
  id: number
  execution_uid?: string
  status: MobileExecutionStatus
  test_id: number
  test_name?: string | null
  device_id: number | null
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  result_json?: Record<string, unknown> | null
  step_results?: MobileStepResult[]
}

/** One row of a suite report — carries the client's original test-case columns
 *  so expected can be shown against actual. */
export type MobileSuiteTestRow = {
  test_id: number
  name: string
  execution_id: number | null
  status: MobileExecutionStatus | 'QUEUED'
  duration_ms: number | null
  video_url: string | null
  test_case_id: string | null
  module: string | null
  priority: string | null
  expected_result: string | null
  actual_result: string | null
  /** Non-null only when the row was classified not automatable, and skipped. */
  not_automatable_reason: string | null
}

export type MobileSuite = {
  id: number
  name: string
  source: 'CSV_IMPORT' | 'XLSX_BATCH' | 'NL_GENERATE' | 'MANUAL' | string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'INTERRUPTED'
  application_id: number | null
  application_name: string | null
  device_id: number | null
  test_count: number
  passed_count: number
  failed_count: number
  skipped_count: number
  combined_video_url: string | null
  created_at: string | null
  completed_at: string | null
  tests: MobileSuiteTestRow[]
}

export type MobileEvidenceItem = {
  id: number
  step_index: number | null
  artifact_type: 'SCREENSHOT' | 'VIDEO' | 'UI_HIERARCHY' | 'APPIUM_LOG' | string
  /** Root-relative (`/storage/mobile/...`); backend-node proxies that path. */
  url: string
  sha256: string | null
  mime_type: string | null
  size: number | null
  captured_at: string
}

export type MobileHealingRecord = {
  id: number
  execution_id: number
  step_index: number
  original_locator: MobileLocator | null
  candidate_locators: Array<{ locator: MobileLocator; score?: number }> | null
  replacement_locator: MobileLocator | null
  confidence: number | null
  risk_level: string | null
  status:
    | 'PENDING_VALIDATION' | 'APPLIED' | 'VALIDATED' | 'VALIDATION_FAILED'
    | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ROLLED_BACK' | 'REQUIRES_REVIEW'
  reason: string | null
}

export type MobileCapabilities = {
  platform: string
  automation: string[]
  features: {
    autoheal: boolean
    video: boolean
    live_view: boolean
    ai_gateway: boolean
    emulator_auto_start: boolean
    [key: string]: boolean
  }
  adapter_version: string
}

export type MobileGenerateResult = {
  steps: MobileTestStep[]
  warnings: string[]
  grounded: boolean
  screen_map_screens: number
  grounding_element_count: number
  automatable: boolean
  not_automatable_reason: string | null
  test_id: number | null
  suite_id: number | null
}

export type MobileImportResult = {
  created: Array<{ id: number; name: string; step_count: number; source_file: string }>
  errors: Array<{ file: string; error: string }>
  suite_id: number | null
}

/** Batch-generation job. Held in memory on the backend, so a restart loses it
 *  (IMPLEMENTATION.md §13) — the tests it already created still survive. */
export type MobileBatchJob = {
  id: string
  status: 'RUNNING' | 'COMPLETED'
  filename: string
  detected_columns: Record<string, string> | null
  total_rows: number
  skipped_rows: number
  processed: number
  has_grounding: boolean
  screen_map_screens: number
  not_automatable_rows: number
  suite_id: number | null
  created: Array<{ id: number; name: string }>
  failed: Array<{ row: number; error: string }>
  started_at: string | null
  completed_at: string | null
}
