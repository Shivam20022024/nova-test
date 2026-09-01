import axios, { AxiosRequestConfig } from 'axios';
import { supabase } from '../utils/storage';
import { extractShape, diffShape, SchemaDriftEntry } from '../lib/schemaDrift';
import { getByPath, interpolateString, interpolateValue } from '../lib/variableInterpolation';

/**
 * Sibling to ExecutionAgent.ts, purpose-built for HTTP/API testing instead
 * of browser automation. Deliberately mirrors ExecutionAgent's top-level
 * result contract exactly (success/error/stepLogs/transcriptEvents/
 * scenario_status/screenshotUrl/videoUrl/accessibilityResults/
 * securityResults/visualRegressionData) so executionWorker.ts's
 * aggregation, ReportingAgent call, healing-event scan, and Jira filing
 * logic all keep working completely unmodified for API-mode runs.
 */

export type ApiAssertionType = 'status' | 'jsonPath' | 'header' | 'responseTime';
export type ApiAssertionOperator = 'equals' | 'notEquals' | 'contains' | 'exists' | 'greaterThan' | 'lessThan';

export interface ApiAssertion {
  type: ApiAssertionType;
  path?: string;       // for jsonPath (dot/bracket path into response body) or header (header name)
  operator: ApiAssertionOperator;
  expected?: any;
}

export interface ApiVariableExtraction {
  name: string;                        // variable name to store under, referenced later as {{name}}
  from: 'body' | 'header' | 'status';
  path?: string;                       // dot/bracket path into response body, or header name
}

export interface ApiStep {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: any;
  assertions?: ApiAssertion[];
  scenarioName?: string;
  extract?: ApiVariableExtraction[];
}

function evaluateAssertion(assertion: ApiAssertion, ctx: { status: number; headers: Record<string, any>; body: any; latencyMs: number }): { passed: boolean; message: string } {
  let actual: any;
  switch (assertion.type) {
    case 'status':
      actual = ctx.status;
      break;
    case 'header':
      actual = ctx.headers?.[(assertion.path || '').toLowerCase()];
      break;
    case 'jsonPath':
      actual = getByPath(ctx.body, assertion.path || '');
      break;
    case 'responseTime':
      actual = ctx.latencyMs;
      break;
    default:
      return { passed: false, message: `Unknown assertion type: ${assertion.type}` };
  }

  let passed = false;
  switch (assertion.operator) {
    case 'equals':
      passed = actual === assertion.expected || String(actual) === String(assertion.expected);
      break;
    case 'notEquals':
      passed = String(actual) !== String(assertion.expected);
      break;
    case 'contains':
      passed = typeof actual === 'string' && actual.includes(String(assertion.expected));
      break;
    case 'exists':
      passed = actual !== undefined && actual !== null;
      break;
    case 'greaterThan':
      passed = Number(actual) > Number(assertion.expected);
      break;
    case 'lessThan':
      passed = Number(actual) < Number(assertion.expected);
      break;
  }

  const label = assertion.type === 'jsonPath' || assertion.type === 'header' ? `${assertion.type}(${assertion.path})` : assertion.type;
  const message = passed
    ? `PASS: ${label} ${assertion.operator} ${assertion.expected ?? ''} (actual: ${JSON.stringify(actual)})`
    : `FAIL: ${label} ${assertion.operator} ${assertion.expected ?? ''} (actual: ${JSON.stringify(actual)})`;

  return { passed, message };
}

// Compares this response against the stored baseline shape for this
// (suite, method, urlTemplate) triple. First-ever response for a given
// endpoint establishes the baseline (no drift reported); every response
// after that is diffed against the ORIGINAL baseline, which is
// intentionally never auto-overwritten — otherwise drift silently absorbed
// into a new baseline would never be flagged again. Non-fatal on any error:
// contract tracking should never break the underlying HTTP test.
async function checkSchemaDrift(suiteId: string | undefined, method: string, urlTemplate: string, responseData: any): Promise<SchemaDriftEntry[]> {
  if (!suiteId || responseData === null || typeof responseData !== 'object') return [];
  try {
    const currentShape = extractShape(responseData);
    const { data: existing } = await supabase
      .from('ApiSchemaBaseline')
      .select('*')
      .eq('suiteId', suiteId)
      .eq('method', method)
      .eq('urlTemplate', urlTemplate)
      .maybeSingle();
    if (!existing) {
      await supabase.from('ApiSchemaBaseline').insert({ suiteId, method, urlTemplate, schema: JSON.stringify(currentShape) });
      return [];
    }
    const baselineShape = JSON.parse(existing.schema);
    const drift = diffShape(baselineShape, currentShape);
    await supabase.from('ApiSchemaBaseline').update({ sampleCount: existing.sampleCount + 1 }).eq('id', existing.id);
    return drift;
  } catch {
    return [];
  }
}

export class ApiExecutionAgent {
  async executeScript(
    executionId: string,
    scriptCode: string,
    _browserName: string,
    emitLog: (type: string, message: string) => void,
    options: { testCases?: any[]; [key: string]: any } = {},
    _emitFrame?: (frame: string) => void
  ) {
    let success = true;
    let executionError: string | null = null;
    const stepLogs: Array<{ action: string; status: string; time: string; durationMs?: number; details?: string; value?: string }> = [];
    const transcriptEvents: any[] = [];
    const scenario_status: Record<string, string> = {};

    const addStep = (action: string, status: string, durationMs: number | undefined, details: string, value?: string) => {
      const entry: any = { action, status, time: new Date().toISOString(), details };
      if (durationMs !== undefined) entry.durationMs = durationMs;
      if (value !== undefined) entry.value = value;
      stepLogs.push(entry);
    };
    const logTranscriptEvent = (action: string, target: string, value: string | undefined, status: string, scenarioName?: string) => {
      transcriptEvents.push({ action, target, value, status, scenarioName, timestamp: new Date().toISOString() });
    };

    let steps: ApiStep[] = [];
    try {
      steps = JSON.parse(scriptCode);
      addStep('PARSE_JSON', 'PASSED', 0, `Parsed ${steps.length} API step(s)`);
    } catch (e: any) {
      emitLog('agent_log', `Failed to parse API script: ${e.message}`);
      return {
        success: false,
        error: `Failed to parse API test script: ${e.message}`,
        screenshotUrl: null,
        videoUrl: null,
        stepLogs: [{ action: 'PARSE_JSON', status: 'FAILED', time: new Date().toISOString(), details: e.message }],
        transcriptEvents: [],
        accessibilityResults: null,
        securityResults: null,
        scenario_status: {},
        visualRegressionData: null,
      };
    }

    steps.forEach((step) => {
      if (step.scenarioName && !scenario_status[step.scenarioName]) {
        scenario_status[step.scenarioName] = 'NOT_STARTED';
      }
    });

    // Variable store seeded from caller-provided environment/initial variables (options.variables),
    // then progressively enriched by each step's `extract` rules so later steps can reference
    // values captured from earlier responses via {{varName}} placeholders.
    const variables: Record<string, any> = { ...(options.variables || {}) };

    for (const step of steps) {
      const startTime = Date.now();
      const resolvedUrl = interpolateString(step.url, variables);
      const resolvedHeaders = step.headers ? interpolateValue(step.headers, variables) : undefined;
      const resolvedBody = step.body !== undefined ? interpolateValue(step.body, variables) : undefined;

      emitLog('telemetry', `API_REQUEST_STARTED: ${step.method} ${resolvedUrl}`);

      try {
        const config: AxiosRequestConfig = {
          method: step.method,
          url: resolvedUrl,
          headers: resolvedHeaders || {},
          data: resolvedBody,
          validateStatus: () => true, // never throw on non-2xx — we assert on status ourselves
          timeout: 30000,
        };

        const response = await axios.request(config);
        const latencyMs = Date.now() - startTime;
        const responseHeaders = response.headers as Record<string, any>;

        emitLog('telemetry', `API_RESPONSE_RECEIVED: ${response.status} (${latencyMs}ms)`);

        const assertionResults = (step.assertions || []).map((a) =>
          evaluateAssertion(a, { status: response.status, headers: responseHeaders, body: response.data, latencyMs })
        );
        const failedAssertions = assertionResults.filter((r) => !r.passed);
        const stepPassed = failedAssertions.length === 0;

        const extracted: Record<string, any> = {};
        for (const rule of step.extract || []) {
          let value: any;
          if (rule.from === 'status') value = response.status;
          else if (rule.from === 'header') value = responseHeaders?.[(rule.path || '').toLowerCase()];
          else value = getByPath(response.data, rule.path || '');
          if (value !== undefined) {
            variables[rule.name] = value;
            extracted[rule.name] = value;
          }
        }

        const schemaDrift = response.status >= 200 && response.status < 300
          ? await checkSchemaDrift(options.suiteId, step.method, step.url, response.data)
          : [];

        const details = [
          `${step.method} ${resolvedUrl} -> ${response.status} (${latencyMs}ms)`,
          ...assertionResults.map((r) => r.message),
          ...Object.entries(extracted).map(([k, v]) => `EXTRACTED: {{${k}}} = ${JSON.stringify(v)}`),
          ...schemaDrift.map((d) => `SCHEMA_DRIFT: ${d.kind} at ${d.path}${d.expectedType ? ` (expected: ${d.expectedType})` : ''}${d.actualType ? ` (actual: ${d.actualType})` : ''}`),
        ].join('\n');

        addStep(
          'http_request',
          stepPassed ? 'PASSED' : 'FAILED',
          latencyMs,
          details,
          JSON.stringify({
            method: step.method,
            url: resolvedUrl,
            requestHeaders: resolvedHeaders || {},
            requestBody: resolvedBody ?? null,
            status: response.status,
            responseHeaders,
            responseBody: response.data,
            latencyMs,
            assertionResults,
            extracted,
            schemaDrift,
          })
        );
        if (schemaDrift.length > 0) {
          emitLog('telemetry', `SCHEMA_DRIFT_DETECTED: ${schemaDrift.length} change(s) on ${step.method} ${resolvedUrl}`);
        }
        logTranscriptEvent(step.method, resolvedUrl, String(response.status), stepPassed ? 'SUCCESS' : 'FAILED', step.scenarioName);

        if (step.scenarioName) {
          scenario_status[step.scenarioName] = stepPassed ? 'PASS' : 'FAIL';
        }

        if (!stepPassed) {
          success = false;
          executionError = executionError || `Assertion failed on ${step.method} ${resolvedUrl}: ${failedAssertions[0]?.message}`;
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        success = false;
        executionError = executionError || `Request failed: ${step.method} ${resolvedUrl} — ${err.message}`;
        addStep('http_request', 'FAILED', latencyMs, `${step.method} ${resolvedUrl} failed: ${err.message}`, undefined);
        logTranscriptEvent(step.method, resolvedUrl, err.message, 'FAILED', step.scenarioName);
        if (step.scenarioName) scenario_status[step.scenarioName] = 'FAIL';
        emitLog('agent_log', `API request error: ${err.message}`);
      }
    }

    return {
      success,
      error: executionError,
      screenshotUrl: null,
      videoUrl: null,
      stepLogs,
      transcriptEvents,
      accessibilityResults: null,
      securityResults: null,
      scenario_status,
      visualRegressionData: null,
      variables,
    };
  }
}
