/**
 * Read-only status normalization + aggregation for traceability / sprint
 * reporting. This NEVER changes what is stored on ExecutionLog — it only maps
 * the raw stored status into the coarser buckets the traceability views need,
 * mirroring the sets the frontend already uses
 * (ExecutionListPage: IN_FLIGHT / SUCCESS / FAILURE).
 */

const SUCCESS = new Set(['PASSED', 'COMPLETED', 'Completed With Warnings']);
const FAILURE = new Set(['FAILED', 'BLOCKED']);
const IN_FLIGHT = new Set(['QUEUED', 'RUNNING', 'PENDING', 'GENERATING_SCRIPT', 'HEALING']);

export type NormalizedExecStatus = 'PASSED' | 'FAILED' | 'RUNNING' | 'SKIPPED';

/** One raw ExecutionLog.status → a normalized bucket. */
export function normalizeExecStatus(raw: string | null | undefined): NormalizedExecStatus {
  const v = String(raw || '').trim();
  if (SUCCESS.has(v)) return 'PASSED';
  if (FAILURE.has(v)) return 'FAILED';
  if (IN_FLIGHT.has(v)) return 'RUNNING';
  // CANCELLED and anything unrecognised fall here — treated as an aborted /
  // not-completed run, never as a pass or a fail.
  return 'SKIPPED';
}

const MOBILE_SUCCESS = new Set(['PASSED']);
const MOBILE_FAILURE = new Set(['FAILED', 'INFRA_FAILURE', 'TIMEOUT', 'BLOCKED']);
const MOBILE_IN_FLIGHT = new Set([
  'CREATED', 'QUEUED', 'ALLOCATING_DEVICE', 'STARTING_APPIUM', 'STARTING_SESSION',
  'RUNNING', 'HEALING', 'RETRYING', 'WAITING_APPROVAL', 'CLEANUP',
]);

export type NormalizedMobileExecStatus = 'PASSED' | 'FAILED' | 'RUNNING' | 'REVIEW';

/**
 * One raw mobile_executions.status -> a normalized bucket. Separate from
 * normalizeExecStatus above because the mobile engine's status vocabulary is
 * its own (CREATED/ALLOCATING_DEVICE/HEALING/REQUIRES_REVIEW/... — see
 * backend/mobile/models.py's MobileExecution.status comment), not the web
 * engine's. REQUIRES_REVIEW and CANCELLED land in REVIEW rather than FAILED —
 * a self-heal that could not confirm itself is a "needs a human look" result,
 * not a confirmed failure.
 */
export function normalizeMobileExecStatus(raw: string | null | undefined): NormalizedMobileExecStatus {
  const v = String(raw || '').trim();
  if (MOBILE_SUCCESS.has(v)) return 'PASSED';
  if (MOBILE_FAILURE.has(v)) return 'FAILED';
  if (MOBILE_IN_FLIGHT.has(v)) return 'RUNNING';
  return 'REVIEW';
}

export type NormalizedApiDbExecStatus = 'PASSED' | 'FAILED' | 'RUNNING';

/** ApiExecution/DbTestExecution only ever carry QUEUED|RUNNING|PASSED|FAILED
 *  (see queue/apiDbTestWorker.ts) — no self-heal/review state to bucket. */
export function normalizeApiDbExecStatus(raw: string | null | undefined): NormalizedApiDbExecStatus {
  const v = String(raw || '').trim();
  if (v === 'PASSED') return 'PASSED';
  if (v === 'FAILED') return 'FAILED';
  return 'RUNNING';
}

export type AggregatedStatus = 'PASSED' | 'FAILED' | 'PARTIAL' | 'RUNNING' | 'SKIPPED' | 'NOT_RUN';

export interface ExecRowLite {
  id: string;
  status: string | null;
  browser: string | null;
  createdAt: string;
}

export interface AggregatedResult {
  status: AggregatedStatus;
  /** Latest execution per browser (the rows the status was computed from). */
  latestByBrowser: { browser: string; executionId: string; status: NormalizedExecStatus; createdAt: string }[];
  lastExecutedAt: string | null;
  executionCount: number;
}

/**
 * Deterministic rollup for ONE logical test case (all rows share a testRunId,
 * usually within one sprint). Multi-browser aware, and re-run aware: for each
 * browser only the most-recent execution counts.
 *
 *   NOT_RUN  no executions at all
 *   RUNNING  any browser's latest run is still in flight
 *   FAILED   any browser's latest run failed (and none are running)
 *   PASSED   ≥1 browser, and every browser's latest run passed
 *   SKIPPED  ≥1 browser, and every browser's latest run was cancelled/aborted
 *   PARTIAL  a mix — some passed, some skipped/aborted (incomplete coverage)
 */
export function aggregateTestCaseStatus(rows: ExecRowLite[]): AggregatedResult {
  if (!rows || rows.length === 0) {
    return { status: 'NOT_RUN', latestByBrowser: [], lastExecutedAt: null, executionCount: 0 };
  }

  const byBrowser = new Map<string, ExecRowLite>();
  for (const r of rows) {
    const b = (r.browser || 'unknown').toLowerCase();
    const cur = byBrowser.get(b);
    if (!cur || new Date(r.createdAt).getTime() > new Date(cur.createdAt).getTime()) {
      byBrowser.set(b, r);
    }
  }

  const latestByBrowser = [...byBrowser.entries()].map(([browser, r]) => ({
    browser,
    executionId: r.id,
    status: normalizeExecStatus(r.status),
    createdAt: r.createdAt,
  }));

  const statuses = latestByBrowser.map((x) => x.status);
  let status: AggregatedStatus;
  if (statuses.includes('RUNNING')) status = 'RUNNING';
  else if (statuses.includes('FAILED')) status = 'FAILED';
  else if (statuses.every((s) => s === 'PASSED')) status = 'PASSED';
  else if (statuses.every((s) => s === 'SKIPPED')) status = 'SKIPPED';
  else status = 'PARTIAL';

  const lastExecutedAt = rows
    .map((r) => r.createdAt)
    .sort()
    .slice(-1)[0] || null;

  return { status, latestByBrowser, lastExecutedAt, executionCount: rows.length };
}

/* ── Regression timeline ─────────────────────────────────────────────────── */

export interface SprintMeta {
  id: string;
  name: string;
  sequence: number | null;
  createdAt: string;
  releaseId: string;
}
export interface ReleaseMeta {
  id: string;
  name: string;
  sequence: number | null;
  createdAt: string;
}
export interface TimelinePoint {
  releaseId: string;
  releaseName: string;
  sprintId: string;
  sprintName: string;
  aggregatedStatus: AggregatedStatus;
  at: string | null;
}

// Release.sequence → Sprint.sequence → createdAt, nulls last. Encoded as one
// lexically-sortable string so the sort needs no tuple indexing.
const pad = (n: number | null | undefined) => String(n ?? 99_999_999).padStart(9, '0');
const sortKey = (rel: ReleaseMeta, spr: SprintMeta) =>
  `${pad(rel.sequence)}|${rel.createdAt}|${pad(spr.sequence)}|${spr.createdAt}`;

/**
 * Orders a test case's executions into one aggregated status per
 * (release, sprint), sorted by Release.sequence → Sprint.sequence → createdAt
 * (nulls last, createdAt as the deterministic tie-break).
 */
export function buildTestCaseTimeline(
  executions: (ExecRowLite & { sprintId: string | null })[],
  sprintsById: Map<string, SprintMeta>,
  releasesById: Map<string, ReleaseMeta>,
): TimelinePoint[] {
  const bySprint = new Map<string, ExecRowLite[]>();
  for (const e of executions) {
    if (!e.sprintId || !sprintsById.has(e.sprintId)) continue;
    const list = bySprint.get(e.sprintId) || [];
    list.push(e);
    bySprint.set(e.sprintId, list);
  }

  const points: (TimelinePoint & { _k: string })[] = [];
  for (const [sprintId, rows] of bySprint) {
    const spr = sprintsById.get(sprintId);
    if (!spr) continue;
    const rel = releasesById.get(spr.releaseId);
    if (!rel) continue;
    const agg = aggregateTestCaseStatus(rows);
    points.push({
      releaseId: rel.id,
      releaseName: rel.name,
      sprintId: spr.id,
      sprintName: spr.name,
      aggregatedStatus: agg.status,
      at: agg.lastExecutedAt,
      _k: sortKey(rel, spr),
    });
  }
  points.sort((a, b) => (a._k < b._k ? -1 : a._k > b._k ? 1 : 0));
  return points.map(({ _k, ...p }) => p);
}

export interface RegressionResult {
  status: 'STABLE' | 'REGRESSED' | 'RECOVERED' | 'INSUFFICIENT_DATA';
  regressionIntroducedAt: { releaseId: string; releaseName: string; sprintId: string; sprintName: string; at: string | null } | null;
  recoveredAt: { releaseId: string; releaseName: string; sprintId: string; sprintName: string; at: string | null } | null;
  timeline: TimelinePoint[];
}

/** First PASSED→FAILED transition in the timeline, and any later FAILED→PASSED. */
export function detectRegression(timeline: TimelinePoint[]): RegressionResult {
  const decided = timeline.filter((p) => p.aggregatedStatus === 'PASSED' || p.aggregatedStatus === 'FAILED');
  if (decided.length < 2) {
    return { status: 'INSUFFICIENT_DATA', regressionIntroducedAt: null, recoveredAt: null, timeline };
  }
  const loc = (p: TimelinePoint) => ({
    releaseId: p.releaseId,
    releaseName: p.releaseName,
    sprintId: p.sprintId,
    sprintName: p.sprintName,
    at: p.at,
  });

  let introduced: TimelinePoint | null = null;
  let recovered: TimelinePoint | null = null;
  for (let i = 1; i < decided.length; i++) {
    const prevPoint = decided[i - 1];
    const curPoint = decided[i];
    if (!prevPoint || !curPoint) continue;
    const prev = prevPoint.aggregatedStatus;
    const cur = curPoint.aggregatedStatus;
    if (!introduced && prev === 'PASSED' && cur === 'FAILED') {
      introduced = curPoint;
    } else if (introduced && !recovered && prev === 'FAILED' && cur === 'PASSED') {
      recovered = curPoint;
      break;
    }
  }

  if (!introduced) {
    return { status: 'STABLE', regressionIntroducedAt: null, recoveredAt: null, timeline };
  }
  return {
    status: recovered ? 'RECOVERED' : 'REGRESSED',
    regressionIntroducedAt: loc(introduced),
    recoveredAt: recovered ? loc(recovered) : null,
    timeline,
  };
}
