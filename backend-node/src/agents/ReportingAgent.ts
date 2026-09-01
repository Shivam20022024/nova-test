import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { supabase } from '../utils/storage';
const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  temperature: 0.2,
  modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
});

const reportSchema = {
  type: "object",
  properties: {
    status: { type: "string", description: "The final execution status: PASSED, FAILED, or BLOCKED" },
    ai_summary: { type: "string", description: "Human-readable AI summary of the run and its key outcomes" },
    reason: { type: "string", description: "AI diagnosis of the execution result or failure reason (leave empty string if none)" },
    health_score: { type: ["number", "null"], description: "Execution health score out of 100 based on completion and stability. MUST be null when Playwright never executed (script generation failed/partial) — the application was not measured." },
    ai_confidence_score: { type: "number", description: "AI confidence score (0-100) in its interaction accuracy and analysis" },
    interaction_success_rate: { type: ["number", "null"], description: "Percentage (0-100) of successful UI interactions without retries/failures. MUST be null when Playwright never executed — no interactions were measured." },
    dom_stability: { type: "string", description: "Assessment of page DOM stability ('High', 'Medium', 'Low'). Use 'NOT EVALUATED' when Playwright never executed." },
    endpoint_coverage: { type: "array", items: { type: "string" }, description: "List of API endpoints exercised during this run (API tests only)" },
    avg_latency_ms: { type: "number", description: "Average response latency in milliseconds across all requests (API tests only)" },
    status_code_summary: { type: "string", description: "Summary of HTTP status codes returned (API tests only)" },
    failed_assertions_summary: { type: "array", items: { type: "string" }, description: "Summary of failed assertions (API tests only)" },
    contract_drift_summary: { type: "array", items: { type: "string" }, description: "Summary of API/DB schema or contract drift detected" },
    query_coverage: { type: "array", items: { type: "string" }, description: "List of tables/collections queried during this run (DB tests only)" },
    rows_scanned_summary: { type: "string", description: "Summary of row/document counts returned across queries (DB tests only)" },
    validation_results: { type: "array", items: { type: "string" }, description: "Checklist of validation outcomes, e.g., 'Login page accessible', 'Password field detected'" },
    url: { type: "string", description: "Target URL tested, if available" },
    duration: { type: "number", description: "Execution duration in seconds" },
    browser: { type: "string", description: "Browser used for execution" },
    environment: { type: "string", description: "Execution environment (e.g., Local, CI/CD, Remote)" },
    workflow: { type: "string", description: "Name of the executed test suite or workflow" },
    release_risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"], description: "Overall release risk evaluation based on findings" },
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["SUCCESS", "WARNING", "RISK", "INFO"] },
          title: { type: "string" },
          description: { type: "string" },
          evidence: { type: "string", description: "Evidence string (leave empty string if none)" }
        },
        required: ["type", "title", "description", "evidence"],
        additionalProperties: false
      },
      description: "Structured key observations derived strictly from telemetry and execution results"
    },
    recommendations: { type: "array", items: { type: "string" }, description: "Actionable recovery suggestions or optimization insights" },
    timeline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time: { type: "string" },
          event: { type: "string" },
          status: { type: "string", description: "SUCCESS, FAILED, WAITING, etc." }
        },
        required: ["time", "event", "status"],
        additionalProperties: false
      },
      description: "Sequential timeline of key execution events for visual presentation"
    },
    detected_issues: { type: "array", items: { type: "string" }, description: "List of detected network errors, warnings, or page issues" },
    screenshot_analysis: { type: "string", description: "Summary of the visible UI state if applicable (leave empty string if none)" },
    markdown_report: { type: "string", description: "A clean markdown formatted report summarizing the execution (leave empty string if none)" }
  },
  required: [
    "status", "ai_summary", "reason", "health_score", "ai_confidence_score", "interaction_success_rate", "dom_stability",
    "endpoint_coverage", "avg_latency_ms", "status_code_summary", "failed_assertions_summary", "contract_drift_summary",
    "query_coverage", "rows_scanned_summary",
    "validation_results", "url", "duration", "browser", "environment", "workflow", "release_risk", "observations",
    "recommendations", "timeline", "detected_issues", "screenshot_analysis", "markdown_report"
  ],
  additionalProperties: false
};

const prompt = PromptTemplate.fromTemplate(`
You are an expert QA Reporting Agent. 
Generate a comprehensive structured JSON execution report based STRICTLY on actual executed actions and telemetry.
Ensure to provide rich enterprise-grade insights (summaries, checklists, confidence scores, structured observations) for BOTH successful and failed runs.

Test Name: {testName}
Status: {status}
Script Generation Status: {scriptGenerationStatus}
Playwright Execution Status: {playwrightExecutionStatus}
Browser: {browser}
Environment: {environment}
Error (if any): {error}
Execution Time: {duration}s
Target URL: {url}

Test Metadata:
{testMetadata}

Artifacts:
Screenshot URL: {screenshotUrl}
Video URL: {videoUrl}

Executed Step Logs (Actual Telemetry):
{executedSteps}

General Logs / Errors:
{logs}

AUTHORITATIVE EXECUTION STATE — these fields are computed from the real execution state and OVERRIDE any conflicting text in the raw logs:
- "Status", "Script Generation Status" and "Playwright Execution Status" above are authoritative. NEVER set the report "status" or "reason" from a line in the raw logs.
- The raw logs may contain transient warnings from steps that were retried and then SUCCEEDED (for example an early "PARTIAL_SCRIPT_GENERATION_RESPONSE" or "attempt 1 failed" line that a later successful retry superseded). Ignore such superseded lines entirely.
- If Script Generation Status is SUCCESS, you MUST NOT claim script generation failed, was partial, or that "no test cases were generated". Report "reason" as an empty string for a successful/passed run.
- If Playwright Execution Status is NOT_STARTED: the application was never exercised. Set health_score = null, interaction_success_rate = null, dom_stability = "NOT EVALUATED". Do NOT fabricate performance, accessibility, security, DOM-stability, endpoint-coverage, latency or application-defect findings. State plainly "APPLICATION QUALITY: NOT EVALUATED".
- If Playwright Execution Status is STARTED or COMPLETED: derive all metrics ONLY from the actual executed step telemetry above.
- The "workflow" field MUST be the Test Name given above, verbatim. Never replace it with a generic placeholder like "Unknown Workflow" when a Test Name is provided.
- TIMELINE / TIMESTAMPS: every timeline entry's "time" MUST be an actual timestamp copied from the step telemetry or logs above. If a given event has no recorded timestamp, use an empty string "" — NEVER invent a date/time (e.g. never output "2023-10-01T12:00:00Z" or any placeholder date).

TELEMETRY CONSISTENCY RULES — the ai_summary, observations, reason, validation_results and every metric MUST agree with the telemetry above and must NEVER contradict it. Where a signal is absent, write "NOT EVALUATED" — do not guess:
- ACCESSIBILITY: use the "ACCESSIBILITY" step line. If it is FAILED / "Violations found: N" with N>0, the summary MUST state that N WCAG accessibility violation(s) were detected and should be reviewed before release — NEVER say "No WCAG violations were found". Only say "No WCAG violations were detected" when that step is PASSED. If there is no ACCESSIBILITY step, accessibility was NOT EVALUATED.
- SECURITY: only Mixed-Content and Insecure-Form DOM checks run. Call it "Security Sanity Checks" / "Basic transport/form security sanity checks only" with status PASS / WARN / FAIL / NOT EVALUATED taken from the "SECURITY" step line. NEVER claim "the application is secure" or "Security = 100%" or imply a comprehensive security assessment. If there is no SECURITY step, say NOT EVALUATED.
- PERFORMANCE: there is NO Core Web Vitals / LCP / TBT / CLS telemetry — NEVER invent these values or labels. If step durations exist, report only Execution Duration and Average / Fastest / Slowest step duration. If no timing telemetry exists, Performance = NOT EVALUATED.
- SELF-HEALING: derive strictly from HEAL step lines. Recovery Rate = (count of HEAL PASSED) / (count of HEAL TRIGGERED) * 100. A "HEALING_FAILED" or a HEAL that never reached PASSED is NOT a recovery and must not be counted as one. Treat a missing/null selector as "unknown", never crash the narrative.
- FAILURE CLASSIFICATION: classify each failed step from its own evidence (SELECTOR_ERROR, PAGE_STATE_ERROR, TIMING_ERROR, NAVIGATION_ERROR, APPLICATION_ERROR, TEST_SCRIPT_ERROR, INFRASTRUCTURE_ERROR, ANTI_BOT_BLOCK, UNKNOWN). Do not reuse one generic root cause for every failure. Use APPLICATION_ERROR ONLY when telemetry shows the application itself is defective (real app/JS error, 5xx, broken flow) — not for a stale selector or a wait timeout.
- DOM STABILITY: rate High / Medium / Low only from real retry/healing/instability evidence in the telemetry; if Playwright did not run, "NOT EVALUATED".
- RELEASE DECISION: distinguish APPLICATION FAILURE vs TEST EXECUTION FAILURE vs INFRASTRUCTURE FAILURE vs ANTI-BOT BLOCK. If Playwright never started, Application Quality = NOT EVALUATED — never say "the website failed".
- The ai_summary must never contradict scenario status, step status, script generation status, Playwright execution status, accessibility, security sanity, self-healing, infrastructure or anti-bot telemetry.

Analyze the logs carefully to:
1. Generate a human-readable AI summary consistent with ALL telemetry above (see TELEMETRY CONSISTENCY RULES).
2. Produce a checklist of validation results.
3. Calculate confidence; derive interaction_success_rate and dom_stability ONLY from actual telemetry (null / "NOT EVALUATED" when Playwright did not run).
4. Construct a clear timeline of events from the logs using only real timestamps.
5. Provide structured observations (type: SUCCESS | WARNING | RISK | INFO) and release risk evaluation.
6. Provide actionable optimization recommendations that reference the actual failing scenario / page / element / selector — never generic text like "investigate the issue".
`);

const apiPrompt = PromptTemplate.fromTemplate(`
You are an expert QA Reporting Agent specializing in API/HTTP testing.
Generate a comprehensive structured JSON execution report based STRICTLY on actual executed HTTP requests and telemetry.
Ensure to provide rich enterprise-grade insights (summaries, checklists, confidence scores, structured observations) for BOTH successful and failed runs.
Do NOT reference browser DOM, UI interactions, or screenshots — this is a pure API test run.

Test Name: {testName}
Status: {status}
Environment: {environment}
Error (if any): {error}
Execution Time: {duration}s
Base/Target URL: {url}

Test Metadata:
{testMetadata}

Executed Request/Response Logs (Actual Telemetry — includes method, url, status, latency, assertions per step):
{executedSteps}

General Logs / Errors:
{logs}

Analyze the logs carefully to:
1. Generate a human-readable AI summary of API test coverage and outcomes.
2. Produce a checklist of validation results (assertions passed/failed).
3. Calculate confidence and overall health score based on assertion pass rate and response correctness.
4. Construct a clear timeline of requests/responses.
5. Provide structured observations (type: SUCCESS | WARNING | RISK | INFO) and release risk evaluation.
6. Summarize endpoint_coverage (list of endpoints hit), avg_latency_ms, status_code_summary, and failed_assertions_summary.
7. Look for "SCHEMA_DRIFT:" lines inside the step logs — these mean a response's structure (fields added/removed/type-changed) no longer matches the previously recorded baseline for that endpoint, even if the HTTP status/assertions still passed. Summarize any found into contract_drift_summary, and if present, call it out as a RISK observation and factor it into release_risk (schema drift on a passing test should push risk toward MEDIUM or higher, since it's a silent breaking-change signal).
8. Provide actionable optimization recommendations (even if successful).
`);

const dbPrompt = PromptTemplate.fromTemplate(`
You are an expert QA Reporting Agent specializing in database testing.
Generate a comprehensive structured JSON execution report based STRICTLY on actual executed queries and telemetry.
Ensure to provide rich enterprise-grade insights (summaries, checklists, confidence scores, structured observations) for BOTH successful and failed runs.
Do NOT reference browser DOM, UI interactions, screenshots, or HTTP status codes — this is a pure database test run against SQL/NoSQL data stores.

Test Name: {testName}
Status: {status}
Environment: {environment}
Error (if any): {error}
Execution Time: {duration}s

Test Metadata:
{testMetadata}

Executed Query Logs (Actual Telemetry — includes engine, table/collection, row counts, latency, assertions per step):
{executedSteps}

General Logs / Errors:
{logs}

Analyze the logs carefully to:
1. Generate a human-readable AI summary of database test coverage and outcomes.
2. Produce a checklist of validation results (assertions passed/failed — row counts, cell values, schema columns).
3. Calculate confidence and overall health score based on assertion pass rate and query correctness.
4. Construct a clear timeline of queries executed.
5. Provide structured observations (type: SUCCESS | WARNING | RISK | INFO) and release risk evaluation.
6. Summarize query_coverage (list of tables/collections touched) and rows_scanned_summary.
7. Look for "SCHEMA_DRIFT:" lines inside the step logs — these mean a query result's structure (columns/fields added/removed/type-changed) no longer matches the previously recorded baseline for that query, even if the assertions still passed. Summarize any found into contract_drift_summary, and if present, call it out as a RISK observation and factor it into release_risk (schema drift on a passing test should push risk toward MEDIUM or higher, since it's a silent breaking-change signal — e.g. an undocumented column rename or type change).
8. Look for "WRITE_STATUS:" lines inside the step logs — these indicate a write (INSERT/UPDATE/DELETE or Mongo insert/update/delete) was executed. "ROLLED BACK" means the change was test-only and never persisted (the normal, safe case). "COMMITTED" means the change was intentionally kept permanently — call this out explicitly as an INFO observation so it's never a silent surprise, even when the test otherwise passed.
9. Provide actionable optimization recommendations (even if successful).
`);

export class ReportingAgent {
  async generateReport(executionId: string, data: any) {
    const errorMsg = (data.error || '').toUpperCase();
    const isInfraFailure = errorMsg.includes('ETIMEDOUT') ||
                           errorMsg.includes('ENOTFOUND') ||
                           errorMsg.includes('ECONNREFUSED') ||
                           errorMsg.includes('CONNECTION CLOSED') ||
                           errorMsg.includes('REDIS CONNECTION FAILED') ||
                           errorMsg.includes('BULLMQ WORKER CONNECTION FAILED') ||
                           errorMsg.includes('UPSTASH CONNECTION FAILED');

    if (isInfraFailure) {
      const infraReport = {
        status: "FAILED",
        ai_summary: "Infrastructure failure: BullMQ worker could not connect to Redis.",
        reason: `Root Cause:\nBullMQ worker could not connect to Redis.\n\nError: ${data.error}\n\nReason:\nRedis host unavailable, DNS resolution failed, or network timeout occurred.`,
        health_score: 0,
        ai_confidence_score: 100,
        interaction_success_rate: 0,
        dom_stability: "N/A",
        release_risk: "CRITICAL" as const,
        observations: [
          {
            type: "RISK" as const,
            title: "Infrastructure Connectivity Blocker",
            description: "BullMQ worker could not establish connection to Redis database.",
            evidence: data.error || "Redis connection failed"
          },
          {
            type: "WARNING" as const,
            title: "Zero Test Execution",
            description: "Execution stopped prior to browser launch. No scenarios were evaluated.",
            evidence: ""
          }
        ],
        validation_results: [
            "Infrastructure Failure",
            "Issue Type: Queue / Redis Connectivity",
            "Owner: Platform Team",
            "Priority: Critical",
            "Impact: Test execution never started. No Playwright scripts executed. No website validation performed. No accessibility scan performed. No security scan performed. No reliable application quality assessment available.",
            "FINAL RELEASE DECISION: Status: EXECUTION BLOCKED, Environment: Unknown, Production: NOT EVALUATED, Reason: Infrastructure failure prevented execution., Website Tested: NO, Execution Started: NO, Release Recommendation: Cannot determine application quality until Redis connectivity is restored."
        ],
        url: data.url || 'Unknown URL',
        duration: data.duration || 0,
        browser: data.browser || 'Chromium',
        environment: data.environment || 'Local',
        workflow: data.testName || 'Unknown Workflow',
        recommendations: [
            "Recommended Fix:",
            "1. Verify Redis host URL.",
            "2. Verify Upstash Redis database exists.",
            "3. Verify Redis credentials.",
            "4. Verify .env configuration.",
            "5. Verify internet connectivity.",
            "6. Test Redis connection using PING.",
            "7. Restart BullMQ workers."
        ],
        timeline: [
            { time: new Date().toISOString(), event: "Infrastructure Failure Detected", status: "FAILED" }
        ],
        detected_issues: ["Queue / Redis Connectivity Error"],
        screenshot_analysis: "",
        markdown_report: `
## ROOT CAUSE ANALYSIS

**Root Cause:**
BullMQ worker could not connect to Redis.

**Error:**
${data.error}

**Reason:**
Redis host unavailable, DNS resolution failed, or network timeout occurred.

---

## BUSINESS IMPACT

**Impact:**
* Test execution never started.
* No Playwright scripts executed.
* No website validation performed.
* No accessibility scan performed.
* No security scan performed.
* No reliable application quality assessment available.

---

## DEVELOPER ACTIONS

**Recommended Fix:**
1. Verify Redis host URL.
2. Verify Upstash Redis database exists.
3. Verify Redis credentials.
4. Verify .env configuration.
5. Verify internet connectivity.
6. Test Redis connection using PING.
7. Restart BullMQ workers.

---

## FINAL RELEASE DECISION

**Status:** EXECUTION BLOCKED
**Environment:** Unknown
**Production:** NOT EVALUATED
**Reason:** Infrastructure failure prevented execution.
**Website Tested:** NO
**Execution Started:** NO
**Release Recommendation:** Cannot determine application quality until Redis connectivity is restored.
`
      };

      try {
        const jsonContent = JSON.stringify(infraReport, null, 2);
        const { data: uploadData, error } = await supabase.storage
          .from('reports')
          .upload(`${executionId}.json`, Buffer.from(jsonContent, 'utf-8'), { contentType: 'application/json', upsert: true });
          
        if (!error && uploadData) {
          const { data: publicData } = supabase.storage.from('reports').getPublicUrl(uploadData.path);
          return { content: infraReport, url: publicData.publicUrl, isJson: true };
        }
        return { content: infraReport, url: null, isJson: true };
      } catch (e) {
        console.error('Failed to generate or upload infra failure report', e);
        return { content: infraReport, url: null, isJson: true };
      }
    }

    const isSupabaseInfraFailure = errorMsg.includes('UND_ERR_CONNECT_TIMEOUT') ||
                                   errorMsg.includes('CONNECTTIMEOUTERROR') ||
                                   errorMsg.includes('SUPABASE AUTH ERROR') ||
                                   errorMsg.includes('FETCH FAILED') ||
                                   errorMsg.includes('COULD NOT RENEW LOCK') ||
                                   errorMsg.includes('LOCK RENEWAL FAILURE');

    if (isSupabaseInfraFailure) {
      const supabaseInfraReport = {
        status: "FAILED",
        ai_summary: "Infrastructure failure: Supabase authentication service could not be reached within configured timeout limits.",
        reason: `Root Cause:\nSupabase authentication service could not be reached within configured timeout limits.\n\nError: ${data.error}`,
        health_score: 0,
        ai_confidence_score: 100,
        interaction_success_rate: 0,
        dom_stability: "N/A",
        release_risk: "CRITICAL" as const,
        observations: [
          {
            type: "RISK" as const,
            title: "Supabase Service Unreachable",
            description: "Authentication or storage service request timed out during worker execution.",
            evidence: data.error || "Supabase timeout error"
          }
        ],
        validation_results: [
            "Infrastructure Failure",
            "Issue Type: Supabase Connectivity",
            "Owner: Platform Team",
            "Priority: Critical",
            "Impact: User authentication unavailable. Test execution interrupted. BullMQ worker lock expired. Results cannot be trusted.",
            "FINAL RELEASE DECISION: Status: EXECUTION BLOCKED, Website Tested: NO, Authentication Available: NO, Execution Valid: NO, Recommendation: Resolve Supabase connectivity before executing tests again."
        ],
        url: data.url || 'Unknown URL',
        duration: data.duration || 0,
        browser: data.browser || 'Chromium',
        environment: data.environment || 'Local',
        workflow: data.testName || 'Unknown Workflow',
        recommendations: [
            "Recommendation: Resolve Supabase connectivity before executing tests again."
        ],
        timeline: [
            { time: new Date().toISOString(), event: "Infrastructure Failure Detected", status: "FAILED" }
        ],
        detected_issues: ["Supabase Connectivity Error"],
        screenshot_analysis: "",
        markdown_report: `
## ROOT CAUSE ANALYSIS

**Root Cause:**
Supabase authentication service could not be reached within configured timeout limits.

**Error:**
${data.error}

---

## BUSINESS IMPACT

**Impact:**
* User authentication unavailable
* Test execution interrupted
* BullMQ worker lock expired
* Results cannot be trusted

---

## FINAL RELEASE DECISION

**Status:** EXECUTION BLOCKED
**Website Tested:** NO
**Authentication Available:** NO
**Execution Valid:** NO
**Recommendation:** Resolve Supabase connectivity before executing tests again.
`
      };

      try {
        const jsonContent = JSON.stringify(supabaseInfraReport, null, 2);
        const { data: uploadData, error } = await supabase.storage
          .from('reports')
          .upload(`${executionId}.json`, Buffer.from(jsonContent, 'utf-8'), { contentType: 'application/json', upsert: true });
          
        if (!error && uploadData) {
          const { data: publicData } = supabase.storage.from('reports').getPublicUrl(uploadData.path);
          return { content: supabaseInfraReport, url: publicData.publicUrl, isJson: true };
        }
        return { content: supabaseInfraReport, url: null, isJson: true };
      } catch (e) {
        console.error('Failed to generate or upload infra failure report', e);
        return { content: supabaseInfraReport, url: null, isJson: true };
      }
    }

    const structuredLlm = llm.withStructuredOutput(reportSchema, { name: "extract", strict: true });
    const selectedPrompt = data.executionType === 'API' ? apiPrompt : data.executionType === 'DB' ? dbPrompt : prompt;
    const chain = selectedPrompt.pipe(structuredLlm);
    
    try {
      const response = await chain.invoke({
        testName: data.testName || 'Unknown Workflow',
        status: data.status || 'UNKNOWN',
        scriptGenerationStatus: data.scriptGenerationStatus || 'UNKNOWN',
        playwrightExecutionStatus: data.playwrightExecutionStatus || 'UNKNOWN',
        error: data.error || 'None',
        duration: data.duration || 0,
        browser: data.browser || 'Chromium',
        environment: data.environment || 'Local',
        url: data.url || 'Unknown URL',
        testMetadata: data.testMetadata || '',
        executedSteps: data.executedSteps || '[]',
        logs: data.logs || '',
        screenshotUrl: data.screenshotUrl || 'No screenshot recorded',
        videoUrl: data.videoUrl || 'No video recorded'
      });
      
      const jsonContent = JSON.stringify(response, null, 2);

      // Upload JSON report to Supabase Storage
      const { data: uploadData, error } = await supabase.storage
        .from('reports')
        .upload(`${executionId}.json`, Buffer.from(jsonContent, 'utf-8'), { contentType: 'application/json', upsert: true });
        
      if (!error && uploadData) {
        const { data: publicData } = supabase.storage.from('reports').getPublicUrl(uploadData.path);
        return { content: response, url: publicData.publicUrl, isJson: true };
      }
      
      return { content: response, url: null, isJson: true };
    } catch (e) {
      console.error('Failed to generate or upload report', e);
      return { content: null, url: null, isJson: false };
    }
  }
}

