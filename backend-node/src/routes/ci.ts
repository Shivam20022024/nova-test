import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const CI_API_KEY = process.env.CI_API_KEY || '';
const SELF_BASE_URL = `http://127.0.0.1:${process.env.PORT || 8080}`;

// GET /api/v1/ci/health — session-authenticated (NOT the CI key), for the
// Integrations page to show "CI/CD: Configured / Not configured" without
// ever needing or exposing the actual secret. Defined before requireCiKey
// below so it deliberately skips that gate.
router.get('/health', authenticate, (_req: Request, res: Response) => {
  res.json({ configured: Boolean(CI_API_KEY) });
});

// POST /api/v1/ci/simulate — session-authenticated equivalent of /trigger,
// for the Integrations page's "Simulate a CI push" demo button. A real CI
// pipeline always uses /trigger with the CI_API_KEY; this exists purely so
// a demo can show the same pipeline working without wiring up an actual
// GitHub repo. Always async (returns immediately) since the caller is a
// human waiting on a button, not a CI job blocking a pipeline step.
router.post('/simulate', authenticate, async (req: AuthRequest, res: Response) => {
  const { project_id, suite_id, browsers } = req.body || {};
  if (!project_id && !suite_id) {
    return res.status(400).json({ error: 'project_id or suite_id is required.' });
  }
  const source = {
    provider: 'demo',
    branch: 'main',
    commitSha: randomBytes(4).toString('hex'),
  };
  const { httpStatus, json } = await callSelf('POST', '/api/v1/executions/run-multi-test', {
    test_name: `CI run (${source.commitSha})`,
    browsers: Array.isArray(browsers) && browsers.length > 0 ? browsers : ['chromium'],
    project_id,
    suite_id,
    source,
  });
  if (httpStatus >= 400) {
    return res.status(httpStatus).json({ error: json.error || 'Failed to queue simulated CI run.', details: json });
  }
  const executionIds: string[] = json.executionIds || [];
  res.status(202).json({ message: 'Simulated CI run queued.', executionIds, source });
});

// Auth: reuses the SAME shared CI key already trusted by the rest of the
// API (middleware/auth.ts's x-api-key bypass) instead of inventing a new
// credential for a first version. A per-project, individually-revocable CI
// token — following the exact pattern already proven for per-project Jira
// settings (routes/jira.ts) — is the natural next step, but needs a new
// database table, which is deferred until the database is reachable again.
// This key already works today and nothing about how it works for anything
// ELSE using it changes.
function requireCiKey(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-api-key'];
  if (!CI_API_KEY || provided !== CI_API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key.' });
  }
  next();
}
router.use(requireCiKey);

// Statuses that mean "still in flight" for ExecutionLog — anything else is
// terminal. Deliberately an allowlist of the IN-FLIGHT states rather than
// an enumeration of every terminal one, so this keeps working if a new
// terminal status name is ever added elsewhere without this file knowing.
const IN_FLIGHT_STATUSES = new Set(['QUEUED', 'RUNNING', 'PENDING']);

function toCiStatus(rawStatus: string | undefined): 'passed' | 'failed' | 'running' {
  if (!rawStatus || IN_FLIGHT_STATUSES.has(rawStatus)) return 'running';
  return rawStatus === 'COMPLETED' ? 'passed' : 'failed';
}

// Every call below goes through this — a plain HTTP call to this SAME
// server's own existing, already-working execution endpoints. This route
// is deliberately not a second execution engine: it is a front door onto
// the exact same queueing/status code a person clicking "Run" in the UI
// already uses, authenticated the same way (the CI key satisfies
// middleware/auth.ts's authenticate() exactly like a real client's bearer
// token would).
async function callSelf(method: string, path: string, body?: unknown): Promise<{ httpStatus: number; json: any }> {
  const resp = await fetch(`${SELF_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': CI_API_KEY },
    body: body ? JSON.stringify(body) : null,
  });
  const json = await resp.json().catch(() => ({}));
  return { httpStatus: resp.status, json };
}

// POST /api/v1/ci/trigger
// Body: { project_id?, suite_id?, base_url?, steps?, test_name?, browsers,
//         source?: { provider, repo, branch, commitSha, prNumber },
//         callback_url?, async?: boolean, wait_timeout_ms? }
//
// Default behavior WAITS for the run to reach a terminal state and returns
// one clear pass/fail answer — the thing a CI pipeline step actually wants,
// since there is no synchronous "run and wait" endpoint to build on top of
// otherwise. Pass `async: true` to skip waiting and get executionIds back
// immediately instead, for pipelines that would rather poll
// GET /status/:executionId themselves or receive `callback_url` later.
router.post('/trigger', async (req: Request, res: Response) => {
  const {
    project_id, suite_id, base_url, steps, test_name, browsers, source,
    callback_url, async: runAsync, wait_timeout_ms,
  } = req.body || {};

  if (!project_id && !suite_id) {
    return res.status(400).json({ error: 'project_id or suite_id is required.' });
  }
  if (!Array.isArray(browsers) || browsers.length === 0) {
    return res.status(400).json({ error: 'browsers is required (e.g. ["chromium"]).' });
  }

  const commitLabel = source?.commitSha ? ` (${String(source.commitSha).slice(0, 8)})` : '';
  const { httpStatus, json } = await callSelf('POST', '/api/v1/executions/run-multi-test', {
    test_name: test_name || `CI run${commitLabel}`,
    base_url, steps, browsers, project_id, suite_id, source,
  });

  if (httpStatus >= 400) {
    return res.status(httpStatus).json({ error: json.error || 'Failed to queue CI run.', details: json });
  }

  const executionIds: string[] = json.executionIds || [];
  if (executionIds.length === 0) {
    return res.status(502).json({ error: 'Run was queued but no execution IDs were returned.' });
  }

  if (runAsync) {
    return res.status(202).json({
      message: 'CI run queued.',
      executionIds,
      statusUrls: executionIds.map((id) => `/api/v1/ci/status/${id}`),
    });
  }

  const timeoutMs = Math.min(Math.max(Number(wait_timeout_ms) || 300000, 10000), 900000);
  const deadline = Date.now() + timeoutMs;
  const results: Record<string, 'passed' | 'failed' | 'running'> = {};

  while (Date.now() < deadline) {
    let allDone = true;
    for (const id of executionIds) {
      const { json: execJson } = await callSelf('GET', `/api/v1/executions/${id}`);
      const ciStatus = toCiStatus(execJson?.status);
      results[id] = ciStatus;
      if (ciStatus === 'running') allDone = false;
    }
    if (allDone) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const values = Object.values(results);
  const overall: 'passed' | 'failed' | 'timeout' = values.some((s) => s === 'running')
    ? 'timeout'
    : values.every((s) => s === 'passed') ? 'passed' : 'failed';

  if (callback_url) {
    // Best-effort — the response below is the source of truth regardless
    // of whether this succeeds, so a flaky callback endpoint can never make
    // this trigger call itself fail.
    fetch(callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: overall, executions: results, executionIds }),
    }).catch(() => {});
  }

  res.json({ status: overall, executions: results, executionIds });
});

// GET /api/v1/ci/status/:executionId
// A simple, pipeline-friendly view of a run already in progress — the thing
// a CI status-check step can parse in one line, instead of the full report
// payload GET /api/v1/executions/:id returns.
router.get('/status/:executionId', async (req: Request, res: Response) => {
  const { json } = await callSelf('GET', `/api/v1/executions/${req.params.executionId}`);
  if (!json || json.error) {
    return res.status(404).json({ error: 'Execution not found.' });
  }
  res.json({ executionId: req.params.executionId, status: toCiStatus(json.status), rawStatus: json.status });
});

export default router;
