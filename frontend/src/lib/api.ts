import { supabase } from './supabase'
import type {
  BrowserDistributionEntry,
  DashboardSummary,
  DiscoveredFlow,
  ExcelImportResult,
  ExecutionDetail,
  ExecutionListItem,
  ExecutionPlan,
  ExecutionTrace,
  ExecutionTrendPoint,
  HealingEvent,
  HealingEventStatus,
  JiraConfig,
  JiraHealth,
  MobileApplication,
  MobileBatchJob,
  MobileCapabilities,
  MobileCompatibilityRun,
  MobileDevice,
  MobileDeviceHealth,
  MobileEvidenceItem,
  MobileExecution,
  MobileGenerateResult,
  MobileHealingRecord,
  MobileImportResult,
  MobileLocator,
  MobileSuite,
  MobileTest,
  MobileUploadResult,
  Project,
  ProjectTraceability,
  QueuedRun,
  RecentExecutionItem,
  Release,
  ReleaseComparisonEntry,
  ReleaseReadiness,
  Sprint,
  SprintAssignment,
  SprintResults,
  SprintRunResult,
  TestCase,
  TestCaseRegression,
  TestCaseTraceability,
  TestSuite,
} from './types'

/** Base URL of backend-node. Also the Socket.IO origin for live runs. */
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8080'

const STORAGE_KEYS = {
  TOKEN: 'ai_qa_token',
  USER: 'ai_qa_user',
} as const

/** Where an expired session lands the user. */
const LOGIN_PATH = '/login'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>
}

function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.TOKEN)
  } catch {
    // Private-browsing modes can throw on storage access.
    return null
  }
}

export const api = {
  /* -- Session token --------------------------------------------------- */

  getToken: readToken,

  setToken(token: string | null) {
    try {
      if (token) localStorage.setItem(STORAGE_KEYS.TOKEN, token)
      else localStorage.removeItem(STORAGE_KEYS.TOKEN)
    } catch {
      /* storage unavailable - the in-memory Supabase session still works */
    }
  },

  clearSession() {
    try {
      localStorage.removeItem(STORAGE_KEYS.TOKEN)
      localStorage.removeItem(STORAGE_KEYS.USER)
    } catch {
      /* nothing to clear */
    }
  },

  isAuthenticated(): boolean {
    return !!readToken()
  },

  /* -- Core request wrapper -------------------------------------------- */

  /**
   * Every call goes through here so the bearer token, JSON handling and the
   * 401 path stay identical across the app.
   *
   * On 401 we clear our token AND sign out of Supabase before redirecting.
   * Clearing only local storage would leave the Supabase session alive, and
   * the auth guard would bounce the user straight back out of the login page.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...options.headers }

    const token = readToken()
    if (token) headers.Authorization = `Bearer ${token}`

    // Let the browser set the multipart boundary itself for uploads.
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${API_BASE}${path}`, { ...options, headers })

    if (!response.ok) {
      if (response.status === 401) {
        this.clearSession()
        await supabase.auth.signOut().catch(() => {})
        window.location.href = LOGIN_PATH
        throw new ApiError('Unauthorized', 401)
      }

      const errorText = await response.text()
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(errorText)
      } catch {
        /* backend returned plain text */
      }
      const message =
        (parsed?.error as string) ||
        (parsed?.detail as string) ||
        (parsed?.message as string) ||
        errorText ||
        'Request failed'
      throw new ApiError(message, response.status)
    }

    if (response.status === 204) return null as T
    return (await response.json()) as T
  },

  /** SWR fetcher. Bind at the call site: api.fetcher.bind(api) */
  fetcher<T>(path: string): Promise<T> {
    return this.request<T>(path)
  },

  /* -- Projects -------------------------------------------------------- */

  getProjects() {
    return this.request<Project[]>('/api/v1/projects')
  },

  createProject(name: string, description?: string) {
    return this.request<Project>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    })
  },

  updateProject(projectId: string, name: string, description?: string) {
    return this.request<Project>(`/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description }),
    })
  },

  deleteProject(projectId: string) {
    return this.request<null>(`/api/v1/projects/${projectId}`, { method: 'DELETE' })
  },

  /* -- Suites ---------------------------------------------------------- */

  getSuites(projectId: string) {
    return this.request<TestSuite[]>(`/api/v1/projects/${projectId}/suites`)
  },

  createSuite(projectId: string, name: string, description?: string, type: string = 'WEB') {
    return this.request<TestSuite>(`/api/v1/projects/${projectId}/suites`, {
      method: 'POST',
      body: JSON.stringify({ name, description, type }),
    })
  },

  deleteSuite(suiteId: string) {
    return this.request<{ message: string }>(`/api/v1/suites/${suiteId}`, { method: 'DELETE' })
  },

  /* -- Test cases ------------------------------------------------------ */

  getTestCases(suiteId: string) {
    return this.request<TestCase[]>(`/api/v1/suites/${suiteId}/cases`)
  },

  createTestCase(suiteId: string, name: string, steps: unknown, description?: string) {
    return this.request<TestCase>(`/api/v1/suites/${suiteId}/cases`, {
      method: 'POST',
      body: JSON.stringify({ name, steps, description }),
    })
  },

  updateTestCase(suiteId: string, caseId: string, name: string, steps: unknown, description?: string) {
    return this.request<TestCase>(`/api/v1/suites/${suiteId}/cases/${caseId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, steps, description }),
    })
  },

  deleteTestCase(suiteId: string, caseId: string) {
    return this.request<null>(`/api/v1/suites/${suiteId}/cases/${caseId}`, { method: 'DELETE' })
  },

  /* -- Dashboard ------------------------------------------------------- */

  getDashboardSummary(projectId?: string) {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<DashboardSummary>(`/api/v1/dashboard/summary${q}`)
  },

  getExecutionTrend(days: number = 7, projectId?: string) {
    const q = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<ExecutionTrendPoint[]>(`/api/v1/dashboard/execution-trend?days=${days}${q}`)
  },

  getBrowserDistribution(projectId?: string) {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<BrowserDistributionEntry[]>(`/api/v1/dashboard/browser-distribution${q}`)
  },

  getRecentExecutions(limit: number = 25, projectId?: string) {
    const q = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<RecentExecutionItem[]>(
      `/api/v1/dashboard/recent-executions?limit=${limit}${q}`,
    )
  },

  getReleaseReadiness(projectId?: string, windowSize: number = 20) {
    const q = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<ReleaseReadiness>(
      `/api/v1/dashboard/release-readiness?window=${windowSize}${q}`,
    )
  },

  /* -- Releases ---------------------------------------------------------- */

  listReleases(projectId?: string) {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<Release[]>(`/api/v1/releases${q}`)
  },

  createRelease(payload: { projectId: string; name: string; description?: string }) {
    return this.request<Release>('/api/v1/releases', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  deleteRelease(id: string) {
    return this.request<null>(`/api/v1/releases/${id}`, { method: 'DELETE' })
  },

  compareReleases(releaseIds: string[]) {
    const q = releaseIds.map(encodeURIComponent).join(',')
    return this.request<ReleaseComparisonEntry[]>(`/api/v1/releases/compare?releaseIds=${q}`)
  },

  /* -- Traceability: Releases → Sprints → Test Cases -------------------- */

  getRelease(id: string) {
    return this.request<Release>(`/api/v1/releases/${id}`)
  },

  updateRelease(
    id: string,
    patch: Partial<Pick<Release, 'name' | 'description' | 'status' | 'sequence' | 'startDate' | 'endDate'>>,
  ) {
    return this.request<Release>(`/api/v1/releases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },

  listReleaseSprints(releaseId: string) {
    return this.request<Sprint[]>(`/api/v1/releases/${releaseId}/sprints`)
  },

  createSprint(payload: {
    releaseId: string
    name: string
    sequence?: number
    status?: Sprint['status']
    startDate?: string | null
    endDate?: string | null
  }) {
    return this.request<Sprint>('/api/v1/sprints', { method: 'POST', body: JSON.stringify(payload) })
  },

  getSprint(id: string) {
    return this.request<Sprint>(`/api/v1/sprints/${id}`)
  },

  updateSprint(
    id: string,
    patch: Partial<Pick<Sprint, 'name' | 'sequence' | 'status' | 'startDate' | 'endDate'>>,
  ) {
    return this.request<Sprint>(`/api/v1/sprints/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },

  deleteSprint(id: string) {
    return this.request<null>(`/api/v1/sprints/${id}`, { method: 'DELETE' })
  },

  listSprintTestCases(sprintId: string) {
    return this.request<SprintAssignment[]>(`/api/v1/sprints/${sprintId}/test-cases`)
  },

  assignSprintTestCases(sprintId: string, testRunIds: string[]) {
    return this.request<{ assigned: number; skipped: number; assignments: SprintAssignment[] }>(
      `/api/v1/sprints/${sprintId}/test-cases`,
      { method: 'POST', body: JSON.stringify({ testRunIds }) },
    )
  },

  unassignSprintTestCase(sprintId: string, testRunId: string) {
    return this.request<null>(`/api/v1/sprints/${sprintId}/test-cases/${testRunId}`, { method: 'DELETE' })
  },

  carryForwardSprint(sprintId: string, fromSprintId: string) {
    return this.request<{ carried: number; skipped: number; assignments: SprintAssignment[] }>(
      `/api/v1/sprints/${sprintId}/carry-forward`,
      { method: 'POST', body: JSON.stringify({ fromSprintId }) },
    )
  },

  getSprintResults(sprintId: string) {
    return this.request<SprintResults>(`/api/v1/sprints/${sprintId}/results`)
  },

  runSprint(sprintId: string, opts?: { testRunIds?: string[]; browsers?: string[] }) {
    return this.request<SprintRunResult>(`/api/v1/sprints/${sprintId}/run`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    })
  },

  /** Run one test case directly — no sprint / release / assignment change.
   *  Returns 202 with the new executionId; poll it via getRunDetails. */
  runTestCase(testRunId: string, opts?: { browser?: string }) {
    return this.request<{
      message: string
      executionId: string
      executionIds: string[]
      testRunId: string
      testName: string
      browser: string
      status: string
    }>(`/api/v1/test-cases/${testRunId}/run`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    })
  },

  getTestCaseTraceability(testRunId: string) {
    return this.request<TestCaseTraceability>(`/api/v1/test-cases/${testRunId}/traceability`)
  },

  getTestCaseRegression(testRunId: string) {
    return this.request<TestCaseRegression>(`/api/v1/test-cases/${testRunId}/regression`)
  },

  getProjectTraceability(projectId: string) {
    return this.request<ProjectTraceability>(`/api/v1/projects/${projectId}/traceability`)
  },

  /* -- Executions ------------------------------------------------------ */

  getExecutions(projectId?: string) {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return this.request<ExecutionListItem[]>(`/api/v1/executions${q}`)
  },

  getRunDetails(runId: string) {
    return this.request<ExecutionDetail>(`/api/v1/executions/${runId}`)
  },

  getExecutionTrace(runId: string) {
    return this.request<ExecutionTrace>(`/api/v1/executions/${runId}/trace`)
  },

  getExecutionPlan(runId: string) {
    return this.request<ExecutionPlan>(`/api/v1/executions/${runId}/plan`)
  },

  cancelExecution(runId: string) {
    return this.request<{ message: string }>(`/api/v1/executions/${runId}/cancel`, {
      method: 'POST',
    })
  },

  runMultiTest(payload: {
    test_name: string
    base_url?: string | null
    steps?: unknown
    browsers: string[]
    devices?: string[]
    environment?: string
    project_id: string
    suite_id?: string | null
    excel_testcase_ids?: string[] | null
    antiBot?: unknown
    release_id?: string | null
    /** Optional sprint context. When set, the backend derives release_id from
     *  the sprint and rejects a conflicting one. Omit for today's behaviour. */
    sprint_id?: string | null
    test_run_id?: string | null
  }) {
    return this.request<QueuedRun>('/api/v1/executions/run-multi-test', {
      method: 'POST',
      body: JSON.stringify({ environment: 'Production', devices: ['Desktop'], ...payload }),
    })
  },

  runApiTest(payload: {
    test_name: string
    project_id?: string
    suite_id?: string | null
    steps: unknown
    environment?: string
    variables?: Record<string, unknown>
  }) {
    return this.request<QueuedRun>('/api/v1/executions/run-api-test', {
      method: 'POST',
      body: JSON.stringify({ environment: 'Production', ...payload }),
    })
  },

  /** Parses an .xlsx into test cases and caches them server-side for 1 hour. */
  importExcel(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    return this.request<ExcelImportResult>('/api/v1/executions/run-excel', {
      method: 'POST',
      body: formData,
    })
  },

  /* -- Autonomous QA --------------------------------------------------- */

  triggerAutonomousQA(payload: {
    targetUrl: string
    credentials?: { username?: string; password?: string; token?: string }
    depth?: string
    features?: Record<string, boolean>
    browsers?: string[]
    projectId?: string | null
    customScenario?: unknown[] | null
    rawScenario?: string | null
    enableAiEyes?: boolean
    antiBot?: unknown
    releaseId?: string | null
    /** Optional sprint context (see runMultiTest). */
    sprintId?: string | null
    testRunId?: string | null
  }) {
    return this.request<QueuedRun>('/api/v1/autonomous/run', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  /* -- API testing ----------------------------------------------------- */

  generateApiSuite(prompt: string, testName?: string) {
    return this.request<{ steps: unknown[] }>('/api/v1/ai/generate-api-suite', {
      method: 'POST',
      body: JSON.stringify({ prompt, test_name: testName }),
    })
  },

  importApiSpec(specType: 'openapi' | 'postman' | 'curl', content: string) {
    return this.request<{ steps: unknown[] }>('/api/v1/ai/import-api-spec', {
      method: 'POST',
      body: JSON.stringify({ spec_type: specType, content }),
    })
  },

  generateApiSuiteFromSpec(content: string) {
    return this.request<{ steps: unknown[] }>('/api/v1/ai/generate-api-suite-from-spec', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  },

  getSchemaBaselines(suiteId: string) {
    return this.request<Array<Record<string, unknown>>>(
      `/api/v1/executions/schema-baselines?suiteId=${encodeURIComponent(suiteId)}`,
    )
  },

  resetSchemaBaseline(baselineId: string) {
    return this.request<null>(`/api/v1/executions/schema-baselines/${baselineId}`, {
      method: 'DELETE',
    })
  },

  /* -- Code generation sandbox ----------------------------------------- */

  generateRawCode(url: string, instructions: string, framework: string) {
    return this.request<{ code: string }>('/api/v1/ai/generate-raw-code', {
      method: 'POST',
      body: JSON.stringify({ url, instructions, framework }),
    })
  },

  executeRawCode(code: string, framework: string) {
    return this.request<{ output: string; success: boolean }>('/api/v1/ai/execute-raw-code', {
      method: 'POST',
      body: JSON.stringify({ code, framework }),
    })
  },

  /* -- AutoHeal -------------------------------------------------------- */

  getHealingEvents(status?: HealingEventStatus) {
    const q = status ? `?status=${status}` : ''
    return this.request<HealingEvent[]>(`/api/v1/healing${q}`)
  },

  /* -- Discovery (AppGraph) -------------------------------------------- */

  getDiscoveredFlows(projectId: string) {
    return this.request<DiscoveredFlow[]>(`/api/v1/discovery/flows/${projectId}`)
  },

  /** Crawls the target and persists the flows it finds. Slow - it drives a real browser. */
  generateDiscoveredFlows(projectId: string, baseUrl: string) {
    return this.request<DiscoveredFlow[]>(
      `/api/v1/discovery/generate-flows/${projectId}?base_url=${encodeURIComponent(baseUrl)}`,
      { method: 'POST' },
    )
  },

  /* -- Jira ------------------------------------------------------------ */

  /** Resolves to null when the project has no integration configured yet. */
  getJiraConfig(projectId: string) {
    return this.request<JiraConfig | null>(
      `/api/v1/jira/config?projectId=${encodeURIComponent(projectId)}`,
    )
  },

  getJiraHealth(projectId: string) {
    return this.request<JiraHealth>(`/api/v1/jira/health?projectId=${encodeURIComponent(projectId)}`)
  },

  saveJiraConfig(payload: {
    projectId: string
    baseUrl: string
    email: string
    apiToken: string
    projectKey: string
    issueType?: string
    isActive?: boolean
  }) {
    return this.request<{ message: string }>('/api/v1/jira/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  testJiraConnection(payload: Record<string, unknown>) {
    return this.request<{ success: boolean }>('/api/v1/jira/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  createJiraBug(executionId: string) {
    return this.request<{ key?: string; url?: string }>(
      `/api/v1/jira/create-from-execution/${executionId}`,
      { method: 'POST' },
    )
  },

  /* -- Mobile testing (Android) ---------------------------------------- */

  /**
   * The Python mobile engine, reached through backend-node's reverse proxy at
   * the same API_BASE as everything else — so the bearer token, the 401
   * redirect and error parsing are identical to every other call here.
   *
   * These reference `api.request` rather than `this.request` on purpose: as
   * methods of a nested object, `this` would bind to `api.mobile`, which has
   * no request().
   */
  mobile: {
    getCapabilities() {
      return api.request<MobileCapabilities>('/api/v1/mobile/capabilities')
    },

    /* Applications
     *
     * projectUuid scopes mobile data to the selected project. It is the only
     * scoping anchor in that schema — suites, tests and executions have no
     * project column and are filtered through their application. Omitting it
     * returns everything, which is what direct API/CI callers rely on, so the
     * UI must always pass it. */
    listApplications(projectUuid?: string) {
      const q = projectUuid ? `?project_uuid=${encodeURIComponent(projectUuid)}` : ''
      return api.request<MobileApplication[]>(`/api/v1/mobile/applications${q}`)
    },
    getApplication(id: number) {
      return api.request<MobileApplication>(`/api/v1/mobile/applications/${id}`)
    },
    uploadApplication(file: File, projectUuid?: string) {
      const form = new FormData()
      form.append('file', file)
      // Sent as a query param, matching how mobile/api.py's scope_project()
      // dependency and backend-node's enforceProjectScope actually read it
      // (both look at the query string, never at multipart form fields).
      // A previous version of this sent project_uuid as a form field, which
      // both of those silently ignored — the upload always "succeeded" but
      // landed unscoped, so the app could never appear in any project's list.
      const q = projectUuid ? `?project_uuid=${encodeURIComponent(projectUuid)}` : ''
      return api.request<MobileUploadResult>(`/api/v1/mobile/applications${q}`, {
        method: 'POST',
        body: form,
      })
    },
    getScreenMap(applicationId: number) {
      return api.request<{
        application_version_id: number
        captured_at: string | null
        screen_map: Record<string, unknown> | null
      }>(`/api/v1/mobile/applications/${applicationId}/screen-map`)
    },
    /** Background crawl (~1-3 min) that grounds AI generation in real screens. */
    exploreApplication(applicationId: number, deviceId: number) {
      return api.request<{ status: string; application_version_id: number; device_id: number }>(
        `/api/v1/mobile/applications/${applicationId}/explore?device_id=${deviceId}`,
        { method: 'POST' },
      )
    },

    /* Devices — the list route re-syncs adb on every call, so it is slow-ish. */
    listDevices() {
      return api.request<MobileDevice[]>('/api/v1/mobile/devices')
    },
    checkDeviceHealth(deviceId: number) {
      return api.request<MobileDeviceHealth>(`/api/v1/mobile/devices/${deviceId}/health`, {
        method: 'POST',
      })
    },
    provisionDevice() {
      return api.request<{ status: string; serials?: string[]; avds?: string[] }>(
        '/api/v1/mobile/devices/provision',
        { method: 'POST' },
      )
    },

    /* Tests */
    listTests(projectUuid?: string) {
      const q = projectUuid ? `?project_uuid=${encodeURIComponent(projectUuid)}` : ''
      return api.request<MobileTest[]>(`/api/v1/mobile/tests${q}`)
    },
    getTest(id: number) {
      return api.request<MobileTest>(`/api/v1/mobile/tests/${id}`)
    },
    createTest(payload: {
      name: string
      description?: string
      application_id?: number
      steps: unknown[]
      risk_level?: string
      device_id?: number
    }) {
      return api.request<{ id: number; name: string; suite_id: number | null }>(
        '/api/v1/mobile/tests',
        { method: 'POST', body: JSON.stringify(payload) },
      )
    },
    /** Needs OPENAI_API_KEY on the backend, else 503. Auto-runs when given a device. */
    generateTest(input: {
      text?: string
      file?: File
      applicationId?: number
      deviceId?: number
      releaseId?: string
    }) {
      const form = new FormData()
      if (input.text) form.append('text', input.text)
      if (input.file) form.append('file', input.file)
      if (input.applicationId != null) form.append('application_id', String(input.applicationId))
      if (input.deviceId != null) form.append('device_id', String(input.deviceId))
      if (input.releaseId) form.append('release_id', input.releaseId)
      return api.request<MobileGenerateResult>('/api/v1/mobile/tests/generate', {
        method: 'POST',
        body: form,
      })
    },
    /** Deterministic CSV/JSON import — no AI involved. */
    importTests(files: File[], deviceId?: number, applicationId?: number) {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      if (deviceId != null) form.append('device_id', String(deviceId))
      if (applicationId != null) form.append('application_id', String(applicationId))
      return api.request<MobileImportResult>('/api/v1/mobile/tests/import', {
        method: 'POST',
        body: form,
      })
    },
    /** Flexible QA-tracker import. Returns a job to poll — it is not synchronous. */
    generateTestsBatch(file: File, applicationId?: number, deviceId?: number) {
      const form = new FormData()
      form.append('file', file)
      if (applicationId != null) form.append('application_id', String(applicationId))
      if (deviceId != null) form.append('device_id', String(deviceId))
      return api.request<MobileBatchJob>('/api/v1/mobile/tests/generate-batch', {
        method: 'POST',
        body: form,
      })
    },
    getBatchJob(jobId: string) {
      return api.request<MobileBatchJob>(`/api/v1/mobile/tests/generate-batch/${jobId}`)
    },

    /* Suites */
    listSuites(limit = 20, projectUuid?: string) {
      const q = projectUuid ? `&project_uuid=${encodeURIComponent(projectUuid)}` : ''
      return api.request<MobileSuite[]>(`/api/v1/mobile/suites?limit=${limit}${q}`)
    },
    getSuite(id: number) {
      return api.request<MobileSuite>(`/api/v1/mobile/suites/${id}`)
    },
    runSuite(id: number) {
      return api.request<MobileSuite>(`/api/v1/mobile/suites/${id}/run`, { method: 'POST' })
    },

    /* Executions */
    listExecutions(limit = 50, projectUuid?: string) {
      const q = projectUuid ? `&project_uuid=${encodeURIComponent(projectUuid)}` : ''
      return api.request<MobileExecution[]>(`/api/v1/mobile/executions?limit=${limit}${q}`)
    },
    getExecution(id: number) {
      return api.request<MobileExecution>(`/api/v1/mobile/executions/${id}`)
    },
    createExecution(payload: {
      test_id: number
      device_id?: number
      device_serial?: string
      application_version_id?: number
      environment?: string
      idempotency_key?: string
    }) {
      return api.request<MobileExecution>('/api/v1/mobile/executions', {
        method: 'POST',
        body: JSON.stringify({ environment: 'DEV', ...payload }),
      })
    },
    cancelExecution(id: number) {
      return api.request<{ status: string }>(`/api/v1/mobile/executions/${id}/cancel`, {
        method: 'POST',
      })
    },
    getExecutionEvidence(id: number) {
      return api.request<MobileEvidenceItem[]>(`/api/v1/mobile/executions/${id}/evidence`)
    },

    /* Compatibility runs — one test across several devices at once. */
    listCompatibilityRuns(limit = 20) {
      return api.request<MobileCompatibilityRun[]>(
        `/api/v1/mobile/compatibility-runs?limit=${limit}`,
      )
    },
    getCompatibilityRun(id: number) {
      return api.request<MobileCompatibilityRun>(`/api/v1/mobile/compatibility-runs/${id}`)
    },
    createCompatibilityRun(payload: { test_id: number; device_ids: number[]; environment?: string }) {
      return api.request<MobileCompatibilityRun>('/api/v1/mobile/compatibility-runs', {
        method: 'POST',
        body: JSON.stringify({ environment: 'DEV', ...payload }),
      })
    },

    /* AutoHeal */
    getHealingHistory(params: { test_id?: number; execution_id?: number; project_uuid?: string } = {}) {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
      return api.request<MobileHealingRecord[]>(`/api/v1/mobile/healing/history${qs ? `?${qs}` : ''}`)
    },
    /** Not an AutoHeal approval — AutoHeal already applies any fix it finds
     *  on its own. This only does anything for a REQUIRES_REVIEW record (no
     *  candidate locator found at all): supply `locator` to retry the step
     *  with it. Omitting `locator` only works if the record somehow already
     *  has a candidate of its own. */
    approveHealing(id: number, locator?: MobileLocator) {
      return api.request<{ status: string; rerun_execution_id?: number }>(
        `/api/v1/mobile/healing/${id}/approve`,
        { method: 'POST', body: JSON.stringify(locator ? { locator } : {}) },
      )
    },
    /** Dismiss a REQUIRES_REVIEW record without retrying — no locator was
     *  supplied and the failure is left as-is. */
    rejectHealing(id: number) {
      return api.request<{ status: string }>(`/api/v1/mobile/healing/${id}/reject`, {
        method: 'POST',
      })
    },
    rollbackHealing(id: number) {
      return api.request<{ status: string }>(`/api/v1/mobile/healing/${id}/rollback`, {
        method: 'POST',
      })
    },

    /** Not under /api/v1/mobile — this is a native backend-node route (see
     *  routes/jira.ts) that reads the mobile engine's tables directly via the
     *  shared Supabase database, the same way dashboard.ts does. */
    createJiraBug(executionId: number) {
      return api.request<{ success: boolean; ticketId: string; ticketUrl: string }>(
        `/api/v1/jira/create-from-mobile-execution/${executionId}`,
        { method: 'POST' },
      )
    },

    /**
     * Absolute URL for an artifact the engine returned as a root-relative path
     * (`/storage/mobile/...`). Those resolve against the frontend origin
     * otherwise, which 404s — backend-node proxies that prefix.
     */
    artifactUrl(path: string | null | undefined): string | null {
      if (!path) return null
      if (/^https?:\/\//i.test(path)) return path
      return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
    },
  },
}
