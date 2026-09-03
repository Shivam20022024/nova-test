import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { isProjectOwned } from '../utils/traceabilityScope';
import {
  aggregateTestCaseStatus,
  buildTestCaseTimeline,
  detectRegression,
  ExecRowLite,
  ReleaseMeta,
  SprintMeta,
} from '../utils/traceabilityRollup';

const router = Router();

router.use(authenticate);

// GET /api/v1/projects
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const { data, error } = await supabase
      .from('Project')
      .select('*')
      .eq('userId', userId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching projects:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// POST /api/v1/projects
router.post('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const { name, description } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Project name is required' });
      return;
    }

    // Mirrors Prisma's connectOrCreate: ensure the user row exists before the
    // project's foreign key can point at it.
    const { error: userError } = await supabase.from('User').upsert(
      {
        id: userId,
        email: req.user?.email || 'unknown@example.com',
        name: req.user?.user_metadata?.full_name || 'Unknown',
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (userError) throw userError;

    const { data: project, error } = await supabase
      .from('Project')
      .insert({ name, description, userId })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json(project);
  } catch (err: any) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PATCH /api/v1/projects/:id
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id as string;
    const { name, description } = req.body;

    const { data: existing, error: findError } = await supabase
      .from('Project')
      .select('id')
      .eq('id', projectId)
      .eq('userId', userId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    if (name !== undefined && !name.trim()) {
      res.status(400).json({ error: 'Project name cannot be empty' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    const { data: project, error } = await supabase
      .from('Project')
      .update(updates)
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;

    res.json(project);
  } catch (err: any) {
    console.error('Error updating project:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/v1/projects/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id as string;

    const { data: existing, error: findError } = await supabase
      .from('Project')
      .select('id')
      .eq('id', projectId)
      .eq('userId', userId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Every child table (TestSuite, DiscoveredFlow, JiraIntegration,
    // DbConnection) has ON DELETE CASCADE, so this alone removes the
    // project's full tree — same behaviour Prisma's relation cascade gave us.
    const { error } = await supabase.from('Project').delete().eq('id', projectId);
    if (error) throw error;

    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// GET /api/v1/projects/:id/suites
router.get('/:id/suites', async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id as string;
    const { data, error } = await supabase
      .from('TestSuite')
      .select('*')
      .eq('projectId', projectId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching project suites:', err);
    res.status(500).json({ error: 'Failed to fetch project suites' });
  }
});

// POST /api/v1/projects/:id/suites
router.post('/:id/suites', async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id as string;
    const { name, description, type } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Suite name is required' });
      return;
    }

    const { data: suite, error } = await supabase
      .from('TestSuite')
      .insert({
        name,
        description: description || null,
        type: type === 'API' ? 'API' : 'WEB',
        projectId,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json(suite);
  } catch (err: any) {
    console.error('Error creating suite:', err);
    res.status(500).json({
      error: 'Failed to create suite: ' + err.message,
      stack: err.stack,
    });
  }
});

// ── Phase 8 — Product traceability ────────────────────────────────────────
// Read-only, summary-oriented: Project → Releases → Sprints with rolled-up
// pass/fail/not-run + new/carried assignment counts + a regression count.
// Never returns stepLogs / planData / traceData blobs.
//
// GET /api/v1/projects/:id/traceability
router.get('/:id/traceability', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id as string;

    // Traceability reads share the isProjectOwned semantics used by the other
    // new traceability endpoints (owner, or the CI operator). The project CRUD
    // routes above keep their stricter owner-only `.eq('userId')` check.
    if (!(await isProjectOwned(userId, projectId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    const { data: project, error: pErr } = await supabase
      .from('Project')
      .select('id, name')
      .eq('id', projectId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const { data: releases, error: rErr } = await supabase
      .from('Release')
      .select('id, name, description, status, sequence, startDate, endDate, createdAt')
      .eq('projectId', projectId)
      .order('sequence', { ascending: true, nullsFirst: false })
      .order('createdAt', { ascending: true });
    if (rErr) throw rErr;

    const releaseIds = (releases || []).map((r: any) => r.id);
    if (releaseIds.length === 0) {
      return res.json({ project, releaseCount: 0, releases: [] });
    }

    const { data: sprints, error: sErr } = await supabase
      .from('Sprint')
      .select('id, name, sequence, status, startDate, endDate, createdAt, releaseId')
      .in('releaseId', releaseIds)
      .order('sequence', { ascending: true, nullsFirst: false })
      .order('createdAt', { ascending: true });
    if (sErr) throw sErr;
    const sprintIds = (sprints || []).map((s: any) => s.id);

    // Assignments (for counts + new/carried) and executions (for status).
    const [{ data: assignments, error: aErr }, { data: execs, error: eErr }] = await Promise.all([
      sprintIds.length
        ? supabase.from('SprintTestCase').select('sprintId, testRunId, assignmentSource').in('sprintId', sprintIds)
        : Promise.resolve({ data: [], error: null } as any),
      sprintIds.length
        ? supabase
            .from('ExecutionLog')
            .select('id, status, browser, createdAt, sprintId, releaseId, testRunId')
            .in('sprintId', sprintIds)
        : Promise.resolve({ data: [], error: null } as any),
    ]);
    if (aErr) throw aErr;
    if (eErr) throw eErr;

    // (sprintId|testRunId) -> exec rows, for per-assignment aggregation.
    const execByPair = new Map<string, ExecRowLite[]>();
    // testRunId -> all project exec rows, for the regression timeline.
    const execByTestRun = new Map<string, (ExecRowLite & { sprintId: string | null })[]>();
    for (const e of (execs || []) as any[]) {
      if (!e.testRunId) continue;
      const lite: ExecRowLite = { id: e.id, status: e.status, browser: e.browser, createdAt: e.createdAt };
      if (e.sprintId) {
        const k = `${e.sprintId}|${e.testRunId}`;
        (execByPair.get(k) || execByPair.set(k, []).get(k))!.push(lite);
      }
      (execByTestRun.get(e.testRunId) || execByTestRun.set(e.testRunId, []).get(e.testRunId))!.push({
        ...lite,
        sprintId: e.sprintId,
      });
    }

    const sprintsById = new Map<string, SprintMeta>(
      (sprints || []).map((s: any) => [s.id, s as SprintMeta]),
    );
    const releasesById = new Map<string, ReleaseMeta>(
      (releases || []).map((r: any) => [r.id, r as ReleaseMeta]),
    );

    // Regression scan across the whole product: attribute each first PASS→FAIL
    // to the sprint that introduced it.
    const regressionBySprint = new Map<string, number>();
    for (const [, rows] of execByTestRun) {
      const timeline = buildTestCaseTimeline(rows, sprintsById, releasesById);
      const reg = detectRegression(timeline);
      if ((reg.status === 'REGRESSED' || reg.status === 'RECOVERED') && reg.regressionIntroducedAt) {
        const sid = reg.regressionIntroducedAt.sprintId;
        regressionBySprint.set(sid, (regressionBySprint.get(sid) || 0) + 1);
      }
    }

    const assignmentsBySprint = new Map<string, any[]>();
    for (const a of (assignments || []) as any[]) {
      (assignmentsBySprint.get(a.sprintId) || assignmentsBySprint.set(a.sprintId, []).get(a.sprintId))!.push(a);
    }

    const summariseSprint = (sprint: any) => {
      const rows = assignmentsBySprint.get(sprint.id) || [];
      const counts = { assigned: rows.length, passed: 0, failed: 0, partial: 0, running: 0, skipped: 0, notRun: 0, new: 0, carried: 0 };
      for (const a of rows) {
        if (a.assignmentSource === 'NEW') counts.new++;
        else if (a.assignmentSource === 'CARRIED_FORWARD') counts.carried++;
        const agg = aggregateTestCaseStatus(execByPair.get(`${sprint.id}|${a.testRunId}`) || []);
        ({
          PASSED: () => counts.passed++,
          FAILED: () => counts.failed++,
          PARTIAL: () => counts.partial++,
          RUNNING: () => counts.running++,
          SKIPPED: () => counts.skipped++,
          NOT_RUN: () => counts.notRun++,
        })[agg.status]();
      }
      return {
        id: sprint.id,
        name: sprint.name,
        status: sprint.status,
        sequence: sprint.sequence,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        regressionCount: regressionBySprint.get(sprint.id) || 0,
        ...counts,
      };
    };

    const out = (releases || []).map((rel: any) => {
      const relSprints = (sprints || []).filter((s: any) => s.releaseId === rel.id).map(summariseSprint);
      const rollup = relSprints.reduce(
        (acc, s) => {
          acc.assigned += s.assigned; acc.passed += s.passed; acc.failed += s.failed;
          acc.notRun += s.notRun; acc.regressionCount += s.regressionCount;
          acc.new += s.new; acc.carried += s.carried;
          return acc;
        },
        { assigned: 0, passed: 0, failed: 0, notRun: 0, regressionCount: 0, new: 0, carried: 0 },
      );
      return {
        id: rel.id,
        name: rel.name,
        status: rel.status ?? 'PLANNED',
        sequence: rel.sequence,
        startDate: rel.startDate,
        endDate: rel.endDate,
        sprintCount: relSprints.length,
        totals: rollup,
        sprints: relSprints,
      };
    });

    res.json({ project, releaseCount: out.length, releases: out });
  } catch (err: any) {
    console.error('Error building project traceability:', err);
    res.status(500).json({ error: 'Failed to build project traceability' });
  }
});

export default router;
