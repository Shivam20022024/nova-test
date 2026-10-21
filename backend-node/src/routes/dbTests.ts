import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { isProjectOwned } from '../utils/traceabilityScope';
import { apiDbTestQueue } from '../queue/apiDbTestWorker';

/**
 * Database Testing — run/list/view. Same isolation rationale as apiTests.ts:
 * its own table (DbTestExecution) and its own queue (queue/apiDbTestWorker.ts),
 * nothing shared with Web Testing's execution path. Connection management
 * reuses the already-written routes/dbConnections.ts unchanged (mounted
 * alongside this router in app.ts). Test authoring (NL generation,
 * schema-aware generation, test-data generation) reuses the already-mounted
 * /api/v1/ai/generate-db-suite / generate-db-suite-from-schema /
 * generate-db-test-data routes unchanged.
 */
const router = Router();
router.use(authenticate);

// GET /api/v1/db-tests?projectId=...
router.get('/', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
    if (!(await isProjectOwned(req.user?.id, projectId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const { data, error } = await supabase
      .from('DbTestExecution')
      .select('id, name, status, "connectionId", "startedAt", "completedAt", "durationMs", "createdAt", "releaseId", "sprintId"')
      .eq('projectId', projectId)
      .order('createdAt', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error('Error listing DB test executions:', err);
    res.status(500).json({ error: 'Failed to list database test executions' });
  }
});

// GET /api/v1/db-tests/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { data, error } = await supabase.from('DbTestExecution').select('*').eq('id', req.params.id as string).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Execution not found' });
    if (!(await isProjectOwned(req.user?.id, data.projectId))) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching DB test execution:', err);
    res.status(500).json({ error: 'Failed to fetch database test execution' });
  }
});

// POST /api/v1/db-tests/run
// { projectId, name, connectionId, steps: DbStep[], variables?, releaseId?, sprintId? }
router.post('/run', async (req: AuthRequest, res) => {
  try {
    const { projectId, name, connectionId, steps, variables, releaseId, sprintId } = req.body || {};
    if (!projectId || !name || !connectionId || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'projectId, name, connectionId and a non-empty steps array are required.' });
    }
    if (!(await isProjectOwned(req.user?.id, projectId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const { data: connection } = await supabase.from('DbConnection').select('id').eq('id', connectionId).maybeSingle();
    if (!connection) return res.status(404).json({ error: 'Database connection not found.' });

    // DbExecutionAgent reads step.connectionId per step, so every step must
    // carry it — this keeps the agent's contract (shared with the original,
    // now-superseded run-db-test design in NOVATEST) unchanged.
    const stampedSteps = steps.map((s: any) => ({ ...s, connectionId }));

    const { data: execution, error } = await supabase
      .from('DbTestExecution')
      .insert({
        projectId,
        releaseId: releaseId || null,
        sprintId: sprintId || null,
        connectionId,
        name,
        steps: stampedSteps,
        variables: variables || null,
        status: 'QUEUED',
        createdBy: req.user?.id || null,
      })
      .select()
      .single();
    if (error) throw error;

    await apiDbTestQueue.add('run-db-test', {
      kind: 'DB',
      executionId: execution.id,
      steps: stampedSteps,
      variables,
    }, { jobId: execution.id });

    res.status(202).json({ executionId: execution.id });
  } catch (err: any) {
    console.error('Error queuing DB test run:', err);
    res.status(500).json({ error: 'Failed to queue database test run' });
  }
});

export default router;
