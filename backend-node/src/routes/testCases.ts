import { Router } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';
import { flowProducer, executionQueueName } from '../queue/executionWorker';
import { isProjectOwned } from '../utils/traceabilityScope';
import { resolveTraceOrRespond, traceCols } from './executions';
import {
  buildTestCaseTimeline,
  detectRegression,
  ExecRowLite,
  ReleaseMeta,
  SprintMeta,
} from '../utils/traceabilityRollup';

/**
 * Read-only traceability for a single Test Case (the TestRun model). Additive:
 * introduces no change to TestRun / TestSuite / execution behaviour. Every
 * handler resolves ownership through TestRun → TestSuite → Project.userId.
 */
const router = Router();
router.use(authenticate);

/** Load a TestRun only if the caller owns its project; returns { testRun, projectId }. */
async function resolveTestRunScope(userId: string | undefined, testRunId: string) {
  const { data, error } = await supabase
    .from('TestRun')
    .select('id, name, code, intent, steps, suiteId, createdAt, updatedAt, suite:TestSuite!inner(projectId, name, type)')
    .eq('id', testRunId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const projectId = (data as any).suite.projectId as string;
  if (!(await isProjectOwned(userId, projectId))) return null;
  return { testRun: data as any, projectId };
}

/** All SprintTestCase + ExecutionLog rows for a test case, plus the sprint/release lookup maps. */
async function loadTestCaseHistory(testRunId: string) {
  const { data: assignments, error: aErr } = await supabase
    .from('SprintTestCase')
    .select('id, sprintId, assignmentSource, carriedFromSprintId, addedAt, addedByUserId')
    .eq('testRunId', testRunId)
    .order('addedAt', { ascending: true });
  if (aErr) throw aErr;

  const { data: executions, error: eErr } = await supabase
    .from('ExecutionLog')
    .select('id, status, browser, createdAt, durationMs, sprintId, releaseId, jiraTicketId, jiraTicketUrl')
    .eq('testRunId', testRunId)
    .order('createdAt', { ascending: true });
  if (eErr) throw eErr;

  const sprintIds = [
    ...new Set([
      ...(assignments || []).map((a: any) => a.sprintId),
      ...(assignments || []).map((a: any) => a.carriedFromSprintId),
      ...(executions || []).map((e: any) => e.sprintId),
    ].filter(Boolean)),
  ];

  const sprintsById = new Map<string, SprintMeta>();
  const releasesById = new Map<string, ReleaseMeta>();
  if (sprintIds.length > 0) {
    const { data: sprints, error: sErr } = await supabase
      .from('Sprint')
      .select('id, name, sequence, createdAt, releaseId')
      .in('id', sprintIds);
    if (sErr) throw sErr;
    for (const s of sprints || []) sprintsById.set(s.id, s as SprintMeta);

    const releaseIds = [...new Set((sprints || []).map((s: any) => s.releaseId))];
    if (releaseIds.length > 0) {
      const { data: releases, error: rErr } = await supabase
        .from('Release')
        .select('id, name, sequence, createdAt')
        .in('id', releaseIds);
      if (rErr) throw rErr;
      for (const r of releases || []) releasesById.set(r.id, r as ReleaseMeta);
    }
  }

  return { assignments: assignments || [], executions: executions || [], sprintsById, releasesById };
}

// GET /api/v1/test-cases/:id/traceability
// Two complete histories — assignment history and raw execution history. The
// raw history is NEVER collapsed (a UI may summarise; the endpoint does not).
router.get('/:id/traceability', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveTestRunScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Test case not found.' });

    const { assignments, executions, sprintsById, releasesById } = await loadTestCaseHistory(scope.testRun.id);

    const relOf = (sprintId: string | null) => {
      if (!sprintId) return null;
      const spr = sprintsById.get(sprintId);
      if (!spr) return null;
      const rel = releasesById.get(spr.releaseId);
      return rel ? { releaseId: rel.id, releaseName: rel.name, sprintId: spr.id, sprintName: spr.name } : null;
    };

    res.json({
      testCase: {
        id: scope.testRun.id,
        name: scope.testRun.name,
        code: scope.testRun.code,
        intent: scope.testRun.intent,
        suiteId: scope.testRun.suiteId,
        suiteName: scope.testRun.suite?.name ?? null,
        projectId: scope.projectId,
      },
      assignmentHistory: assignments.map((a: any) => ({
        sprintId: a.sprintId,
        ...(relOf(a.sprintId) || { releaseId: null, releaseName: null, sprintName: null }),
        assignmentSource: a.assignmentSource,
        carriedFrom: relOf(a.carriedFromSprintId),
        addedAt: a.addedAt,
        addedByUserId: a.addedByUserId,
      })),
      executionHistory: executions.map((e: any) => ({
        executionId: e.id,
        status: e.status,
        browser: e.browser,
        createdAt: e.createdAt,
        durationMs: e.durationMs,
        ...(relOf(e.sprintId) || {
          releaseId: e.releaseId || null,
          releaseName: null,
          sprintId: e.sprintId || null,
          sprintName: null,
        }),
        jiraTicketId: e.jiraTicketId,
        jiraTicketUrl: e.jiraTicketUrl,
        reportPath: `/app/execution/${e.id}/report`,
      })),
    });
  } catch (err: any) {
    console.error('Error building test-case traceability:', err);
    res.status(500).json({ error: 'Failed to build test-case traceability' });
  }
});

// GET /api/v1/test-cases/:id/regression
// Ordered per-(release, sprint) aggregated status + the first PASS→FAIL
// transition (and any later FAIL→PASS recovery). Uses the aggregated logical
// result, never a raw single-browser row.
router.get('/:id/regression', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveTestRunScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Test case not found.' });

    const { executions, sprintsById, releasesById } = await loadTestCaseHistory(scope.testRun.id);

    const rows: (ExecRowLite & { sprintId: string | null })[] = executions.map((e: any) => ({
      id: e.id,
      status: e.status,
      browser: e.browser,
      createdAt: e.createdAt,
      sprintId: e.sprintId,
    }));

    const timeline = buildTestCaseTimeline(rows, sprintsById, releasesById);
    const regression = detectRegression(timeline);

    res.json({
      testCase: {
        id: scope.testRun.id,
        name: scope.testRun.name,
        code: scope.testRun.code,
        projectId: scope.projectId,
      },
      ...regression,
    });
  } catch (err: any) {
    console.error('Error computing test-case regression:', err);
    res.status(500).json({ error: 'Failed to compute test-case regression' });
  }
});

// POST /api/v1/test-cases/:id/run
// Runs ONE test case directly. REUSES the exact execution path
// /sprints/:id/run uses: an ExecutionLog row (status QUEUED) + a BullMQ child
// job carrying `steps`, so executionWorker takes its explicit-steps branch
// and runs the saved plan through the unchanged Playwright pipeline.
// sprintId/releaseId are OPTIONAL here (same resolveRunTraceability contract
// as /executions/run-multi-test and /autonomous/run) — the frontend's "Run
// Test" modal requires picking both, but this endpoint itself still accepts
// a bare run for any other caller.
//
// { browser?: string, sprintId?: string, releaseId?: string (or snake_case) }
router.post('/:id/run', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveTestRunScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Test case not found.' });

    const tr = scope.testRun;

    const trace = await resolveTraceOrRespond(req, res);
    if (!trace) return;

    if (tr.suite?.type && tr.suite.type !== 'WEB') {
      return res.status(400).json({
        error: `Direct run currently supports web test cases only (this one is in a ${tr.suite.type} suite).`,
      });
    }

    // Validate: must have executable steps.
    let steps: any[] = [];
    try {
      steps = typeof tr.steps === 'string' ? JSON.parse(tr.steps) : Array.isArray(tr.steps) ? tr.steps : [];
    } catch {
      steps = [];
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({
        error: 'This test case has no steps to run. Open it, add at least one step (start with a "goto"), and save.',
      });
    }

    // Validate: must have a starting URL (a goto step with a real http(s) URL).
    const firstGoto = steps.find((s: any) => s && s.action === 'goto' && typeof s.url === 'string' && s.url.trim());
    const targetUrl = (firstGoto?.url || '').trim();
    if (!targetUrl) {
      return res.status(400).json({
        error: 'This test case has no starting URL. Add a "goto" step whose URL is the page to open.',
      });
    }
    if (!/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({
        error: `The starting URL "${targetUrl}" is not valid — it must begin with http:// or https://.`,
      });
    }

    const browser = String(req.body?.browser || 'chromium').toLowerCase();

    const { data: execution, error: eErr } = await supabase
      .from('ExecutionLog')
      .insert({
        suiteId: tr.suiteId,
        status: 'QUEUED',
        browser,
        executionType: 'WEB',
        testName: tr.name,
        targetUrl,
        description: `Direct run: ${tr.name}`,
        ...traceCols(trace),
        // The test run being executed is always this one, regardless of
        // whatever (if anything) resolveTraceOrRespond resolved a testRunId
        // to — never let a body-supplied value override the URL param.
        testRunId: tr.id,
      })
      .select()
      .single();
    if (eErr) throw eErr;

    await flowProducer.add({
      name: 'cross-browser-suite',
      queueName: executionQueueName,
      data: { testRunId: tr.id, browsers: [browser] },
      children: [
        {
          name: 'direct-test',
          queueName: executionQueueName,
          data: {
            executionId: execution.id,
            testName: tr.name,
            targetUrl,
            browser,
            steps, // -> executionWorker explicit-steps branch (no AI generation)
          },
          opts: { jobId: execution.id, attempts: 1 },
        },
      ],
    });

    res.status(202).json({
      message: 'Test run queued',
      executionId: execution.id,
      executionIds: [execution.id],
      testRunId: tr.id,
      testName: tr.name,
      browser,
      status: 'QUEUED',
    });
  } catch (err: any) {
    console.error('Error running test case:', err);
    res.status(500).json({ error: 'Failed to queue test run' });
  }
});

export default router;
