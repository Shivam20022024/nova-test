import { Router } from 'express';
import { executionQueue, flowProducer, executionQueueName } from '../queue/executionWorker';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { ExcelBatchProcessor } from '../orchestrator/excelBatchProcessor';
import redisConnection from '../lib/redis';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();
router.use(authenticate);

// GET /api/v1/executions
router.get('/', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;

    let query = projectId
      ? supabase.from('ExecutionLog').select('*, suite:TestSuite!inner(*, project:Project!inner(*))').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('*, suite:TestSuite(*, project:Project(*))');

    const { data: executions, error } = await query
      .order('createdAt', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json(executions);
  } catch (err: any) {
    console.error('Error fetching executions:', err);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// GET /api/v1/executions/schema-baselines?suiteId=...
// Lists recorded API contract baselines for a suite — the shape every
// endpoint is currently being diffed against for schema-drift detection.
// Registered before the /:id catch-all so "schema-baselines" is never
// matched as an execution id.
router.get('/schema-baselines', async (req: AuthRequest, res) => {
  try {
    const suiteId = req.query.suiteId as string;
    if (!suiteId) return res.status(400).json({ error: 'Missing suiteId' });

    const { data: baselines, error } = await supabase
      .from('ApiSchemaBaseline')
      .select('*')
      .eq('suiteId', suiteId)
      .order('updatedAt', { ascending: false });
    if (error) throw error;

    res.json(baselines);
  } catch (err: any) {
    console.error('Error fetching schema baselines:', err);
    res.status(500).json({ error: 'Failed to fetch schema baselines' });
  }
});

// DELETE /api/v1/executions/schema-baselines/:id
// Resets a single endpoint's baseline — the next successful response for
// that (method, url) becomes the new accepted shape. Use after an
// intentional, reviewed API change so future runs stop flagging it as drift.
router.delete('/schema-baselines/:id', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const { error } = await supabase.from('ApiSchemaBaseline').delete().eq('id', id);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting schema baseline:', err);
    res.status(500).json({ error: 'Failed to delete schema baseline' });
  }
});

// GET /api/v1/executions/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .select('*, screenshots:Screenshot(*), videos:Video(*), reports:Report(*), healingEvents:HealingEvent(*)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!execution) return res.status(404).json({ error: 'Not found' });

    if (['QUEUED', 'RUNNING'].includes(execution.status)) {
      return res.json({
        id: execution.id,
        status: execution.status,
        message: 'Execution is waiting in worker queue or running',
        suiteId: execution.suiteId,
        createdAt: execution.createdAt,
        stepLogs: [],
        videos: [],
        screenshots: [],
        reports: [],
      });
    }

    let safeStepLogs = [];
    try {
      if (Array.isArray(execution.stepLogs)) {
        safeStepLogs = execution.stepLogs;
      } else if (typeof execution.stepLogs === "string") {
        const parsed = JSON.parse(execution.stepLogs);
        safeStepLogs = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      safeStepLogs = [];
    }

    res.json({
      ...execution,
      stepLogs: safeStepLogs,
      videos: execution.videos || [],
      screenshots: execution.screenshots || [],
      reports: execution.reports || [],
    });
  } catch (err: any) {
    console.error('Error fetching execution details:', err);
    res.status(500).json({ error: 'Failed to fetch execution details' });
  }
});

// GET /api/v1/executions/:id/trace
router.get('/:id/trace', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    console.log(`TRACE_ENDPOINT_HIT ${id}`);
    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .select('*, screenshots:Screenshot(*), videos:Video(*)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!execution) return res.status(404).json({ error: 'Not found' });

    let traceData = [];
    if (execution.traceData) {
      try { traceData = JSON.parse(execution.traceData); } catch(e) {}
    } else if (execution.stepLogs) {
      try { traceData = JSON.parse(execution.stepLogs); } catch(e) {}
    }

    res.json({
      id: execution.id,
      status: execution.status,
      traceEvents: Array.isArray(traceData) ? traceData : [],
      screenshots: execution.screenshots || [],
      videos: execution.videos || []
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch trace' });
  }
});

// GET /api/v1/executions/:id/plan
router.get('/:id/plan', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    console.log(`PLAN_ENDPOINT_HIT ${id}`);
    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!execution) return res.status(404).json({ error: 'Not found' });

    let planData = null;
    if (execution.planData) {
      try { planData = JSON.parse(execution.planData); } catch(e) {}
    }

    res.json({
      id: execution.id,
      plan: planData || {}
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch execution plan' });
  }
});

// POST /api/v1/executions/run
router.post('/run', async (req: AuthRequest, res) => {
  const { testName, suiteId, targetUrl, instruction, browser } = req.body;

  try {
    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .insert({ suiteId, status: 'QUEUED', browser: browser || 'chromium' })
      .select()
      .single();
    if (error) throw error;

    const job = await executionQueue.add('run-test', {
      executionId: execution.id,
      testName,
      targetUrl,
      instruction,
      browser
    }, {
      jobId: execution.id,
      attempts: 1
    });

    res.json({ message: 'Execution queued successfully', executionId: execution.id, jobId: job.id });
  } catch (err: any) {
    console.error('Error queueing execution:', err);
    res.status(500).json({ error: 'Failed to queue execution' });
  }
});

// POST /api/v1/executions/run-excel
router.post('/run-excel', upload.single('file'), async (req: AuthRequest, res) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const processor = new ExcelBatchProcessor();
    const { testcases, detectedUrl } = processor.parseExcel(file.buffer);

    // Convert to the expected format
    const formattedTestcases = testcases.map((tc, idx) => ({
      id: `tc-${idx}`,
      name: tc.scenario ? tc.scenario : `Excel Scenario ${idx + 1}`,
      steps: tc.steps,
      testData: tc.testData,
      expectedResult: tc.expectedResult,
      targetUrl: tc.targetUrl
    }));

    if (req.user && req.user.id) {
       await redisConnection.set(`excel_testcases:${req.user.id}`, JSON.stringify(formattedTestcases), 'EX', 3600);
       await redisConnection.set(`excel_filename:${req.user.id}`, file.originalname || 'Excel Import', 'EX', 3600);
    }

    res.json({
      success: true,
      count: formattedTestcases.length,
      testcases: formattedTestcases,
      detectedUrl: detectedUrl || null
    });
  } catch (err: any) {
    console.error('Error parsing excel:', err);
    res.status(500).json({ error: 'Failed to parse Excel file' });
  }
});

// POST /api/v1/executions/run-multi-test
router.post('/run-multi-test', async (req: AuthRequest, res) => {
  const { test_name, base_url, steps, browsers, devices, project_id, suite_id, excel_testcase_ids, antiBot } = req.body;

  if (excel_testcase_ids && excel_testcase_ids.length > 0) {
     console.log('EXCEL_EXECUTION_REQUEST', req.body);
  } else {
     console.log('PARALLEL_RUN_REQUEST', req.body);
  }

  if (!browsers || browsers.length === 0) {
    return res.status(400).json({ error: 'Browsers are required' });
  }

  try {
    const children = [];
    const executionIds = [];

    let validSuiteId = suite_id;
    if (!validSuiteId && project_id) {
      let { data: suite, error: suiteErr } = await supabase
        .from('TestSuite')
        .select('*')
        .eq('projectId', project_id)
        .limit(1)
        .maybeSingle();
      if (suiteErr) throw suiteErr;
      if (!suite) {
        const { data: created, error: createErr } = await supabase
          .from('TestSuite')
          .insert({ name: 'Default Suite', projectId: project_id })
          .select()
          .single();
        if (createErr) throw createErr;
        suite = created;
      }
      validSuiteId = suite.id;
    } else if (!validSuiteId) {
      // Fallback
      const { data: suite, error: suiteErr } = await supabase.from('TestSuite').select('*').limit(1).maybeSingle();
      if (suiteErr) throw suiteErr;
      if (!suite) return res.status(400).json({ error: 'No suite found' });
      validSuiteId = suite.id;
    }

    let executionCases: any[] = [];
    if (excel_testcase_ids && excel_testcase_ids.length > 0 && req.user?.id) {
       const cached = await redisConnection.get(`excel_testcases:${req.user.id}`);
       if (cached) {
         const allTestcases = JSON.parse(cached);
         executionCases = allTestcases.filter((tc: any) => excel_testcase_ids.includes(tc.id));
       }
    }

    let isExcelBatch = false;
    if (executionCases.length === 0) {
      executionCases = [{ id: 'tc-prompt', name: test_name, steps: steps, targetUrl: base_url, isPrompt: true }];
    } else {
      isExcelBatch = true;
      for (const tc of executionCases) {
         if (!tc.isPrompt) {
            const resolvedTargetUrl = base_url || tc.targetUrl;
            if (!resolvedTargetUrl) {
               return res.status(400).json({ error: 'Target URL is required for Excel execution.' });
            }
            console.log(`EXCEL_TARGET_URL_RESOLVED source=${base_url ? 'UI' : 'EXCEL'} targetUrl=${resolvedTargetUrl}`);
         }
      }
    }

    // Every ExecutionLog created from this single Excel batch shares one
    // batch id + the uploaded file's name, so the dashboard can collapse
    // them into a single folder instead of listing each scenario alone.
    let excelBatchId: string | null = null;
    let excelBatchName: string | null = null;
    if (isExcelBatch) {
      excelBatchId = randomUUID();
      excelBatchName = 'Excel Import';
      if (req.user?.id) {
        const cachedName = await redisConnection.get(`excel_filename:${req.user.id}`);
        if (cachedName) excelBatchName = cachedName;
      }
    }

    for (const browser of browsers) {
      const browserLower = browser.toLowerCase();

      for (const tc of executionCases) {
        const isExcelCase = !tc.isPrompt;
        const { data: execution, error: execErr } = await supabase
          .from('ExecutionLog')
          .insert({
            suiteId: validSuiteId,
            status: 'QUEUED',
            browser: browserLower,
            testName: isExcelCase ? tc.name : test_name,
            targetUrl: isExcelCase ? (base_url || tc.targetUrl) : base_url,
            description: isExcelCase ? tc.name : (steps ? JSON.stringify(steps) : null),
            excelBatchId: isExcelCase ? excelBatchId : null,
            excelBatchName: isExcelCase ? excelBatchName : null,
          })
          .select()
          .single();
        if (execErr) throw execErr;

        const isExcel = !tc.isPrompt;
        children.push({
          name: isExcel ? 'run-excel-test' : 'run-multi-test',
          queueName: executionQueueName,
          data: {
            executionId: execution.id,
            testName: isExcel ? tc.name : `${test_name} (${browser})`,
            targetUrl: isExcel ? (base_url || tc.targetUrl) : base_url,
            browser: browserLower,
            isAutonomous: !isExcel,
            customScenario: isExcel ? undefined : tc.steps,
            steps: isExcel ? tc.steps : undefined,
            mode: isExcel ? 'EXCEL' : undefined,
            testCases: isExcel ? [tc] : undefined,
            antiBot
          },
        opts: {
          jobId: execution.id,
          attempts: 1
        }
      });

      console.log(`QUEUE_JOB_CREATED: child job for execution ${execution.id}`);
      executionIds.push(execution.id);
      } // End of tc loop
    } // End of browser loop

    const parentJob = await flowProducer.add({
      name: 'cross-browser-suite',
      queueName: executionQueueName,
      data: {
        testName: test_name,
        browsers: browsers
      },
      children: children
    });

    console.log(`FLOW_PRODUCER_PARENT_CREATED: parent job ${parentJob.job.id}`);

    res.json({ message: 'Multi-test queued successfully via FlowProducer', executionIds, jobs: children.map(c => c.opts.jobId) });
  } catch (err: any) {
    console.error('Error queueing multi-test:', err);
    res.status(500).json({ error: 'Failed to queue multi-test executions' });
  }
});

// POST /api/v1/executions/run-api-test
// Dedicated route for API/HTTP test execution — deliberately separate from
// run-multi-test so the browsers-required validation there is never touched.
router.post('/run-api-test', async (req: AuthRequest, res) => {
  const { test_name, project_id, suite_id, steps, environment, variables } = req.body;

  if (!steps) {
    return res.status(400).json({ error: 'steps (HTTP request definitions) are required' });
  }

  try {
    let validSuiteId = suite_id;
    if (!validSuiteId && project_id) {
      let { data: suite, error: suiteErr } = await supabase
        .from('TestSuite')
        .select('*')
        .eq('projectId', project_id)
        .eq('type', 'API')
        .limit(1)
        .maybeSingle();
      if (suiteErr) throw suiteErr;
      if (!suite) {
        const { data: created, error: createErr } = await supabase
          .from('TestSuite')
          .insert({ name: 'Default API Suite', projectId: project_id, type: 'API' })
          .select()
          .single();
        if (createErr) throw createErr;
        suite = created;
      }
      validSuiteId = suite.id;
    } else if (!validSuiteId) {
      return res.status(400).json({ error: 'suite_id or project_id is required' });
    }

    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .insert({
        suiteId: validSuiteId,
        status: 'QUEUED',
        browser: 'N/A',
        executionType: 'API',
        testName: test_name || 'API Test',
        targetUrl: null,
        description: typeof steps === 'string' ? steps : JSON.stringify(steps),
      })
      .select()
      .single();
    if (error) throw error;

    const job = await executionQueue.add('run-api-test', {
      executionId: execution.id,
      testName: test_name || 'API Test',
      mode: 'API',
      browser: 'N/A',
      steps: typeof steps === 'string' ? steps : JSON.stringify(steps),
      isAutonomous: false,
      environment: environment || 'Local',
      variables: variables && typeof variables === 'object' ? variables : undefined,
    }, {
      jobId: execution.id,
      attempts: 1
    });

    console.log(`QUEUE_JOB_CREATED: API test job for execution ${execution.id}`);

    res.json({ message: 'API test queued successfully', executionIds: [execution.id], jobId: job.id });
  } catch (err: any) {
    console.error('Error queueing API test:', err);
    res.status(500).json({ error: 'Failed to queue API test execution' });
  }
});

// POST /api/v1/executions/:id/cancel
router.post('/:id/cancel', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;

    // Attempt to remove job from queue if it hasn't started yet
    // BullMQ requires jobId to remove it. We don't store jobId in ExecutionLog currently.
    // Instead we can fetch active/waiting jobs and find by executionId
    const jobs = await executionQueue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    for (const job of jobs) {
      if (job.data.executionId === id) {
        await job.remove().catch(() => {});
      }
    }

    // Update execution state to CANCELLED
    const { error } = await supabase
      .from('ExecutionLog')
      .update({ status: 'CANCELLED', logs: 'Execution cancelled by user' })
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Execution cancelled successfully' });
  } catch (err: any) {
    console.error('Error cancelling execution:', err);
    res.status(500).json({ error: 'Failed to cancel execution' });
  }
});

// GET /api/v1/executions/:id/video
router.get('/:id/video', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const { data: execution, error } = await supabase
      .from('ExecutionLog')
      .select('*, videos:Video(*)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!execution) return res.status(404).json({ error: 'Not found' });

    if (!execution.videos || execution.videos.length === 0) {
      console.log(`VIDEO_ARTIFACT_NOT_FOUND for execution ${id}`);
      return res.status(404).json({ error: 'VIDEO_ARTIFACT_NOT_FOUND' });
    }

    const video = execution.videos[0];
    if (!video) {
      console.log(`VIDEO_ARTIFACT_NOT_FOUND for execution ${id}`);
      return res.status(404).json({ error: 'VIDEO_ARTIFACT_NOT_FOUND' });
    }

    res.json({ url: video.url, storagePath: video.storagePath });
  } catch (err: any) {
    console.error('Error fetching video:', err);
    res.status(500).json({ error: 'Failed to fetch video artifact' });
  }
});

export default router;
