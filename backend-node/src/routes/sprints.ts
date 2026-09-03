import { Router } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';
import { flowProducer, executionQueueName } from '../queue/executionWorker';
import { resolveReleaseScope, resolveSprintScope, isTestRunInProject } from '../utils/traceabilityScope';
import { aggregateTestCaseStatus, AggregatedStatus, ExecRowLite, normalizeExecStatus } from '../utils/traceabilityRollup';

/**
 * Sprint management. A Sprint always belongs to exactly one Release
 * (Sprint.releaseId → Release.id), and a Release belongs to a Project — so
 * every handler here resolves ownership through resolveSprintScope /
 * resolveReleaseScope before doing anything.
 *
 * This router is additive: it introduces no change to the existing
 * /api/v1/releases routes, to TestSuite/TestRun, or to any execution path.
 */
const router = Router();
router.use(authenticate);

const SPRINT_STATUSES = ['PLANNED', 'ACTIVE', 'CLOSED'];

// POST /api/v1/sprints
// { releaseId, name, sequence?, status?, startDate?, endDate? }
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { releaseId, name, sequence, status, startDate, endDate } = req.body || {};
    if (!releaseId || !name || !String(name).trim()) {
      return res.status(400).json({ error: 'releaseId and name are required.' });
    }
    if (status && !SPRINT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${SPRINT_STATUSES.join(', ')}` });
    }

    const scope = await resolveReleaseScope(req.user?.id, releaseId);
    if (!scope) return res.status(404).json({ error: 'Release not found.' });

    // sequence: use the supplied value, else next-in-line for this release.
    let seq: number;
    if (Number.isFinite(Number(sequence))) {
      seq = Number(sequence);
    } else {
      const { data: last } = await supabase
        .from('Sprint')
        .select('sequence')
        .eq('releaseId', releaseId)
        .order('sequence', { ascending: false })
        .limit(1)
        .maybeSingle();
      seq = (last?.sequence ?? 0) + 1;
    }

    const { data, error } = await supabase
      .from('Sprint')
      .insert({
        releaseId,
        name: String(name).trim(),
        sequence: seq,
        status: status || 'PLANNED',
        startDate: startDate || null,
        endDate: endDate || null,
      })
      .select()
      .single();
    if (error) {
      if ((error as any).code === '23505') {
        return res.status(409).json({ error: 'A sprint with that name already exists in this release.' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err: any) {
    console.error('Error creating sprint:', err);
    res.status(500).json({ error: 'Failed to create sprint' });
  }
});

// GET /api/v1/sprints/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });
    res.json({
      ...scope.sprint,
      release: {
        id: scope.release.id,
        name: scope.release.name,
        status: scope.release.status ?? 'PLANNED',
        projectId: scope.projectId,
      },
    });
  } catch (err: any) {
    console.error('Error fetching sprint:', err);
    res.status(500).json({ error: 'Failed to fetch sprint' });
  }
});

// PATCH /api/v1/sprints/:id
// { name?, sequence?, status?, startDate?, endDate? }
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const { name, sequence, status, startDate, endDate } = req.body || {};
    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = String(name).trim();
    }
    if (sequence !== undefined) updates.sequence = Number(sequence);
    if (status !== undefined) {
      if (!SPRINT_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${SPRINT_STATUSES.join(', ')}` });
      }
      updates.status = status;
    }
    if (startDate !== undefined) updates.startDate = startDate || null;
    if (endDate !== undefined) updates.endDate = endDate || null;

    if (Object.keys(updates).length === 0) return res.json(scope.sprint);

    const { data, error } = await supabase
      .from('Sprint')
      .update(updates)
      .eq('id', scope.sprint.id)
      .select()
      .single();
    if (error) {
      if ((error as any).code === '23505') {
        return res.status(409).json({ error: 'A sprint with that name already exists in this release.' });
      }
      throw error;
    }
    res.json(data);
  } catch (err: any) {
    console.error('Error updating sprint:', err);
    res.status(500).json({ error: 'Failed to update sprint' });
  }
});

// DELETE /api/v1/sprints/:id
// Historical-QA safeguard: a sprint that already has executions cannot be
// deleted — close it instead. (ExecutionLog.sprintId is ON DELETE SET NULL, so
// the runs would survive regardless, but keeping the sprint keeps the trace
// intact.) An empty, never-run sprint can still be removed.
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const { count, error: cErr } = await supabase
      .from('ExecutionLog')
      .select('id', { count: 'exact', head: true })
      .eq('sprintId', scope.sprint.id);
    if (cErr) throw cErr;

    if ((count || 0) > 0) {
      return res.status(409).json({
        error: 'This sprint has execution history and cannot be deleted. Set its status to CLOSED instead.',
        executionCount: count,
      });
    }

    const { error } = await supabase.from('Sprint').delete().eq('id', scope.sprint.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting sprint:', err);
    res.status(500).json({ error: 'Failed to delete sprint' });
  }
});

// ── Phase 3 — Sprint ↔ Test Case assignment ───────────────────────────────
// Assignment lives entirely in SprintTestCase. A TestRun is never duplicated,
// mutated, or deleted here — the same TestRun can appear in many sprints and
// releases via many SprintTestCase rows.

/** All Sprint ids under a product (Sprint -> Release -> projectId). */
async function projectSprintIds(projectId: string): Promise<string[]> {
  // Sprint has exactly one FK to Release (releaseId), so this embed is
  // unambiguous — unlike an embed FROM SprintTestCase, which has two.
  const { data, error } = await supabase
    .from('Sprint')
    .select('id, release:Release!inner(projectId)')
    .eq('release.projectId', projectId);
  if (error) throw error;
  return (data || []).map((r: any) => r.id);
}

/**
 * Whether `testRunId` has ever been assigned to a sprint of this product
 * before `beforeIso`. Drives the derived NEW vs MANUAL classification without
 * making it authoritative — it is recomputable at any time from this query
 * (see the roadmap's "isNew is derived, not stored history" rule).
 */
async function hasEarlierAssignmentInProject(
  testRunId: string,
  projectId: string,
  beforeIso: string,
  knownSprintIds?: string[],
): Promise<boolean> {
  const sprintIds = knownSprintIds ?? (await projectSprintIds(projectId));
  if (sprintIds.length === 0) return false;
  const { data, error } = await supabase
    .from('SprintTestCase')
    .select('id')
    .eq('testRunId', testRunId)
    .in('sprintId', sprintIds)
    .lt('addedAt', beforeIso)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

// GET /api/v1/sprints/:id/test-cases — assignments + their TestRun definition
router.get('/:id/test-cases', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const { data, error } = await supabase
      .from('SprintTestCase')
      .select('*, testRun:TestRun(id, name, code, intent, suiteId, createdAt, updatedAt)')
      .eq('sprintId', scope.sprint.id)
      .order('addedAt', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error('Error listing sprint test cases:', err);
    res.status(500).json({ error: 'Failed to list sprint test cases' });
  }
});

// POST /api/v1/sprints/:id/test-cases
// { testRunIds: string[] }  — assign one or many existing TestRuns. Idempotent:
// a TestRun already assigned to this sprint is left as-is (not re-stamped).
router.post('/:id/test-cases', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const raw = req.body?.testRunIds ?? (req.body?.testRunId ? [req.body.testRunId] : []);
    const testRunIds: string[] = Array.isArray(raw) ? [...new Set(raw.filter(Boolean).map(String))] : [];
    if (testRunIds.length === 0) {
      return res.status(400).json({ error: 'testRunIds (non-empty array) is required.' });
    }

    // Every test case must belong to the same product as the sprint.
    for (const trId of testRunIds) {
      if (!(await isTestRunInProject(trId, scope.projectId))) {
        return res.status(400).json({ error: `Test case ${trId} does not exist in this product.` });
      }
    }

    // Which are already on this sprint → skip (idempotent).
    const { data: existing, error: exErr } = await supabase
      .from('SprintTestCase')
      .select('testRunId')
      .eq('sprintId', scope.sprint.id)
      .in('testRunId', testRunIds);
    if (exErr) throw exErr;
    const alreadyAssigned = new Set((existing || []).map((r: any) => r.testRunId));

    const now = new Date().toISOString();
    const productSprintIds = await projectSprintIds(scope.projectId);
    const toInsert: any[] = [];
    for (const trId of testRunIds) {
      if (alreadyAssigned.has(trId)) continue;
      const earlier = await hasEarlierAssignmentInProject(trId, scope.projectId, now, productSprintIds);
      toInsert.push({
        sprintId: scope.sprint.id,
        testRunId: trId,
        assignmentSource: earlier ? 'MANUAL' : 'NEW',
        carriedFromSprintId: null,
        addedAt: now,
        addedByUserId: req.user?.id || null,
      });
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('SprintTestCase').insert(toInsert);
      if (insErr) throw insErr;
    }

    const { data, error } = await supabase
      .from('SprintTestCase')
      .select('*, testRun:TestRun(id, name, code, intent, suiteId)')
      .eq('sprintId', scope.sprint.id)
      .order('addedAt', { ascending: true });
    if (error) throw error;
    res.status(201).json({
      assigned: toInsert.length,
      skipped: testRunIds.length - toInsert.length,
      assignments: data || [],
    });
  } catch (err: any) {
    console.error('Error assigning test cases:', err);
    res.status(500).json({ error: 'Failed to assign test cases' });
  }
});

// DELETE /api/v1/sprints/:id/test-cases/:testRunId — unassign (assignment only;
// the TestRun and every ExecutionLog are untouched)
router.delete('/:id/test-cases/:testRunId', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });
    const { error } = await supabase
      .from('SprintTestCase')
      .delete()
      .eq('sprintId', scope.sprint.id)
      .eq('testRunId', req.params.testRunId as string);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error unassigning test case:', err);
    res.status(500).json({ error: 'Failed to unassign test case' });
  }
});

// POST /api/v1/sprints/:id/carry-forward
// { fromSprintId }  — copy every assignment from an earlier sprint into this
// one as new CARRIED_FORWARD rows. Never mutates the source rows. Idempotent:
// test cases already on the target sprint are skipped.
router.post('/:id/carry-forward', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const fromSprintId = req.body?.fromSprintId;
    if (!fromSprintId) return res.status(400).json({ error: 'fromSprintId is required.' });
    if (fromSprintId === scope.sprint.id) {
      return res.status(400).json({ error: 'A sprint cannot carry forward from itself.' });
    }

    const source = await resolveSprintScope(req.user?.id, fromSprintId);
    if (!source) return res.status(404).json({ error: 'Source sprint not found.' });
    if (source.projectId !== scope.projectId) {
      return res.status(400).json({ error: 'Source sprint belongs to a different product.' });
    }

    const { data: sourceRows, error: srcErr } = await supabase
      .from('SprintTestCase')
      .select('testRunId')
      .eq('sprintId', source.sprint.id);
    if (srcErr) throw srcErr;
    const sourceTestRunIds = (sourceRows || []).map((r: any) => r.testRunId);
    if (sourceTestRunIds.length === 0) {
      return res.json({ carried: 0, skipped: 0, assignments: [] });
    }

    const { data: existing, error: exErr } = await supabase
      .from('SprintTestCase')
      .select('testRunId')
      .eq('sprintId', scope.sprint.id)
      .in('testRunId', sourceTestRunIds);
    if (exErr) throw exErr;
    const already = new Set((existing || []).map((r: any) => r.testRunId));

    const now = new Date().toISOString();
    const toInsert = sourceTestRunIds
      .filter((trId) => !already.has(trId))
      .map((trId) => ({
        sprintId: scope.sprint.id,
        testRunId: trId,
        assignmentSource: 'CARRIED_FORWARD',
        carriedFromSprintId: source.sprint.id,
        addedAt: now,
        addedByUserId: req.user?.id || null,
      }));

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('SprintTestCase').insert(toInsert);
      if (insErr) throw insErr;
    }

    const { data, error } = await supabase
      .from('SprintTestCase')
      .select('*, testRun:TestRun(id, name, code, intent, suiteId)')
      .eq('sprintId', scope.sprint.id)
      .order('addedAt', { ascending: true });
    if (error) throw error;
    res.json({
      carried: toInsert.length,
      skipped: sourceTestRunIds.length - toInsert.length,
      assignments: data || [],
    });
  } catch (err: any) {
    console.error('Error carrying forward test cases:', err);
    res.status(500).json({ error: 'Failed to carry forward test cases' });
  }
});

// ── Phase 6 — Sprint results ──────────────────────────────────────────────
// Read-time aggregation only. Raw ExecutionLog rows are never mutated; the
// coarse status buckets come from utils/traceabilityRollup.

// GET /api/v1/sprints/:id/results
router.get('/:id/results', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    // Assignments + their test-case definition.
    const { data: assignments, error: aErr } = await supabase
      .from('SprintTestCase')
      .select('testRunId, assignmentSource, carriedFromSprintId, addedAt, testRun:TestRun(id, name, code, intent, suiteId)')
      .eq('sprintId', scope.sprint.id)
      .order('addedAt', { ascending: true });
    if (aErr) throw aErr;

    // Every execution stamped for this sprint, grouped by testRunId in JS.
    const { data: execs, error: eErr } = await supabase
      .from('ExecutionLog')
      .select('id, status, browser, createdAt, testRunId, testName, targetUrl, durationMs, jiraTicketId')
      .eq('sprintId', scope.sprint.id)
      .order('createdAt', { ascending: false });
    if (eErr) throw eErr;

    const execByTestRun = new Map<string, ExecRowLite[]>();
    // Sprint-scoped runs NOT tied to an assigned test case — One-Click /
    // autonomous / Excel runs launched with this sprint selected. Surfaced
    // separately so they are visible on the sprint even with 0 assignments.
    const adHocRuns: any[] = [];
    for (const e of (execs || []) as any[]) {
      if (!e.testRunId) {
        adHocRuns.push({
          executionId: e.id,
          status: e.status,
          browser: e.browser,
          testName: e.testName,
          targetUrl: e.targetUrl,
          durationMs: e.durationMs,
          createdAt: e.createdAt,
          jiraTicketId: e.jiraTicketId,
          reportPath: `/app/execution/${e.id}/report`,
        });
        continue;
      }
      const list = execByTestRun.get(e.testRunId) || [];
      list.push({ id: e.id, status: e.status, browser: e.browser, createdAt: e.createdAt });
      execByTestRun.set(e.testRunId, list);
    }

    const adHocSummary = adHocRuns.reduce(
      (acc, r) => {
        const n = normalizeExecStatus(r.status);
        acc.total++;
        if (n === 'PASSED') acc.passed++;
        else if (n === 'FAILED') acc.failed++;
        else if (n === 'RUNNING') acc.running++;
        else acc.other++;
        return acc;
      },
      { total: 0, passed: 0, failed: 0, running: 0, other: 0 },
    );

    const counts = {
      assignedTestCount: (assignments || []).length,
      executedTestCount: 0,
      passedTestCount: 0,
      failedTestCount: 0,
      skippedTestCount: 0,
      notRunTestCount: 0,
      runningTestCount: 0,
      partialTestCount: 0,
    };

    const testCases = (assignments || []).map((a: any) => {
      const rows = execByTestRun.get(a.testRunId) || [];
      const agg = aggregateTestCaseStatus(rows);
      if (agg.status !== 'NOT_RUN') counts.executedTestCount++;
      const inc: Record<AggregatedStatus, () => void> = {
        PASSED: () => counts.passedTestCount++,
        FAILED: () => counts.failedTestCount++,
        SKIPPED: () => counts.skippedTestCount++,
        NOT_RUN: () => counts.notRunTestCount++,
        RUNNING: () => counts.runningTestCount++,
        PARTIAL: () => counts.partialTestCount++,
      };
      inc[agg.status]();
      return {
        testRunId: a.testRunId,
        code: a.testRun?.code ?? null,
        name: a.testRun?.name ?? null,
        intent: a.testRun?.intent ?? null,
        suiteId: a.testRun?.suiteId ?? null,
        assignmentSource: a.assignmentSource,
        carriedFromSprintId: a.carriedFromSprintId,
        addedAt: a.addedAt,
        aggregatedStatus: agg.status,
        lastExecutedAt: agg.lastExecutedAt,
        executionCount: agg.executionCount,
        latestExecutions: agg.latestByBrowser,
      };
    });

    res.json({
      sprint: {
        id: scope.sprint.id,
        name: scope.sprint.name,
        status: scope.sprint.status,
        sequence: scope.sprint.sequence,
        startDate: scope.sprint.startDate,
        endDate: scope.sprint.endDate,
      },
      release: {
        id: scope.release.id,
        name: scope.release.name,
        status: scope.release.status ?? 'PLANNED',
        projectId: scope.projectId,
      },
      ...counts,
      testCases,
      adHocSummary,
      adHocRuns,
    });
  } catch (err: any) {
    console.error('Error computing sprint results:', err);
    res.status(500).json({ error: 'Failed to compute sprint results' });
  }
});

// ── Phase 5 — Run a sprint ────────────────────────────────────────────────
// Launches an execution for each assigned TestRun (or a selected subset) by
// REUSING the existing "explicit steps" execution path: a child job carrying
// `steps` makes executionWorker skip AI generation and run the saved plan
// directly (the same branch One-Click uses when it posts explicit steps). No
// new execution engine, no change to the worker, BullMQ, or FlowProducer.
// Every ExecutionLog created here carries sprintId + releaseId + testRunId.

// POST /api/v1/sprints/:id/run   { testRunIds?: string[], browsers?: string[] }
router.post('/:id/run', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveSprintScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Sprint not found.' });

    const browsers: string[] =
      Array.isArray(req.body?.browsers) && req.body.browsers.length > 0
        ? req.body.browsers.map((b: string) => String(b).toLowerCase())
        : ['chromium'];

    // Assignments to run: the whole sprint, or an explicit subset of it.
    const { data: assignments, error: aErr } = await supabase
      .from('SprintTestCase')
      .select('testRunId, testRun:TestRun(id, name, steps, suiteId)')
      .eq('sprintId', scope.sprint.id);
    if (aErr) throw aErr;

    let toRun = (assignments || []) as any[];
    const subset: string[] | undefined = Array.isArray(req.body?.testRunIds) ? req.body.testRunIds.map(String) : undefined;
    if (subset && subset.length > 0) {
      const set = new Set(subset);
      toRun = toRun.filter((a) => set.has(a.testRunId));
      if (toRun.length === 0) {
        return res.status(400).json({ error: 'None of the supplied testRunIds are assigned to this sprint.' });
      }
    }
    if (toRun.length === 0) {
      return res.status(400).json({ error: 'This sprint has no assigned test cases to run.' });
    }

    const children: any[] = [];
    const executionIds: string[] = [];
    const skipped: { testRunId: string; reason: string }[] = [];

    for (const a of toRun) {
      const tr = a.testRun;
      let steps: any[] = [];
      try {
        steps = typeof tr?.steps === 'string' ? JSON.parse(tr.steps) : Array.isArray(tr?.steps) ? tr.steps : [];
      } catch {
        steps = [];
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        // No executable steps -> not run (distinct from skipped). No
        // ExecutionLog is created, so /results reports it as NOT_RUN.
        skipped.push({ testRunId: a.testRunId, reason: 'Test case has no steps' });
        continue;
      }

      const firstGoto = steps.find((s: any) => s && s.action === 'goto' && s.url);
      const targetUrl = firstGoto?.url || '';

      for (const browser of browsers) {
        const { data: execution, error: eErr } = await supabase
          .from('ExecutionLog')
          .insert({
            suiteId: tr.suiteId,
            status: 'QUEUED',
            browser,
            executionType: 'WEB',
            testName: tr.name,
            targetUrl: targetUrl || null,
            description: `Sprint run: ${scope.sprint.name}`,
            sprintId: scope.sprint.id,
            releaseId: scope.sprint.releaseId,
            testRunId: tr.id,
          })
          .select()
          .single();
        if (eErr) throw eErr;

        executionIds.push(execution.id);
        children.push({
          name: 'sprint-test',
          queueName: executionQueueName,
          data: {
            executionId: execution.id,
            testName: tr.name,
            targetUrl,
            browser,
            steps, // -> worker's explicit-steps branch, skips AI generation
          },
          opts: { jobId: execution.id, attempts: 1 },
        });
      }
    }

    if (children.length === 0) {
      return res.status(400).json({
        error: 'Nothing to run — every selected test case has no steps.',
        skipped,
      });
    }

    await flowProducer.add({
      name: 'cross-browser-suite',
      queueName: executionQueueName,
      data: { sprintId: scope.sprint.id, browsers },
      children,
    });

    res.status(202).json({
      message: 'Sprint run queued',
      sprintId: scope.sprint.id,
      releaseId: scope.sprint.releaseId,
      queued: executionIds.length,
      executionIds,
      skipped,
    });
  } catch (err: any) {
    console.error('Error running sprint:', err);
    res.status(500).json({ error: 'Failed to run sprint' });
  }
});

export default router;
