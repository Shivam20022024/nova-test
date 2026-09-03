import { Router } from 'express';
import axios from 'axios';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';
import { JiraService } from '../services/JiraService';

const router = Router();
router.use(authenticate);

// GET /api/v1/jira/config
router.get('/config', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    const { data: integration, error } = await supabase
      .from('JiraIntegration')
      .select('*')
      .eq('projectId', projectId)
      .maybeSingle();
    if (error) throw error;

    if (!integration) {
      return res.json(null);
    }

    // Mask API token
    res.json({
      ...integration,
      apiToken: '********'
    });
  } catch (err: any) {
    console.error('[JiraRoute] Failed to fetch config:', err);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// POST /api/v1/jira/save
router.post('/save', async (req: AuthRequest, res) => {
  try {
    const { projectId, baseUrl, email, apiToken, projectKey, issueType, isActive } = req.body;
    if (!projectId || !baseUrl || !email || !projectKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: existing, error: findErr } = await supabase
      .from('JiraIntegration')
      .select('*')
      .eq('projectId', projectId)
      .maybeSingle();
    if (findErr) throw findErr;

    let tokenToSave = apiToken;
    if (existing && (apiToken === '********' || !apiToken)) {
      tokenToSave = existing.apiToken;
    }

    const payload = {
      baseUrl,
      email,
      apiToken: tokenToSave,
      projectKey,
      issueType: issueType || 'Bug',
      isActive: isActive !== undefined ? isActive : true
    };

    if (existing) {
      const { error: updateErr } = await supabase.from('JiraIntegration').update(payload).eq('projectId', projectId);
      if (updateErr) throw updateErr;
    } else {
      const { error: createErr } = await supabase.from('JiraIntegration').insert({ projectId, ...payload });
      if (createErr) throw createErr;
    }

    res.json({ message: 'Saved successfully' });
  } catch (err: any) {
    console.error('[JiraRoute] Failed to save config:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// POST /api/v1/jira/test
router.post('/test', async (req: AuthRequest, res) => {
  try {
    const { projectId, baseUrl, email, apiToken, projectKey } = req.body;

    let actualToken = apiToken;
    if (apiToken === '********' && projectId) {
       const { data: existing } = await supabase.from('JiraIntegration').select('apiToken').eq('projectId', projectId).maybeSingle();
       if (existing) actualToken = existing.apiToken;
    }

    if (!baseUrl || !email || !actualToken || !projectKey) {
      return res.status(400).json({ error: 'Missing required fields for test' });
    }

    const service = new JiraService(baseUrl, email, actualToken, projectKey);
    const success = await service.testConnection();

    if (success) {
      res.json({ success: true, message: 'Connection successful!' });
    } else {
      res.status(400).json({ success: false, error: 'Connection failed. Check credentials and project key.' });
    }
  } catch (err: any) {
    console.error('[JiraRoute] Failed to test config:', err);
    res.status(500).json({ error: 'Test failed' });
  }
});

// GET /api/v1/jira/health
router.get('/health', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    const { data: integration, error } = await supabase
      .from('JiraIntegration')
      .select('*')
      .eq('projectId', projectId)
      .maybeSingle();
    if (error) throw error;

    if (!integration || !integration.baseUrl || !integration.apiToken) {
      return res.json({
         jiraConnected: false,
         projectVerified: false,
         authenticationStatus: 'Not Configured',
         availableProjects: []
      });
    }

    const service = new JiraService(integration.baseUrl, integration.email, integration.apiToken, integration.projectKey);
    const health = await service.healthCheck();

    res.json(health);
  } catch (err: any) {
    console.error('[JiraRoute] Failed to fetch health:', err);
    res.status(500).json({ error: 'Health check failed' });
  }
});
// POST /api/v1/jira/create-from-execution/:id
router.post('/create-from-execution/:id', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const { data: execution, error: execErr } = await supabase
      .from('ExecutionLog')
      .select('*, suite:TestSuite(*)')
      .eq('id', id)
      .maybeSingle();
    if (execErr) throw execErr;

    if (!execution || !execution.suite) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const { data: jiraIntegration } = await supabase
      .from('JiraIntegration')
      .select('*')
      .eq('projectId', execution.suite.projectId)
      .maybeSingle();

    const envUrl = process.env.JIRA_BASE_URL;
    const envEmail = process.env.JIRA_EMAIL;
    const envToken = process.env.JIRA_API_TOKEN;
    const envProject = process.env.JIRA_PROJECT_KEY;

    const useDb = jiraIntegration && jiraIntegration.isActive;
    const useEnv = !useDb && envUrl && envEmail && envToken && envProject;

    if (!useDb && !useEnv) {
      return res.status(400).json({ error: 'Jira integration is not configured or active for this project.' });
    }

    const jiraService = new JiraService(
      useDb ? jiraIntegration.baseUrl : envUrl!,
      useDb ? jiraIntegration.email : envEmail!,
      useDb ? jiraIntegration.apiToken : envToken!,
      useDb ? jiraIntegration.projectKey : envProject!,
      useDb ? jiraIntegration.issueType : 'Bug'
    );

    const testName = execution.testName || 'Unknown Test';
    const summary = `[NovaTest AI] Bug: ${testName} failed on ${execution.browser || 'Chromium'}`;
    const reportUrl = `${req.headers.origin || 'http://localhost:5173'}/reports/${execution.id}`;
    const adfContent = JiraService.generateBugReportAdf(execution, reportUrl);

    const result = await jiraService.createIssue(summary, adfContent);

    if (result) {
      try {
        const fsSync = require('fs');
        const path = require('path');
        const screenshotDir = path.resolve(process.cwd(), 'temp', 'screenshots');

        console.log(`[Jira Screenshot] Execution ID: ${execution.id}`);

        let matchingFiles: string[] = [];
        if (fsSync.existsSync(screenshotDir)) {
           matchingFiles = fsSync.readdirSync(screenshotDir)
             .filter((f: string) => f.startsWith(execution.id) && f.endsWith('.png'))
             .map((f: string) => path.join(screenshotDir, f));
        }

        console.log(`[Jira Screenshot] Matching screenshots found: ${matchingFiles.length}`);

        if (matchingFiles.length === 0) {
           console.log(`[Jira Screenshot] No failed screenshots found for execution: ${execution.id}`);

           const { data: screenshotRecord } = await supabase
             .from('Screenshot')
             .select('*')
             .eq('executionLogId', execution.id)
             .limit(1)
             .maybeSingle();
           if (screenshotRecord && screenshotRecord.url) {
             console.log(`[Jira Screenshot] Local file missing, attempting to download existing screenshot from DB URL...`);
             try {
               const axios = require('axios');
               const response = await axios.get(screenshotRecord.url, { responseType: 'arraybuffer' });
               const localScreenshotPath = path.resolve(screenshotDir, `${execution.id}.png`);
               fsSync.mkdirSync(screenshotDir, { recursive: true });
               fsSync.writeFileSync(localScreenshotPath, Buffer.from(response.data, 'binary'));
               matchingFiles.push(localScreenshotPath);
               console.log(`[Jira Screenshot] Successfully downloaded existing screenshot.`);
             } catch(e: any) {
               console.error(`[Jira Screenshot] Failed to download screenshot: ${e.message}`);
             }
           }
        }

        if (matchingFiles.length > 0) {
           let steps: any[] = [];
           if (execution.stepLogs) {
             steps = typeof execution.stepLogs === 'string' ? JSON.parse(execution.stepLogs) : execution.stepLogs;
           }
           const failedSteps = Array.isArray(steps) ? steps.map((s, idx) => ({ step: s, index: idx + 1 })).filter(s => s.step && (s.step.status === 'FAIL' || s.step.status === 'FAILED' || s.step.status === 'ERROR' || s.step.error)) : [];
           console.log(`[Jira Screenshot] Total failed tests: ${failedSteps.length}`);

           for (const filePath of matchingFiles) {
              const baseName = path.basename(filePath);
              console.log(`[Jira Screenshot] Found screenshot: ${baseName}`);
              console.log(`[Jira Screenshot] Processing: ${baseName}`);
              console.log(`[Jira Screenshot] File exists: true`);

              let screenshotFilename = 'failed-step-screenshot.png';

              if (baseName === `${execution.id}.png`) {
                  const failedStepObj = failedSteps.length > 0 ? failedSteps[0] : null;
                  const stepData = failedStepObj ? failedStepObj.step : null;
                  if (failedStepObj && stepData) {
                     const aName = (stepData.action || 'unknown').replace(/[^a-zA-Z0-9]/g, '-');
                     let sName = stepData.scenarioName ? `${stepData.scenarioName.replace(/[^a-zA-Z0-9]/g, '-')}-` : '';
                     screenshotFilename = `failed-step-${failedStepObj.index}-${sName}${aName}.png`;
                  }
              } else {
                  screenshotFilename = baseName.replace(`${execution.id}-`, '');
                  if (screenshotFilename === baseName) screenshotFilename = baseName;
              }

              console.log(`[Jira Screenshot] Attaching: ${screenshotFilename}`);
              if (result.key) {
                  try {
                      const attachResult = await jiraService.attachFile(result.key as string, filePath, screenshotFilename);
                      if (attachResult) {
                         console.log(`[Jira Screenshot] Successfully attached: ${screenshotFilename}`);
                      } else {
                         console.log(`[Jira Screenshot] Failed to attach: ${screenshotFilename}`);
                         console.log(`[Jira Screenshot] Error: Attachment returned false`);
                         console.log(`[Jira Screenshot] Continuing with remaining screenshots`);
                      }
                  } catch (attachErr: any) {
                      console.log(`[Jira Screenshot] Failed to attach: ${screenshotFilename}`);
                      console.log(`[Jira Screenshot] Error: ${attachErr.message || attachErr}`);
                      console.log(`[Jira Screenshot] Continuing with remaining screenshots`);
                  }
              }
           }

           if (matchingFiles.length === 1 && failedSteps.length > 1) {
               console.log(`[Jira Screenshot] Failed tests: ${failedSteps.length}`);
               console.log(`[Jira Screenshot] Existing screenshots: 1`);
               console.log(`[Jira Screenshot] Only 1 screenshot exists physically; attaching only the existing screenshot.`);
               console.log(`[Jira Screenshot] No additional screenshots will be generated.`);
           }
        }
      } catch (attachErr) {
        console.error('[JiraRoute] Failed to attach screenshot:', attachErr);
      }

      const { error: updateErr } = await supabase
        .from('ExecutionLog')
        .update({
          jiraTicketId: result.key,
          jiraTicketUrl: result.url,
          jiraSyncTimestamp: new Date().toISOString()
        })
        .eq('id', id);
      if (updateErr) throw updateErr;
      return res.json({ success: true, ticketId: result.key, ticketUrl: result.url });
    } else {
      return res.status(500).json({ error: 'Failed to create Jira issue via Jira API.' });
    }
  } catch (err: any) {
    console.error('[JiraRoute] Failed to create Jira bug:', err);
    res.status(500).json({ error: err.message || 'Failed to file Jira bug' });
  }
});

// POST /api/v1/jira/create-from-mobile-execution/:id
//
// Mirrors create-from-execution above, but reads the mobile engine's tables
// instead of ExecutionLog. Those tables live in the SAME physical Supabase
// Postgres database (see backend-node/src/routes/dashboard.ts's comment on
// countMobileExecutions) — just a different, SQLAlchemy-owned namespace with
// no FK to ExecutionLog — so this queries them directly with the same
// service-role Supabase client rather than round-tripping through the Python
// engine. Project is the one entity both systems already share (see
// backend-node/src/routes/mobile.ts's enforceProjectScope), reached here via
// mobile_tests.application_id -> mobile_applications.project_uuid, which is
// exactly how the mobile engine scopes itself internally.
router.post('/create-from-mobile-execution/:id', async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid execution id' });

    const { data: execution, error: execErr } = await supabase
      .from('mobile_executions')
      .select('*, step_results:mobile_step_results(*)')
      .eq('id', id)
      .maybeSingle();
    if (execErr) throw execErr;
    if (!execution) return res.status(404).json({ error: 'Mobile execution not found' });

    const { data: test, error: testErr } = await supabase
      .from('mobile_tests')
      .select('*, application:mobile_applications(*)')
      .eq('id', execution.test_id)
      .maybeSingle();
    if (testErr) throw testErr;

    const projectUuid: string | undefined = test?.application?.project_uuid;
    if (!projectUuid) {
      return res.status(400).json({ error: 'This app has no project assigned — cannot resolve a Jira configuration for it.' });
    }

    let device: any = null;
    if (execution.device_id) {
      const { data: deviceRow } = await supabase.from('mobile_devices').select('*').eq('id', execution.device_id).maybeSingle();
      device = deviceRow;
    }

    const { data: jiraIntegration } = await supabase
      .from('JiraIntegration')
      .select('*')
      .eq('projectId', projectUuid)
      .maybeSingle();

    const envUrl = process.env.JIRA_BASE_URL;
    const envEmail = process.env.JIRA_EMAIL;
    const envToken = process.env.JIRA_API_TOKEN;
    const envProject = process.env.JIRA_PROJECT_KEY;

    const useDb = jiraIntegration && jiraIntegration.isActive;
    const useEnv = !useDb && envUrl && envEmail && envToken && envProject;

    if (!useDb && !useEnv) {
      return res.status(400).json({ error: 'Jira integration is not configured or active for this project.' });
    }

    const jiraService = new JiraService(
      useDb ? jiraIntegration.baseUrl : envUrl!,
      useDb ? jiraIntegration.email : envEmail!,
      useDb ? jiraIntegration.apiToken : envToken!,
      useDb ? jiraIntegration.projectKey : envProject!,
      useDb ? jiraIntegration.issueType : 'Bug'
    );

    const testName = test?.name || `Mobile test ${execution.test_id}`;
    const summary = `[NovaTest AI] Mobile bug: ${testName} failed on ${device?.model || device?.serial || 'device'}`;
    const reportUrl = `${req.headers.origin || 'http://localhost:5173'}/app/mobile/executions/${id}/report`;
    const adfContent = JiraService.generateMobileBugReportAdf(execution, test, device, reportUrl);

    const result = await jiraService.createIssue(summary, adfContent);
    if (!result) {
      return res.status(500).json({ error: 'Failed to create Jira issue via Jira API.' });
    }

    // Best-effort screenshot attachment — evidence already lives as a public
    // Supabase Storage URL (backend/mobile/artifact_store.py), so this is a
    // plain fetch + attach rather than the local-disk lookup the web path
    // needs. Never lets an attachment failure undo a successfully filed bug.
    try {
      const { data: evidenceRows } = await supabase
        .from('mobile_evidence')
        .select('*')
        .eq('execution_id', id)
        .eq('artifact_type', 'SCREENSHOT')
        .order('captured_at', { ascending: false })
        .limit(1);
      const screenshot = evidenceRows?.[0];
      if (screenshot?.storage_path && /^https?:\/\//.test(screenshot.storage_path)) {
        const imageRes = await axios.get(screenshot.storage_path, { responseType: 'arraybuffer' });
        await jiraService.attachBuffer(result.key, Buffer.from(imageRes.data), `execution-${id}-screenshot.png`);
      }
    } catch (attachErr: any) {
      console.error('[JiraRoute] Failed to attach mobile screenshot:', attachErr.message || attachErr);
    }

    // No jiraTicketId/jiraTicketUrl columns on mobile_executions (unlike
    // ExecutionLog) — adding them would mean altering a table this backend
    // doesn't own (it's the Python engine's SQLAlchemy schema). result_json
    // is already a free-form JSON column recorded by the engine itself, so
    // merging the ticket info into it is additive and schema-safe.
    const { error: updateErr } = await supabase
      .from('mobile_executions')
      .update({ result_json: { ...(execution.result_json || {}), jira: { ticketId: result.key, ticketUrl: result.url, syncedAt: new Date().toISOString() } } })
      .eq('id', id);
    if (updateErr) console.error('[JiraRoute] Failed to persist mobile Jira ticket link:', updateErr);

    return res.json({ success: true, ticketId: result.key, ticketUrl: result.url });
  } catch (err: any) {
    console.error('[JiraRoute] Failed to create mobile Jira bug:', err);
    res.status(500).json({ error: err.message || 'Failed to file Jira bug' });
  }
});

export default router;
