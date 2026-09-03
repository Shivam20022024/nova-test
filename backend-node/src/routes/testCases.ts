import { Router } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';
import { isProjectOwned } from '../utils/traceabilityScope';
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
    .select('id, name, code, intent, suiteId, createdAt, updatedAt, suite:TestSuite!inner(projectId, name)')
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

export default router;
