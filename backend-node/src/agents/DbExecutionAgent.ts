import { supabase } from '../utils/storage';
import { decrypt } from '../lib/crypto';
import { extractShape, diffShape, SchemaDriftEntry } from '../lib/schemaDrift';
import { getByPath, interpolateString, interpolateValue } from '../lib/variableInterpolation';
import { PostgresDriver } from '../lib/dbDrivers/postgres';
import { MysqlDriver } from '../lib/dbDrivers/mysql';
import { MongoDriver } from '../lib/dbDrivers/mongo';
import { DbQueryResult } from '../lib/dbDrivers/types';

/**
 * Sibling to ApiExecutionAgent.ts, purpose-built for database testing.
 * Mirrors the same top-level result contract (success/error/stepLogs/
 * transcriptEvents/scenario_status/screenshotUrl/videoUrl/
 * accessibilityResults/securityResults/visualRegressionData/variables) so
 * executionWorker.ts's aggregation, ReportingAgent call, healing-event
 * scan, and Jira filing logic all keep working unmodified for DB-mode runs.
 *
 * Write/seed queries (INSERT/UPDATE/DELETE, or Mongo insert/update/delete ops)
 * are permitted, but every query — read or write — runs inside an explicit
 * transaction in the driver layer, and is ALWAYS rolled back unless the step
 * sets `commit: true`. DDL/admin statements (DROP/ALTER/TRUNCATE/CREATE/
 * GRANT/REVOKE/MERGE/EXEC/CALL) remain forbidden outright — several engines
 * don't support transactional DDL, so rollback-by-default can't protect
 * against them safely.
 */

export type DbAssertionType =
  | 'rowCount' | 'cellValue' | 'jsonPath' | 'schemaColumns'
  | 'columnNotNull' | 'columnUnique' | 'regexMatch' | 'dataType' | 'dateValid' | 'aggregate';
export type DbAssertionOperator = 'equals' | 'notEquals' | 'contains' | 'exists' | 'greaterThan' | 'lessThan';
export type DbAggregateFunction = 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface DbAssertion {
  type: DbAssertionType;
  path?: string;        // for cellValue/jsonPath/columnNotNull/columnUnique/regexMatch/dataType/dateValid/aggregate: the column/field name (or a dot/bracket path for cellValue/jsonPath)
  operator: DbAssertionOperator;
  expected?: any;
  function?: DbAggregateFunction; // for 'aggregate' only
}

export interface DbVariableExtraction {
  name: string;
  path: string;          // dot/bracket path into the `rows` array, e.g. "0.id"
}

export type MongoOperation = 'find' | 'aggregate' | 'countDocuments' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';

export interface DbStep {
  connectionId: string;
  scenarioName?: string;
  // SQL engines (postgres/mysql)
  query?: string;
  params?: any[];
  // MongoDB
  collection?: string;
  operation?: MongoOperation;
  filter?: any;
  pipeline?: any[];
  document?: any;   // for insertOne/insertMany
  update?: any;      // for updateOne/updateMany
  assertions?: DbAssertion[];
  extract?: DbVariableExtraction[];
  // Write safety: every query runs in a transaction; unless commit is true
  // it's always rolled back after assertions run, so a write step leaves no
  // permanent side effect unless explicitly requested.
  commit?: boolean;
}

const READ_ONLY_SQL_PATTERN = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i;
const FORBIDDEN_SQL_PATTERN = /\b(DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|EXEC|CALL)\b/i;
const ALLOWED_MONGO_OPS: MongoOperation[] = ['find', 'aggregate', 'countDocuments', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];
const WRITE_MONGO_OPS: MongoOperation[] = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];
const ROW_LIMIT = parseInt(process.env.DB_TEST_ROW_LIMIT || '1000', 10);
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_TEST_QUERY_TIMEOUT_MS || '10000', 10);

function assertStatementAllowed(step: DbStep, engine: string) {
  if (engine === 'mongodb') {
    if (!step.operation || !ALLOWED_MONGO_OPS.includes(step.operation)) {
      throw new Error(`OPERATION_NOT_PERMITTED: operation "${step.operation}" is not permitted. Only ${ALLOWED_MONGO_OPS.join('/')} are supported.`);
    }
    return;
  }
  const sql = step.query || '';
  if (!READ_ONLY_SQL_PATTERN.test(sql) || FORBIDDEN_SQL_PATTERN.test(sql)) {
    throw new Error('OPERATION_NOT_PERMITTED: only SELECT/WITH/INSERT/UPDATE/DELETE statements are permitted — DDL and admin statements (DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/MERGE/EXEC/CALL) are never allowed, since they cannot be safely rolled back on every engine.');
  }
}

function isWriteStep(step: DbStep, engine: string): boolean {
  if (engine === 'mongodb') return !!step.operation && WRITE_MONGO_OPS.includes(step.operation);
  return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(step.query || '');
}

function inferValueType(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && !isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  return typeof value;
}

function isValidDateValue(value: any): boolean {
  if (value instanceof Date) return !isNaN(value.getTime());
  if (typeof value === 'string' || typeof value === 'number') return !isNaN(Date.parse(String(value)));
  return false;
}

function evaluateAssertion(assertion: DbAssertion, result: DbQueryResult): { passed: boolean; message: string } {
  let actual: any;
  switch (assertion.type) {
    case 'rowCount':
      actual = result.rows.length;
      break;
    case 'cellValue':
    case 'jsonPath':
      actual = getByPath(result.rows, assertion.path || '');
      break;
    case 'columnNotNull': {
      const nullRows = result.rows
        .map((r, i) => ({ i, v: r[assertion.path || ''] }))
        .filter((r) => r.v === null || r.v === undefined);
      const passed = nullRows.length === 0;
      return {
        passed,
        message: passed
          ? `PASS: columnNotNull(${assertion.path}) — no null/missing values in ${result.rows.length} row(s)`
          : `FAIL: columnNotNull(${assertion.path}) — ${nullRows.length} row(s) had null/missing values (row indexes: ${nullRows.map((r) => r.i).join(', ')})`,
      };
    }
    case 'columnUnique': {
      const values = result.rows.map((r) => r[assertion.path || '']);
      const seen = new Map<string, number>();
      const duplicates: string[] = [];
      for (const v of values) {
        const key = JSON.stringify(v);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      for (const [key, count] of seen.entries()) {
        if (count > 1) duplicates.push(`${key} (x${count})`);
      }
      const passed = duplicates.length === 0;
      return {
        passed,
        message: passed
          ? `PASS: columnUnique(${assertion.path}) — all ${values.length} value(s) unique`
          : `FAIL: columnUnique(${assertion.path}) — duplicate values found: ${duplicates.join(', ')}`,
      };
    }
    case 'regexMatch': {
      let regex: RegExp;
      try {
        regex = new RegExp(String(assertion.expected ?? ''));
      } catch (e: any) {
        return { passed: false, message: `FAIL: regexMatch(${assertion.path}) — invalid pattern "${assertion.expected}": ${e.message}` };
      }
      const mismatches = result.rows
        .map((r, i) => ({ i, v: r[assertion.path || ''] }))
        .filter((r) => {
          const matches = typeof r.v === 'string' && regex.test(r.v);
          return assertion.operator === 'notEquals' ? matches : !matches;
        });
      const passed = mismatches.length === 0;
      const verb = assertion.operator === 'notEquals' ? 'unexpectedly matched' : 'did not match';
      return {
        passed,
        message: passed
          ? `PASS: regexMatch(${assertion.path}) /${assertion.expected}/ — all ${result.rows.length} row(s) as expected`
          : `FAIL: regexMatch(${assertion.path}) /${assertion.expected}/ — ${mismatches.length} row(s) ${verb} (row indexes: ${mismatches.map((r) => r.i).join(', ')})`,
      };
    }
    case 'dataType': {
      const mismatches = result.rows
        .map((r, i) => ({ i, v: r[assertion.path || ''], t: inferValueType(r[assertion.path || '']) }))
        .filter((r) => r.t !== String(assertion.expected));
      const passed = mismatches.length === 0;
      return {
        passed,
        message: passed
          ? `PASS: dataType(${assertion.path}) equals "${assertion.expected}" — all ${result.rows.length} row(s) as expected`
          : `FAIL: dataType(${assertion.path}) equals "${assertion.expected}" — ${mismatches.length} row(s) had a different type (e.g. row ${mismatches[0]?.i}: "${mismatches[0]?.t}")`,
      };
    }
    case 'dateValid': {
      const invalidRows = result.rows
        .map((r, i) => ({ i, v: r[assertion.path || ''] }))
        .filter((r) => !isValidDateValue(r.v));
      const passed = invalidRows.length === 0;
      return {
        passed,
        message: passed
          ? `PASS: dateValid(${assertion.path}) — all ${result.rows.length} row(s) parse as valid dates`
          : `FAIL: dateValid(${assertion.path}) — ${invalidRows.length} row(s) had an invalid date (row indexes: ${invalidRows.map((r) => r.i).join(', ')})`,
      };
    }
    case 'aggregate': {
      const values = result.rows
        .map((r) => Number(r[assertion.path || '']))
        .filter((v) => !isNaN(v));
      const fn = assertion.function || 'count';
      if (fn === 'count') actual = result.rows.length;
      else if (values.length === 0) actual = null;
      else if (fn === 'sum') actual = values.reduce((a, b) => a + b, 0);
      else if (fn === 'avg') actual = values.reduce((a, b) => a + b, 0) / values.length;
      else if (fn === 'min') actual = Math.min(...values);
      else if (fn === 'max') actual = Math.max(...values);
      break;
    }
    case 'schemaColumns': {
      const actualCols = result.columns || Object.keys(result.rows[0] || {});
      const expectedCols: string[] = Array.isArray(assertion.expected)
        ? assertion.expected
        : String(assertion.expected || '').split(',').map((c) => c.trim()).filter(Boolean);
      let passed: boolean;
      if (assertion.operator === 'contains') {
        passed = expectedCols.every((c) => actualCols.includes(c));
      } else {
        passed = expectedCols.length === actualCols.length && expectedCols.every((c) => actualCols.includes(c));
      }
      return {
        passed,
        message: passed
          ? `PASS: schemaColumns ${assertion.operator} [${expectedCols.join(', ')}] (actual: [${actualCols.join(', ')}])`
          : `FAIL: schemaColumns ${assertion.operator} [${expectedCols.join(', ')}] (actual: [${actualCols.join(', ')}])`,
      };
    }
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

  const label = assertion.type === 'cellValue' || assertion.type === 'jsonPath'
    ? `${assertion.type}(${assertion.path})`
    : assertion.type === 'aggregate'
    ? `aggregate(${assertion.function || 'count'}(${assertion.path}))`
    : assertion.type;
  const message = passed
    ? `PASS: ${label} ${assertion.operator} ${assertion.expected ?? ''} (actual: ${JSON.stringify(actual)})`
    : `FAIL: ${label} ${assertion.operator} ${assertion.expected ?? ''} (actual: ${JSON.stringify(actual)})`;
  return { passed, message };
}

async function checkSchemaDrift(suiteId: string | undefined, connectionId: string, queryTemplate: string, rows: any[]): Promise<SchemaDriftEntry[]> {
  if (!suiteId || rows.length === 0) return [];
  try {
    const currentShape = extractShape(rows);
    const { data: existing } = await supabase
      .from('DbSchemaBaseline')
      .select('*')
      .eq('suiteId', suiteId)
      .eq('connectionId', connectionId)
      .eq('queryTemplate', queryTemplate)
      .maybeSingle();
    if (!existing) {
      await supabase.from('DbSchemaBaseline').insert({ suiteId, connectionId, queryTemplate, schema: JSON.stringify(currentShape) });
      return [];
    }
    const baselineShape = JSON.parse(existing.schema);
    const drift = diffShape(baselineShape, currentShape);
    await supabase.from('DbSchemaBaseline').update({ sampleCount: existing.sampleCount + 1 }).eq('id', existing.id);
    return drift;
  } catch {
    return [];
  }
}

function createDriver(engine: string) {
  if (engine === 'mysql') return new MysqlDriver();
  if (engine === 'mongodb') return new MongoDriver();
  return new PostgresDriver();
}

export class DbExecutionAgent {
  async executeScript(
    executionId: string,
    scriptCode: string,
    _browserName: string,
    emitLog: (type: string, message: string) => void,
    options: { variables?: Record<string, any> | undefined; suiteId?: string | undefined; [key: string]: any } = {},
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

    let steps: DbStep[] = [];
    try {
      steps = JSON.parse(scriptCode);
      addStep('PARSE_JSON', 'PASSED', 0, `Parsed ${steps.length} DB step(s)`);
    } catch (e: any) {
      emitLog('agent_log', `Failed to parse DB script: ${e.message}`);
      return {
        success: false,
        error: `Failed to parse DB test script: ${e.message}`,
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

    const variables: Record<string, any> = { ...(options.variables || {}) };
    // Connections are opened/closed per step rather than pooled across the
    // run — simpler and safer for a QA tool than managing a shared pool
    // lifecycle, and the per-step overhead is negligible at test volumes.
    const connectionCache = new Map<string, { engine: string; name: string }>();

    for (const step of steps) {
      const startTime = Date.now();
      let target = '';
      let driver: PostgresDriver | MysqlDriver | MongoDriver | null = null;

      try {
        let connMeta = connectionCache.get(step.connectionId);
        const { data: connection } = await supabase.from('DbConnection').select('*').eq('id', step.connectionId).maybeSingle();
        if (!connection) throw new Error(`Database connection not found: ${step.connectionId}`);
        connMeta = { engine: connection.engine, name: connection.name };
        connectionCache.set(step.connectionId, connMeta);

        assertStatementAllowed(step, connection.engine);
        const stepIsWrite = isWriteStep(step, connection.engine);
        const willCommit = !!step.commit;

        const password = decrypt(connection.encryptedPassword);
        driver = createDriver(connection.engine);
        await driver.connect({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          password,
          ssl: connection.ssl,
        });

        let result: DbQueryResult;
        let queryTemplate: string;

        if (connection.engine === 'mongodb') {
          const resolvedFilter = step.filter ? interpolateValue(step.filter, variables) : undefined;
          const resolvedPipeline = step.pipeline ? interpolateValue(step.pipeline, variables) : undefined;
          const resolvedDocument = step.document ? interpolateValue(step.document, variables) : undefined;
          const resolvedUpdate = step.update ? interpolateValue(step.update, variables) : undefined;
          target = `${step.collection}.${step.operation}`;
          queryTemplate = target;
          emitLog('telemetry', `DB_QUERY_STARTED: ${target}${stepIsWrite ? (willCommit ? ' (WRITE, will commit)' : ' (WRITE, will roll back)') : ''}`);
          result = await (driver as MongoDriver).query(step.collection || '', step.operation!, resolvedFilter, resolvedPipeline, QUERY_TIMEOUT_MS, ROW_LIMIT, willCommit, resolvedDocument, resolvedUpdate);
        } else {
          const resolvedQuery = interpolateString(step.query || '', variables);
          const resolvedParams = step.params ? interpolateValue(step.params, variables) : [];
          target = resolvedQuery;
          queryTemplate = step.query || '';
          emitLog('telemetry', `DB_QUERY_STARTED: ${connection.engine} ${resolvedQuery.slice(0, 120)}${stepIsWrite ? (willCommit ? ' (WRITE, will commit)' : ' (WRITE, will roll back)') : ''}`);
          result = await (driver as PostgresDriver | MysqlDriver).query(resolvedQuery, resolvedParams, QUERY_TIMEOUT_MS, ROW_LIMIT, willCommit);
        }

        const latencyMs = Date.now() - startTime;
        emitLog('telemetry', `DB_QUERY_COMPLETED: ${result.rows.length} row(s) (${latencyMs}ms)`);

        const assertionResults = (step.assertions || []).map((a) => evaluateAssertion(a, result));
        const failedAssertions = assertionResults.filter((r) => !r.passed);
        const stepPassed = failedAssertions.length === 0;

        const extracted: Record<string, any> = {};
        for (const rule of step.extract || []) {
          const value = getByPath(result.rows, rule.path);
          if (value !== undefined) {
            variables[rule.name] = value;
            extracted[rule.name] = value;
          }
        }

        // Read results never touch a schema-drift baseline that a write step
        // might have just perturbed within the same rolled-back transaction —
        // this is intentionally still safe since rollback means the DB's
        // real state is unchanged, so subsequent reads see the pre-write shape.
        const schemaDrift = stepIsWrite ? [] : await checkSchemaDrift(options.suiteId, step.connectionId, queryTemplate, result.rows);

        const writeStatusLine = stepIsWrite
          ? [`WRITE_STATUS: ${willCommit ? 'COMMITTED (change persisted)' : 'ROLLED BACK (test-only, no data was persisted)'}`]
          : [];

        const details = [
          `${connection.engine} ${target} -> ${result.rows.length} row(s) (${latencyMs}ms)`,
          ...writeStatusLine,
          ...assertionResults.map((r) => r.message),
          ...Object.entries(extracted).map(([k, v]) => `EXTRACTED: {{${k}}} = ${JSON.stringify(v)}`),
          ...schemaDrift.map((d) => `SCHEMA_DRIFT: ${d.kind} at ${d.path}${d.expectedType ? ` (expected: ${d.expectedType})` : ''}${d.actualType ? ` (actual: ${d.actualType})` : ''}`),
        ].join('\n');

        addStep(
          'db_query',
          stepPassed ? 'PASSED' : 'FAILED',
          latencyMs,
          details,
          JSON.stringify({
            engine: connection.engine,
            connectionName: connection.name,
            target,
            rowCount: result.rows.length,
            columns: result.columns || Object.keys(result.rows[0] || {}),
            sampleRows: result.rows.slice(0, 20),
            assertionResults,
            extracted,
            schemaDrift,
            isWrite: stepIsWrite,
            committed: stepIsWrite ? willCommit : undefined,
          })
        );
        logTranscriptEvent(connection.engine.toUpperCase(), target, `${result.rows.length} rows`, stepPassed ? 'SUCCESS' : 'FAILED', step.scenarioName);

        if (step.scenarioName) {
          scenario_status[step.scenarioName] = stepPassed ? 'PASS' : 'FAIL';
        }
        if (!stepPassed) {
          success = false;
          executionError = executionError || `Assertion failed on ${connection.engine} query: ${failedAssertions[0]?.message}`;
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        success = false;
        executionError = executionError || `Database step failed: ${err.message}`;
        addStep('db_query', 'FAILED', latencyMs, `Query failed: ${err.message}`, undefined);
        logTranscriptEvent('DB_QUERY', target || step.connectionId, err.message, 'FAILED', step.scenarioName);
        if (step.scenarioName) scenario_status[step.scenarioName] = 'FAIL';
        emitLog('agent_log', `DB query error: ${err.message}`);
      } finally {
        if (driver) await driver.close();
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
