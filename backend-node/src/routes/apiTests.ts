import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { isProjectOwned } from '../utils/traceabilityScope';
import { apiDbTestQueue } from '../queue/apiDbTestWorker';

/**
 * API Testing — run/list/view. Deliberately its own router, its own table
 * (ApiExecution), and its own queue (see queue/apiDbTestWorker.ts) rather
 * than reusing the existing (but web-testing-coupled) run-api-test route in
 * executions.ts — see the plan this was built from for why. Test authoring
 * (NL generation, spec import) reuses the already-mounted, already-working
 * /api/v1/ai/generate-api-suite / import-api-spec / generate-api-suite-from-spec
 * routes unchanged.
 */
const router = Router();
router.use(authenticate);

// GET /api/v1/api-tests?projectId=...
router.get('/', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
    if (!(await isProjectOwned(req.user?.id, projectId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const { data, error } = await supabase
      .from('ApiExecution')
      .select('id, name, status, "startedAt", "completedAt", "durationMs", "createdAt", "releaseId", "sprintId"')
      .eq('projectId', projectId)
      .order('createdAt', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error('Error listing API executions:', err);
    res.status(500).json({ error: 'Failed to list API test executions' });
  }
});

// GET /api/v1/api-tests/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { data, error } = await supabase.from('ApiExecution').select('*').eq('id', req.params.id as string).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Execution not found' });
    if (!(await isProjectOwned(req.user?.id, data.projectId))) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching API execution:', err);
    res.status(500).json({ error: 'Failed to fetch API test execution' });
  }
});

// POST /api/v1/api-tests/run
// { projectId, name, steps: ApiStep[], variables?, releaseId?, sprintId? }
router.post('/run', async (req: AuthRequest, res) => {
  try {
    const { projectId, name, steps, variables, releaseId, sprintId } = req.body || {};
    if (!projectId || !name || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'projectId, name and a non-empty steps array are required.' });
    }
    if (!(await isProjectOwned(req.user?.id, projectId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const { data: execution, error } = await supabase
      .from('ApiExecution')
      .insert({
        projectId,
        releaseId: releaseId || null,
        sprintId: sprintId || null,
        name,
        steps,
        variables: variables || null,
        status: 'QUEUED',
        createdBy: req.user?.id || null,
      })
      .select()
      .single();
    if (error) throw error;

    await apiDbTestQueue.add('run-api-test', {
      kind: 'API',
      executionId: execution.id,
      steps,
      variables,
    }, { jobId: execution.id });

    res.status(202).json({ executionId: execution.id });
  } catch (err: any) {
    console.error('Error queuing API test run:', err);
    res.status(500).json({ error: 'Failed to queue API test run' });
  }
});

export default router;
