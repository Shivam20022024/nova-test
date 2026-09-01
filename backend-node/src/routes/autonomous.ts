import { Router } from 'express';
import { AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { executionQueue, flowProducer, executionQueueName } from '../queue/executionWorker';

const router = Router();

// POST /api/v1/autonomous/run
router.post('/run', async (req: AuthRequest, res) => {
  const { targetUrl, credentials, depth, features, projectId, mode, customScenario, rawScenario, browsers, enableAiEyes, antiBot } = req.body;

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
