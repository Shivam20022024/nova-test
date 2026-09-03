import { Router } from 'express';
import { AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { executionQueue, flowProducer, executionQueueName } from '../queue/executionWorker';
import { resolveRunTraceability, TraceabilityError } from '../utils/traceabilityScope';

const router = Router();

// POST /api/v1/autonomous/run
router.post('/run', async (req: AuthRequest, res) => {
  const { targetUrl, credentials, depth, features, projectId, mode, customScenario, rawScenario, browsers, enableAiEyes, antiBot } = req.body;

  // Optional Sprint/Release/TestCase context. Absent -> all null, behaviour
  // identical to today (this route has no auth middleware and none is added).
  // Present -> we resolve the caller's identity locally (bearer token or the
  // CI key), the SAME way middleware/auth.ts does, purely to ownership-check
  // the sprint/release. A run with no trace context never touches this.
  const sprintCtx = req.body?.sprintId ?? req.body?.sprint_id;
  const releaseCtx = req.body?.releaseId ?? req.body?.release_id;
  const testRunCtx = req.body?.testRunId ?? req.body?.test_run_id;

  let traceUserId: string | undefined;
  if (sprintCtx || releaseCtx || testRunCtx) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.CI_API_KEY) {
      traceUserId = 'ci-cd-runner';
    } else {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
      if (!token) {
        return res.status(401).json({ error: 'Authentication is required to attach sprint/release context to a run.' });
      }
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        return res.status(401).json({ error: 'Invalid authentication token.' });
      }
      traceUserId = data.user.id;
    }
  }

  let trace;
  try {
    trace = await resolveRunTraceability(traceUserId, {
      sprintId: sprintCtx,
      testRunId: testRunCtx,
      releaseId: releaseCtx,
    });
  } catch (e: any) {
    if (e instanceof TraceabilityError) return res.status(e.status).json({ error: e.message });
    throw e;
  }

  console.log("AUTONOMOUS TARGET:", targetUrl);

  if (!targetUrl || targetUrl.trim() === '') {
    return res.status(400).json({ error: 'Target URL is required for autonomous execution.' });
  }

  try {
    let activeProjectId = projectId;

    if (!activeProjectId) {
      const { data: defaultProject } = await supabase.from('Project').select('id').limit(1).maybeSingle();
      if (defaultProject) {
        activeProjectId = defaultProject.id;
      } else {
        return res.status(400).json({ error: 'No active project found in the system.' });
      }
    }

    // Double check if the project actually exists to prevent a dangling FK
    const { data: projectExists } = await supabase.from('Project').select('id').eq('id', activeProjectId).maybeSingle();
    if (!projectExists) {
      const { data: fallbackProject } = await supabase.from('Project').select('id').limit(1).maybeSingle();
      if (fallbackProject) {
        activeProjectId = fallbackProject.id;
      } else {
        return res.status(400).json({ error: 'Project ID is invalid and no fallback projects exist.' });
      }
    }

    const { data: suite, error: suiteErr } = await supabase
      .from('TestSuite')
      .insert({
        projectId: activeProjectId,
        name: `Autonomous Run: ${new URL(targetUrl).hostname}`,
        description: `Depth: ${depth}. Features: ${Object.keys(features).filter(k => features[k]).join(', ')}`,
      })
      .select()
      .single();
    if (suiteErr) throw suiteErr;
    const suiteId = suite.id;

    let browserList = browsers && browsers.length > 0 ? browsers : ['chromium'];
    const executionIds = [];
    const children = [];

    // Queue executions for each browser
    for (const browser of browserList) {
      const browserLower = browser.toLowerCase();
      const { data: execution, error: execErr } = await supabase
        .from('ExecutionLog')
        .insert({
          suiteId,
          status: 'QUEUED',
          durationMs: 0,
          browser: browserLower,
          testName: `Auto-QA [${browserLower}]`,
          targetUrl,
          description: rawScenario || 'Full autonomous exploration (no custom scenario provided)',
          ...(trace.releaseId ? { releaseId: trace.releaseId } : {}),
          ...(trace.sprintId ? { sprintId: trace.sprintId } : {}),
          ...(trace.testRunId ? { testRunId: trace.testRunId } : {}),
        })
        .select()
        .single();
      if (execErr) throw execErr;

      children.push({
        name: 'autonomous-test',
        queueName: executionQueueName,
        data: {
          executionId: execution.id,
          testName: `Auto-QA [${browserLower}]`,
          targetUrl,
          credentials,
          depth,
          features,
          browser: browserLower,
          mode: mode || 'full_autonomous',
          isAutonomous: true,
          customScenario,
          enableAiEyes,
          antiBot
        },
        opts: {
          jobId: execution.id,
          attempts: 1
        }
      });

      executionIds.push(execution.id);
    }

    const parentJob = await flowProducer.add({
      name: 'cross-browser-suite',
      queueName: executionQueueName,
      data: {
        targetUrl,
        browsers: browserList
      },
      children: children
    });

    res.json({ message: 'Autonomous QA pipeline triggered', executionIds });
  } catch (err: any) {
    console.error("[Autonomous] Failed to trigger pipeline:", err);
    res.status(500).json({ error: 'Failed to trigger pipeline' });
  }
});

export default router;
