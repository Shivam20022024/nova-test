import { Worker, Queue, Job, FlowProducer } from 'bullmq';
import redisConnection from '../lib/redis';
import { chromium, firefox, webkit } from 'playwright';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import { supabase } from '../utils/storage';
import { resolveFfmpegPath } from '../lib/ffmpeg';
import { applyHealedSelectorToTestRun } from '../utils/healingPersistence';

import { RequirementsAgent } from '../agents/RequirementsAgent';
import { TestCaseAgent } from '../agents/TestCaseAgent';
import { TestDataAgent } from '../agents/TestDataAgent';
import { sanitizeExecutionPlan } from '../utils/sanitizer';
import { resolveAntiBotConfig, clearanceCacheKey, buildProxyForExecution } from '../utils/antiBot';
import { pickFingerprint, alignFingerprintToGeo, fingerprintContextOptions, buildStealthInitScript } from '../utils/stealth';
import { ScriptGenerationAgent } from '../agents/ScriptGenerationAgent';
import { ExecutionAgent } from '../agents/ExecutionAgent';
import { ApiExecutionAgent } from '../agents/ApiExecutionAgent';
import { ReportingAgent } from '../agents/ReportingAgent';
import { OrchestratorAgent } from '../agents/OrchestratorAgent';
import { ScenarioParserAgent } from '../agents/ScenarioParserAgent';
import { JiraService } from '../services/JiraService';

// Local dev runs use a separate queue name so they can never dequeue/collide
// with jobs on the production 'test-executions' queue (both potentially
// sharing the same Redis instance) — see commit "Isolate local test
// execution queue".
export const executionQueueName = process.env.NODE_ENV === 'production' ? 'test-executions' : 'test-executions-local';

async function cleanupInterruptedJobs() {
  try {
    const { data: interruptedJobs, error } = await supabase
      .from('ExecutionLog')
      .update({
        status: 'FAILED',
        logs: JSON.stringify(["Backend restarted mid-execution. Job marked as FAILED."]),
        durationMs: 0
      })
      .in('status', ['RUNNING', 'HEALING', 'GENERATING_SCRIPT'])
      .select('id');
    if (error) throw error;
    if (interruptedJobs && interruptedJobs.length > 0) {
      console.log(`[Worker Crash Safety] Marked ${interruptedJobs.length} interrupted active jobs as FAILED (WORKER_RESTART_DURING_EXECUTION).`);
    }
  } catch (error) {
    console.error('[Worker Crash Safety] Failed to clean up interrupted jobs:', error);
  }
}

export const executionQueue = new Queue(executionQueueName, {
  connection: redisConnection,
});

export const flowProducer = new FlowProducer({
  connection: redisConnection,
});

export const initExecutionWorker = (io: any) => {
  cleanupInterruptedJobs();
  const worker = new Worker(
    executionQueueName,
    async (job: Job) => {
      if (job.name === 'cross-browser-suite') {
        console.log(`[FlowProducer] Parent suite job ${job.id} marked as complete.`);
        return;
      }
      
      console.log(`WORKER_PICKED_JOB: ${job.data.executionId}`);
      const { executionId, testName, instruction, targetUrl, browser, mode } = job.data;

      const emit = (type: string, payload?: any) => {
        io.to(executionId).emit(type, payload);
      };

      const jobStartTime = Date.now();
      console.log(`EXECUTION_STARTED: ${job.data.executionId}`);
      emit('queued', { message: 'Job accepted by worker' });

      let logs: string[] = [];
      let finalStepLogs: any[] = [];
      let generatedReportContent = '';
      const logMsg = (msg: string) => {
        logs.push(msg);
        emit('browser_log', { message: msg });
      };

      logMsg(`[Execution Claim] EXECUTION_CLAIM_ATTEMPT`);
      const { data: claimedRows, error: claimError } = await supabase
        .from('ExecutionLog')
        .update({ status: 'RUNNING', startedAt: new Date().toISOString() })
        .eq('id', executionId)
        .neq('status', 'CANCELLED')
        .select('id');
      if (claimError) throw claimError;

      if (!claimedRows || claimedRows.length === 0) {
        logMsg(`[Execution Claim] EXECUTION_ALREADY_CLAIMED_OR_CANCELLED - Aborting execution attempt.`);
        return;
      }

      logMsg(`[Execution Claim] EXECUTION_CLAIM_SUCCESS`);
      const { data: activeExecution } = await supabase.from('ExecutionLog').select('*').eq('id', executionId).maybeSingle();

      const reqAgent = new RequirementsAgent(executionId);
      const tcAgent = new TestCaseAgent(executionId);
      const dataAgent = new TestDataAgent();
      const scriptAgent = new ScriptGenerationAgent(executionId);
      const execAgent = new ExecutionAgent();
      const apiExecAgent = new ApiExecutionAgent();
      const reportAgent = new ReportingAgent();
      const orchestratorAgent = new OrchestratorAgent(executionId);

      let sharedBrowser: any = null;
      let sharedContext: any = null;
      let sharedPage: any = null;
      let aggregatedExecResult: any = { success: true, scenario_status: {} };

      // Live browser view: a continuous screencast of the shared page for the
      // whole run (discovery -> generation -> execution), streamed to the UI via
      // the existing 'live_frame' socket event. Chromium/Edge use a smooth CDP
      // screencast; Firefox/WebKit fall back to a screenshot poll.
      let stopLiveView: (() => Promise<void>) | null = null;
      const startLiveView = async () => {
        if (!sharedPage || stopLiveView) return;
        const engine = (browser || 'chromium').toLowerCase();
        const chromiumFamily = ['chromium', 'chrome', 'edge', 'msedge'].includes(engine);
        let lastEmit = 0;
        const emitFrameData = (frame: string) => {
          const now = Date.now();
          if (now - lastEmit < 120) return; // cap at ~8 fps, keep the socket light
          lastEmit = now;
          io.to(executionId).emit('live_frame', { executionId, frame });
        };

        // Headful Chromium: a real CDP screencast is smooth (~30 fps) and does not
        // block page actions. Headless Chromium throttles screencast heavily, so
        // there we use a screenshot poll instead - as we do for Firefox/WebKit.
        if (chromiumFamily && antiBot.headful) {
          try {
            const cdp = await sharedContext.newCDPSession(sharedPage);
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
            cdp.on('Page.screencastFrame', async (payload: any) => {
              emitFrameData(payload.data);
              try { await cdp.send('Page.screencastAck', { sessionId: payload.sessionId }); } catch {}
            });
            logMsg(`[LiveView] CDP screencast started for headful ${engine}.`);
            stopLiveView = async () => {
              try { await cdp.send('Page.stopScreencast'); } catch {}
              try { await cdp.detach(); } catch {}
            };
            return;
          } catch (e: any) {
            logMsg(`[LiveView] CDP screencast unavailable (${e?.message || e}); using screenshot polling.`);
          }
        }

        const iv = setInterval(async () => {
          try {
            if (sharedPage && !sharedPage.isClosed()) {
              const buf = await sharedPage.screenshot({ type: 'jpeg', quality: 55 });
              emitFrameData(buf.toString('base64'));
            }
          } catch { /* page busy / navigating */ }
        }, 500);
        logMsg(`[LiveView] Screenshot streaming started for ${engine} (~2 fps).`);
        stopLiveView = async () => { clearInterval(iv); };
      };
      // Anti-bot (Phase 0 + 1a/1b). Declared here so the challenge-clearance
      // session can also be persisted from the failure path, not only on success.
      const antiBot = resolveAntiBotConfig(job.data.antiBot);
      let antiBotClearanceKey: string | null = null;
      let antiBotClearancePersisted = false;
      const persistClearanceSession = async (reason: string) => {
        if (antiBotClearancePersisted || !antiBotClearanceKey || !sharedContext) return;
        try {
          const state = await sharedContext.storageState();
          await redisConnection.set(antiBotClearanceKey, JSON.stringify(state), 'EX', 1500);
          antiBotClearancePersisted = true;
          logMsg(`[AntiBot] Persisted challenge-clearance session for reuse (TTL 25m, ${reason}).`);
        } catch (e: any) {
          logMsg(`[AntiBot] Could not persist clearance session: ${e?.message || e}`);
        }
      };
      
      try {
        let isOrchestrator = false;
        let scriptCode = '';
        let preDiscovered: any = null;

        const isApiMode = job.data.mode === 'API';
        let VIDEO_PAGE_ID: string = 'unknown-page';

        if (!isApiMode) {
          logMsg('Initializing shared browser for full pipeline video recording...');
          const browserName = (browser || 'chromium').toLowerCase();

          logMsg(`[AntiBot] mode=${antiBot.mode} headful=${antiBot.headful} stealth=${antiBot.stealth} humanize=${antiBot.humanize} bypassHeader=${antiBot.bypassHeader ? antiBot.bypassHeader.name : 'none'} proxy=${antiBot.proxy ? 'yes' : 'no'} solver=${antiBot.solver ? antiBot.solver.provider : 'none'} reuseClearance=${antiBot.reuseClearance}`);

          const execProxy = buildProxyForExecution(antiBot.proxy, executionId);

          const path = await import('path');
          const videoDir = path.resolve(process.cwd(), 'temp', 'videos', executionId);
          const screenshotDir = path.resolve(process.cwd(), 'temp', 'screenshots');
          await fs.mkdir(videoDir, { recursive: true });
          await fs.mkdir(screenshotDir, { recursive: true });

          // Anti-bot 1b: reuse a previously-cleared challenge session for this target.
          antiBotClearanceKey = antiBot.reuseClearance
            ? clearanceCacheKey(activeExecution?.suiteId, job.data.targetUrl)
            : null;
          let storedClearance: any = undefined;
          if (antiBotClearanceKey) {
            const rawState = await redisConnection.get(antiBotClearanceKey).catch(() => null);
            if (rawState) {
              try {
                storedClearance = JSON.parse(rawState);
                logMsg('[AntiBot] Reusing a previously-cleared challenge session for this target.');
              } catch { /* ignore malformed cache */ }
            }
          }

          // Anti-bot 2c: coherent browser fingerprint (only when stealth is on).
          const fpSeed = `${activeExecution?.suiteId || 'global'}:${(() => { try { return new URL(job.data.targetUrl).origin; } catch { return job.data.targetUrl || executionId; } })()}`;
          const fingerprint = antiBot.stealth
            ? alignFingerprintToGeo(pickFingerprint(fpSeed), antiBot.proxy?.geo)
            : null;

          const contextOptions: any = {
            ignoreHTTPSErrors: true,
            recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280 + Math.floor(Math.random() * 100), height: 720 + Math.floor(Math.random() * 100) },
          };
          if (fingerprint) {
            const fpOpts = fingerprintContextOptions(fingerprint);
            Object.assign(contextOptions, fpOpts);
            contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } };
            logMsg(`[AntiBot] Using fingerprint: ${fingerprint.uaPlatform} / ${fingerprint.webglRenderer.split(',')[1]?.trim() || 'gpu'} / ${fingerprint.locale} / ${fingerprint.timezoneId}`);
          }
          // Anti-bot 1a: inject the customer's WAF/CDN bypass header, if configured.
          if (antiBot.bypassHeader) {
            contextOptions.extraHTTPHeaders = { ...(contextOptions.extraHTTPHeaders || {}), [antiBot.bypassHeader.name]: antiBot.bypassHeader.value };
            logMsg(`[AntiBot] Sending configured bypass header "${antiBot.bypassHeader.name}" with every request.`);
          }
          if (storedClearance) contextOptions.storageState = storedClearance;

          // ---- Browser acquisition ----
          if (antiBot.mode === 'managed') {
            if (!antiBot.managedWsEndpoint) throw new Error('AntiBot mode "managed" requires managedWsEndpoint (CDP ws:// URL of a managed stealth browser).');
            logMsg('[AntiBot] Connecting to managed stealth browser over CDP...');
            sharedBrowser = await chromium.connectOverCDP(antiBot.managedWsEndpoint);
            const existing = sharedBrowser.contexts?.() || [];
            sharedContext = existing.length > 0 ? existing[0] : await sharedBrowser.newContext(contextOptions);
            logMsg('[Telemetry] BROWSER_ENGINE_STARTED: managed-cdp');
          } else {
            const launchOpts: any = {
              headless: !antiBot.headful,
              args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'],
            };
            if (execProxy) { launchOpts.proxy = execProxy; logMsg('[AntiBot] Routing browser traffic through configured proxy.'); }
            if (antiBot.headful) logMsg('[AntiBot] Launching HEADFUL browser (needs a display / Xvfb on Linux).');

            if (browserName === 'firefox') {
              sharedBrowser = await firefox.launch(launchOpts);
            } else if (browserName === 'webkit' || browserName === 'safari') {
              sharedBrowser = await webkit.launch(launchOpts);
            } else if (browserName === 'edge' || browserName === 'msedge') {
              sharedBrowser = await chromium.launch({ ...launchOpts, channel: 'msedge' });
            } else {
              // Prefer the real Chrome channel for stealth; fall back to bundled Chromium.
              if (antiBot.stealth) {
                try { sharedBrowser = await chromium.launch({ ...launchOpts, channel: 'chrome' }); logMsg('[AntiBot] Using real Chrome channel.'); }
                catch { sharedBrowser = await chromium.launch(launchOpts); logMsg('[AntiBot] Chrome channel unavailable, using bundled Chromium.'); }
              } else {
                sharedBrowser = await chromium.launch(launchOpts);
              }
            }
            logMsg(`[Telemetry] BROWSER_ENGINE_STARTED: ${browserName}`);
            sharedContext = await sharedBrowser.newContext(contextOptions);
          }

          // ---- Init scripts ----
          if (antiBot.mode !== 'off') {
            if (fingerprint) {
              await sharedContext.addInitScript(buildStealthInitScript(fingerprint));
              logMsg('[AntiBot] Stealth + fingerprint init script injected.');
            } else {
              await sharedContext.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
              });
            }
          }

          sharedPage = await sharedContext.newPage();

          const contextId = (sharedContext as any)._guid || 'unknown-context';
          const pageId = (sharedPage as any)._guid || 'unknown-page';
          VIDEO_PAGE_ID = pageId;
          logMsg(`[Video] VIDEO_CONTEXT_CREATED: ${contextId}`);
          logMsg(`[Video] VIDEO_PAGE_CREATED: ${pageId}`);
          logMsg(`[Video] VIDEO_RECORDING_STARTED`);
          if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_BROWSER_STARTED');

          sharedPage.on('console', (msg: any) => logMsg(`Console [${msg.type()}]: ${msg.text()}`));
          sharedPage.on('pageerror', (error: any) => logMsg(`Page Error: ${error.message}`));

          // Start the live browser view now so the user sees the selected browser
          // from the very first navigation, not only during the execution phase.
          await startLiveView().catch((e: any) => logMsg(`[LiveView] Could not start: ${e?.message || e}`));
        } else {
          logMsg('[Telemetry] API_MODE_SELECTED');
        }

        const executeScriptWithRetry = async (scriptCodeToRun: string) => {
          if (isApiMode) {
            emit('agent_progress', { agent: 'ApiExecutionAgent', status: 'executing' });
            let apiExecResult = await apiExecAgent.executeScript(
              executionId,
              scriptCodeToRun,
              'api',
              (type: string, msg: string) => {
                if (type === 'browser_log') logMsg(`[API] ${msg}`);
                else emit(type, { message: msg });
              },
              { testCases: job.data.testCases, variables: job.data.variables, suiteId: activeExecution?.suiteId }
            );

            if (apiExecResult && apiExecResult.stepLogs) {
              finalStepLogs.push(...apiExecResult.stepLogs);
            }

            if (!apiExecResult.success) {
              if (apiExecResult.scenario_status) {
                Object.assign(aggregatedExecResult.scenario_status, apiExecResult.scenario_status);
              }
              const errMsg = (apiExecResult.error || '').toLowerCase();
              if (!errMsg.includes('assertion failed')) {
                throw new Error(apiExecResult.error || 'API execution failed');
              }
            }

            return apiExecResult;
          }

          const EXECUTION_PAGE_ID = (sharedPage as any)._guid || 'unknown-page';
          if (EXECUTION_PAGE_ID !== VIDEO_PAGE_ID) {
             throw new Error("PAGE_CONTEXT_MISMATCH");
          }
          emit('agent_progress', { agent: 'ExecutionAgent', status: 'executing' });
          let currentExecResult = await execAgent.executeScript(
            executionId,
            scriptCodeToRun,
            browser || 'chromium',
            (type: string, msg: string) => {
              if (job.data.mode === 'EXCEL' && type === 'telemetry') {
                 if (msg === 'ACTION_STARTED=goto') logMsg('[Telemetry] EXCEL_NAVIGATION_STARTED');
                 else if (msg === 'ACTION_COMPLETED=goto') logMsg('[Telemetry] EXCEL_NAVIGATION_COMPLETED');
                 else if (msg.startsWith('ACTION_STARTED=assert')) logMsg('[Telemetry] EXCEL_ASSERTION_EXECUTED');
                 else if (msg.startsWith('ACTION_STARTED=')) logMsg('[Telemetry] EXCEL_ACTION_EXECUTION_STARTED');
              }
              if (type === 'browser_log') logMsg(`[Playwright] ${msg}`);
              else emit(type, { message: msg });
            },
            {
              accessibility: job.data.features?.accessibility || false,
              security: job.data.features?.security || false,
              // enableAiEyes was read from the request (routes/autonomous.ts)
              // but never actually threaded through to here — the AI Eyes
              // visual check has been unreachable in real runs. Wiring it up
              // alongside the new visual-baseline flag below, same pattern
              // as accessibility/security.
              enableAiEyes: job.data.features?.aiEyes || job.data.enableAiEyes || false,
              enableVisualBaseline: job.data.features?.visualBaseline || false,
              testName: job.data.testName,
              sharedPage: sharedPage,
              targetUrl: job.data.targetUrl,
              credentials: (aggregatedExecResult as any).authMetadata || job.data.credentials,
              humanize: antiBot.humanize,
              solver: antiBot.solver
            }
            // Live frames are streamed by the worker-level continuous screencast
            // (startLiveView), so ExecutionAgent's own per-run frame poll is not used.
          );

          if (currentExecResult && currentExecResult.stepLogs) {
             finalStepLogs.push(...currentExecResult.stepLogs);
          }
          
          if (currentExecResult && currentExecResult.screenshotUrl) {
             aggregatedExecResult.screenshotUrl = currentExecResult.screenshotUrl;
          }
          if (currentExecResult && currentExecResult.videoUrl) {
             aggregatedExecResult.videoUrl = currentExecResult.videoUrl;
          }

          if (!currentExecResult.success) {
            if (currentExecResult.scenario_status) {
                Object.assign(aggregatedExecResult.scenario_status, currentExecResult.scenario_status);
            }
            const errMsg = (currentExecResult.error || '').toLowerCase();
            if (!errMsg.includes('assertion step failed') && !errMsg.includes('selector not found in dom')) {
                throw new Error(currentExecResult.error || 'Execution failed');
            }
          }
          
          return currentExecResult;
        };

        // aggregatedExecResult defined outside try block
        if (job.data.mode === 'EXCEL') {
          logMsg('[PLAN SOURCE: EXCEL_EXECUTION_MODE_SELECTED] Executing Excel mode...');
          emit('agent_progress', { agent: 'ExcelBatchProcessor', status: 'processing' });
          logMsg('Processing Excel batch testcases directly...');
          const cases = job.data.testCases;

          emit('agent_progress', { agent: 'ScriptGenerationAgent', status: 'generating_script' });
          logMsg('Compiling Playwright script from Excel data...');
          
          const richContextSteps = cases.map((tc: any) => {
             const targetUrl = job.data.targetUrl || tc.targetUrl || "";
             const steps = tc.steps || "";
             const expectedResult = tc.expectedResult || "";
             const testData = tc.testData || {};
             const scenarioName = tc.name || tc.scenario || "Excel Scenario";
             
             logMsg(`[Telemetry] EXCEL_SCRIPT_INPUT originalId=${tc.id} scenario=${scenarioName} targetUrl=${targetUrl} stepCount=${steps.split(/[;\n]/).length} expectedResultPresent=${!!expectedResult} testDataPresent=${Object.keys(testData).length > 0}`);
             
             return `Scenario Name: ${scenarioName}\nTarget URL: ${targetUrl}\nTest Data: ${JSON.stringify(testData)}\nSteps: ${steps}\nExpected Result: ${expectedResult}`;
          });

          const rawScriptCode = await scriptAgent.generateScript(testName, richContextSteps);
          scriptCode = sanitizeExecutionPlan(rawScriptCode, logMsg);
          
          try {
             const parsed = JSON.parse(scriptCode);
             const generatedCount = new Set(parsed.map((a: any) => a.scenarioName).filter(Boolean)).size;
             logMsg(`[Telemetry] EXCEL_SCRIPT_GENERATION_RESULT originalId=${cases.map((c: any) => c.id).join(',')} expected=${cases.length} actual=${generatedCount}`);
             if (parsed.length === 0) {
                 throw new Error("SCRIPT_GENERATION_FAILED: LLM returned 0 actions for Excel testcase.");
             }
          } catch(e: any) {
             if (e.message.includes("SCRIPT_GENERATION_FAILED")) throw e;
          }
          
          logMsg('[Telemetry] EXCEL_SCRIPT_GENERATED');
          logMsg('[Telemetry] EXCEL_EXECUTION_HANDOFF');
          
          const planDataPayload = JSON.stringify({
             testCases: cases,
             scriptCode: scriptCode
          });
          await job.updateData({ ...job.data, planData: planDataPayload });
          await supabase.from('ExecutionLog').update({ planData: planDataPayload }).eq('id', executionId);
        } else if (job.data.steps) {
          logMsg('[PLAN SOURCE: PROMPT_EXECUTION_MODE_SELECTED] Direct steps provided. Skipping AI generation phases...');
          scriptCode = typeof job.data.steps === 'string' ? job.data.steps : JSON.stringify(job.data.steps);
        } else if (job.data.scriptCode && !job.data.isAutonomous) {
          logMsg('[PLAN SOURCE: explicit_override] Retry detected: Bypassing AI Orchestration and using previously generated script...');
          scriptCode = sanitizeExecutionPlan(job.data.scriptCode, logMsg);
        } else if (job.data.isAutonomous) {
          let currentMode = mode || 'full_autonomous';
          
          if (job.data.customScenario) {
             currentMode = 'STRICT_SCENARIO';
          }
          
          const crypto = await import('crypto');
          const urlHash = crypto.createHash('md5').update(job.data.targetUrl).digest('hex');
          const cacheKeySuffix = `${activeExecution?.suiteId || 'default'}:${urlHash}`;

          const sharedPlanCacheKey = `shared_plan:${cacheKeySuffix}`;
          const orchestratorLockKey = `orchestrator_lock:${cacheKeySuffix}`;

          // Parallel Execution Lock Logic
          let lockAcquired = false;
          let orchestrationWaitAttempts = 0;
          let isOrchestrator = true;
          
          if (currentMode !== 'STRICT_SCENARIO') {
            while (!lockAcquired && orchestrationWaitAttempts < 150) {
               const cachedPlan = await redisConnection.get(sharedPlanCacheKey);
               if (cachedPlan) {
                  logMsg('[PLAN SOURCE: cache_reuse] Reusing Autonomous script generated by sibling execution...');
                  scriptCode = sanitizeExecutionPlan(cachedPlan, logMsg);
                  isOrchestrator = false;
                  break;
               }
               
               lockAcquired = (await redisConnection.set(orchestratorLockKey, "LOCKED", "EX", 300, "NX")) !== null;
               if (!lockAcquired) {
                  logMsg('Waiting for sibling execution to finish Autonomous orchestration...');
                  await new Promise(r => setTimeout(r, 2000));
                  orchestrationWaitAttempts++;
               }
            }
            
            if (!lockAcquired && isOrchestrator) {
               logMsg('[Warning] Sibling orchestration timed out. Proceeding with independent generation.');
            }
          } else {
            // In STRICT_SCENARIO, we do not share or reuse sibling plans. 
            // We run generation specifically for this user's strict scenario array.
            isOrchestrator = true;
          }

          if (isOrchestrator) {
            try {
              emit('agent_progress', { agent: 'DiscoveryAgent', status: 'validating_cache' });
              logMsg('Running DiscoveryAgent to generate DOM signature and capabilities for cache validation...');
              const { DiscoveryAgent } = await import('../agents/DiscoveryAgent');
              const discoveryAgent = new DiscoveryAgent(executionId);
              const discoveryResult = await discoveryAgent.discoverFlows(job.data.targetUrl, 3, { sharedPage, discoveryPath: 'cache_validation' });
              const capabilityMap = await discoveryAgent.detectCapabilities(discoveryResult.domSummary);
              
              const DISCOVERY_PAGE_ID = (sharedPage as any)._guid || 'unknown-page';
              if (DISCOVERY_PAGE_ID !== VIDEO_PAGE_ID) {
                  throw new Error("PAGE_CONTEXT_MISMATCH");
              }
              
              let fingerprintData = capabilityMap;
              if (currentMode !== 'basic' && currentMode !== 'STRICT_SCENARIO') {
                const { CapabilityAnalyzerAgent } = await import('../agents/CapabilityAnalyzerAgent');
                const capAgent = new CapabilityAnalyzerAgent(executionId);
                fingerprintData = await capAgent.analyze(discoveryResult.domSummary);
              }
              const currentFingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprintData)).digest('hex');
              
              preDiscovered = {
                domSummary: discoveryResult.domSummary,
                capabilityMap,
                discoveredFlows: discoveryResult.flows,
                fingerprint: currentFingerprint
              };

              let orchestrationAttempt = 1;
              while (orchestrationAttempt <= 2) {
                try {
                  logMsg(`[PLAN SOURCE: fresh_generation] Starting ${currentMode} Pipeline (Attempt ${orchestrationAttempt})...`);
                  
                  let planResult;
                  if (currentMode === 'STRICT_SCENARIO') {
                     // Phase: Pre-parse ALL scenarios
                     const scenarioParser = new ScenarioParserAgent(executionId);
                     emit('agent_progress', { agent: 'ScenarioParserAgent', status: 'parsing_scenarios' });
                     const parseResult = await scenarioParser.parse(job.data.customScenario);
                     const allParsedScenarios = parseResult.scenarios;
                     
                     if (parseResult.auth) {
                        (aggregatedExecResult as any).authMetadata = parseResult.auth;
                     }
                     
                     logMsg(`[Telemetry] PARSED_SCENARIO_COUNT=${allParsedScenarios.length}`);
                     
                     const STRICT_BATCH_SIZE = Math.max(1, parseInt(process.env.STRICT_SCENARIO_BATCH_SIZE || '3', 10) || 3);
                     const batches: any[][] = [];
                     for (let i = 0; i < allParsedScenarios.length; i += STRICT_BATCH_SIZE) {
                         batches.push(allParsedScenarios.slice(i, i + STRICT_BATCH_SIZE));
                     }
                     logMsg(`[Telemetry] STRICT_SCENARIO_BATCHES count=${batches.length} size=${STRICT_BATCH_SIZE}`);
                     
                     let executedCount = 0;
                     let allTestCases: any[] = [];
                     let allExecutionPlans: any[] = [];
                     
                     for (let b = 0; b < batches.length; b++) {
                         logMsg(`[Telemetry] EXECUTION_BATCH_STARTED=${b+1}`);

                         // Post-auth DOM refresh: once the first batch has run, the shared page
                         // is deep inside the app (logged in, on a cart/checkout/etc. page). Feed
                         // that LIVE, non-mutated DOM into the next batch's generation so later
                         // scenarios are built against the real page state instead of the stale
                         // pre-login crawl. Read-only - never navigates the shared page.
                         if (b > 0 && sharedPage && !sharedPage.isClosed?.()) {
                            try {
                               const { snapshotLiveDom } = await import('../agents/DiscoveryAgent');
                               const liveDom = await snapshotLiveDom(sharedPage);
                               if (liveDom) {
                                  const priorCrawl = (preDiscovered?.domSummary || '').slice(0, 1500);
                                  preDiscovered = { ...preDiscovered, domSummary: `${liveDom}\n\n--- earlier crawl summary (may be stale) ---\n${priorCrawl}` };
                                  logMsg(`[Telemetry] POST_AUTH_DOM_REFRESH batch=${b+1} url=${sharedPage.url()} chars=${liveDom.length}`);
                               }
                            } catch (e: any) {
                               logMsg(`[Discovery] Post-auth DOM refresh skipped: ${e?.message || e}`);
                            }
                         }

                         const currentCookies = await sharedContext.cookies().catch(() => []);
                         const isSessionReused = currentCookies.length > 0;
                         logMsg(`[Telemetry] SESSION_REUSED=${isSessionReused}`);
                         logMsg(`[Telemetry] AUTH_STATE_VALID=${isSessionReused}`);
                         logMsg(`[Telemetry] BATCH_CONTEXT_REUSED=true`);
                         logMsg(`[Telemetry] RELOGIN_TRIGGERED=false`);
                         
                         const batchPlanResult = await orchestratorAgent.planStrictScenarioQA(
                           job.data.targetUrl,
                           logMsg,
                           (agent: string, status: string) => emit('agent_progress', { agent, status }),
                           { sharedPage, preDiscovered, customScenarioText: '', preParsedScenarios: batches[b]!, isContinuation: b > 0 }
                         );
                         
                         if (!batchPlanResult.success) {
                             throw new Error("Orchestrator failed to plan execution for batch " + (b+1) + ": " + batchPlanResult.error);
                         }
                         logMsg(`[Telemetry] SCRIPT_BATCH_GENERATED=${b+1}`);
                         
                         if (batchPlanResult.testCases) {
                             allTestCases.push(...batchPlanResult.testCases);
                         }
                         
                         const batchScriptCode = sanitizeExecutionPlan(batchPlanResult.executionPlan || '[]', logMsg);
                         try {
                           const parsedBatchPlan = JSON.parse(batchPlanResult.executionPlan || '[]');
                           allExecutionPlans.push(...parsedBatchPlan);
                         } catch (e) {}
                         
                         // 5-minute maximum per batch timeout
                         const batchTimeoutMs = 5 * 60 * 1000;
                         const timeoutPromise = new Promise<never>((_, reject) => {
                             setTimeout(() => reject(new Error('EXECUTION_BATCH_TIMEOUT')), batchTimeoutMs);
                         });
                         
                         const batchExecResult = await Promise.race([
                             executeScriptWithRetry(batchScriptCode),
                             timeoutPromise
                         ]);
                         
                         if (batchExecResult && batchExecResult.scenario_status) {
                             Object.assign(aggregatedExecResult.scenario_status, batchExecResult.scenario_status);
                         }
                         if (batchExecResult) {
                             aggregatedExecResult.videoUrl = batchExecResult.videoUrl || aggregatedExecResult.videoUrl;
                             aggregatedExecResult.screenshotUrl = batchExecResult.screenshotUrl || aggregatedExecResult.screenshotUrl;
                             aggregatedExecResult.accessibilityResults = batchExecResult.accessibilityResults || aggregatedExecResult.accessibilityResults;
                             aggregatedExecResult.securityResults = batchExecResult.securityResults || aggregatedExecResult.securityResults;
                             aggregatedExecResult.transcriptEvents = (aggregatedExecResult.transcriptEvents || []).concat(batchExecResult.transcriptEvents || []);
                             aggregatedExecResult.stepLogs = (aggregatedExecResult.stepLogs || []).concat(batchExecResult.stepLogs || []);
                         }
                         
                         executedCount += (batches[b]?.length || 0);
                         
                         const batchCompletionContract = {
                             batchId: b + 1,
                             status: "completed",
                             executedScenarioCount: batches[b]?.length || 0,
                             failedScenarioCount: 0 // handled via exceptions if it fails entirely
                         };
                         logMsg(`[Telemetry] BATCH_EXECUTION_COMPLETED=${b+1} CONTRACT=${JSON.stringify(batchCompletionContract)}`);
                     }
                     
                     if (executedCount !== allParsedScenarios.length) {
                         throw new Error("SCENARIO_EXECUTION_MISMATCH: executed count does not match parsed count.");
                     }

                     // Aggregate generation completeness across ALL batches using stable scenario
                     // identity (name), NOT per-batch array length. A scenario split across batches
                     // (e.g. 5 + 2) is complete when every expected name is present exactly once.
                     const expectedScenarioNames: string[] = allParsedScenarios.map((s: any) => s.name).filter(Boolean);
                     const generatedNameCounts: Record<string, number> = {};
                     for (const a of allExecutionPlans) {
                        if (a && a.scenarioName) generatedNameCounts[a.scenarioName] = (generatedNameCounts[a.scenarioName] || 0) + 1;
                     }
                     const generatedScenarioNames = Object.keys(generatedNameCounts);
                     const missingScenarioNames = expectedScenarioNames.filter(n => !(n in generatedNameCounts));
                     const unknownScenarioNames = generatedScenarioNames.filter(n => !expectedScenarioNames.includes(n));
                     // Expected scenario names must be unique for identity-based aggregation to be sound.
                     const duplicateExpectedNames = expectedScenarioNames.filter((n, idx) => expectedScenarioNames.indexOf(n) !== idx);
                     const aggregatedGenStatus = (missingScenarioNames.length === 0 && unknownScenarioNames.length === 0 && duplicateExpectedNames.length === 0 && allExecutionPlans.length > 0) ? 'SUCCESS' : 'FAILED';
                     logMsg(`[Telemetry] SCRIPT_GENERATION_FINAL expected=${expectedScenarioNames.length} generated=${generatedScenarioNames.length} missing=${missingScenarioNames.length} duplicates=${duplicateExpectedNames.length} unknown=${unknownScenarioNames.length} unmapped=0 status=${aggregatedGenStatus}`);
                     if (missingScenarioNames.length > 0) {
                        logMsg(`[Telemetry] SCRIPT_GENERATION_MISSING_SCENARIOS=${JSON.stringify(missingScenarioNames)}`);
                     }

                     planResult = { success: true, executionPlan: JSON.stringify(allExecutionPlans), testCases: allTestCases, requested_count: allParsedScenarios.length };
                  } else {
                     planResult = await orchestratorAgent.planAutonomousQA(
                       job.data.targetUrl,
                       logMsg,
                       (agent: string, status: string) => emit('agent_progress', { agent, status }),
                       { sharedPage, mode: currentMode, preDiscovered, customScenario: job.data.customScenario }
                     );
                  }
                  
                  if (!planResult.success) {
                    throw new Error("Orchestrator failed to plan execution: " + planResult.error);
                  }
                  scriptCode = sanitizeExecutionPlan(planResult.executionPlan || '[]', logMsg);
                  const planDataPayload = JSON.stringify({
                    testCases: planResult.testCases || [],
                    scriptCode: scriptCode,
                    requested_count: (planResult as any).requested_count || 0
                  });
                  await job.updateData({ ...job.data, scriptCode, testCases: planResult.testCases, requested_count: (planResult as any).requested_count, planData: planDataPayload });
                  await supabase.from('ExecutionLog').update({ planData: planDataPayload }).eq('id', executionId);

                  if (currentMode !== 'STRICT_SCENARIO') {
                     // Cache the script for sibling executions (expires in 10 mins)
                     await redisConnection.set(sharedPlanCacheKey, scriptCode, "EX", 600);
                  }
                  break;
                } catch (orchestratorErr: any) {
                  const errMsg = (orchestratorErr.message || '').toLowerCase();
                  const isDeterministic = errMsg.includes('validation error') ||
                                          errMsg.includes('schema error') ||
                                          errMsg.includes('script_count_mismatch') ||
                                          errMsg.includes('script count mismatch') ||
                                          errMsg.includes('malformed') ||
                                          errMsg.includes('business rule') ||
                                          errMsg.includes('strict scenario generation failed') ||
                                          errMsg.includes('parser error:') ||
                                          errMsg.includes('assertion step failed') ||
                                          errMsg.includes('selector not found in dom');
                                          
                  if (isDeterministic) {
                    logMsg(`[Error] Orchestration failed with deterministic error: ${orchestratorErr.message}. Aborting immediately.`);
                    throw orchestratorErr;
                  }

                  if (orchestrationAttempt === 2) {
                    logMsg(`[Error] Orchestrator failed on attempt 2: ${orchestratorErr.message}.`);
                    throw orchestratorErr;
                  }
                  // We are about to RETRY. Do NOT write the raw error payload into the shared
                  // `logs` buffer here: it can contain a structured
                  // {"status":"FAILED","reason":"PARTIAL_SCRIPT_GENERATION_RESPONSE",...} JSON.
                  // If the retry then succeeds, that stale string is still handed to
                  // ReportingAgent and gets mis-reported as the FINAL execution verdict.
                  // Emit a short, non-verdict summary instead; the real failure detail is
                  // still logged (with full message) on the final-throw paths above.
                  let transientReason: string;
                  try {
                    const parsed = JSON.parse(orchestratorErr.message);
                    transientReason = parsed && parsed.reason
                      ? `${parsed.reason} (expected=${parsed.expected}, actual=${parsed.actual})`
                      : (orchestratorErr.message || 'unknown').split('\n')[0].slice(0, 160);
                  } catch {
                    transientReason = (orchestratorErr.message || 'unknown').split('\n')[0].slice(0, 160);
                  }
                  logMsg(`[Warning] Orchestration attempt ${orchestrationAttempt} did not complete (transient: ${transientReason}). This attempt was superseded by a retry — ignore it when judging the final result.`);
                  orchestrationAttempt++;
                }
              }
            } finally {
              if (lockAcquired) {
                await redisConnection.del(orchestratorLockKey);
              }
            }
          }
        } else {
          // Phase 1: Parsing
          emit('agent_progress', { agent: 'RequirementsAgent', status: 'parsing' });
          logMsg('Parsing natural language instructions...');
          const reqs = await reqAgent.parseRequirements(`Test Name: ${testName}\nURL: ${targetUrl}\nInstruction: ${instruction}`);

          // Phase 2: Generating Cases
          emit('agent_progress', { agent: 'TestCaseAgent', status: 'generating_cases' });
          logMsg('Generating test cases...');
          const cases = await tcAgent.generateTestCases(reqs);

          // Phase 3: Generating Data
          emit('agent_progress', { agent: 'TestDataAgent', status: 'generating_data' });
          logMsg('Generating synthetic test data...');
          const testData = await dataAgent.generateData(cases);

          // Phase 4: Script Generation
          emit('agent_progress', { agent: 'ScriptGenerationAgent', status: 'generating_script' });
          logMsg('Compiling Playwright script...');
          const rawScriptCode = await scriptAgent.generateScript(testName, cases);
          scriptCode = sanitizeExecutionPlan(rawScriptCode, logMsg);
          const planDataPayload = JSON.stringify({
             testCases: cases,
             scriptCode: scriptCode
          });
          await job.updateData({ ...job.data, planData: planDataPayload });
          await supabase.from('ExecutionLog').update({ planData: planDataPayload }).eq('id', executionId);
        }

        // Phase 5: Execution
        let execResult: any = aggregatedExecResult;
        const currentMode = job.data.isAutonomous && job.data.customScenario ? 'STRICT_SCENARIO' : (mode || 'full_autonomous');
        if (currentMode !== 'STRICT_SCENARIO') {
             if (job.data.mode === 'EXCEL') {
                logMsg('[Telemetry] EXCEL_EXECUTION_STARTED');
                try {
                   let parsed = JSON.parse(scriptCode);
                   if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].action !== 'goto' && job.data.targetUrl) {
                      parsed.unshift({ action: 'goto', url: job.data.targetUrl, scenarioName: parsed[0].scenarioName || null });
                      scriptCode = JSON.stringify(parsed);
                   }
                } catch(e) {}
             }
             execResult = await executeScriptWithRetry(scriptCode);
             if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_EXECUTION_RESULT');
        }
        
        // Ensure finalStepLogs doesn't get overridden if already populated by batch
        if (currentMode === 'STRICT_SCENARIO') {
             finalStepLogs = aggregatedExecResult?.stepLogs || aggregatedExecResult?.transcriptEvents || [];
        } else {
             finalStepLogs = execResult?.stepLogs || execResult?.transcriptEvents || [];
        }

        // Finalize Video
        let finalVideoUrl = execResult.videoUrl;
        const video = isApiMode ? null : sharedPage.video();

        if (!isApiMode) {
          if (stopLiveView) { await stopLiveView().catch(() => {}); stopLiveView = null; }
          await persistClearanceSession('run completed');
          await sharedPage.close().catch(() => {});
          await sharedContext.close().catch(() => {});
          await sharedBrowser.close().catch(() => {});
        }

        if (video) {
          try {
            const videoPath = await video.path();
            if (fsSync.existsSync(videoPath)) {
              const stats = fsSync.statSync(videoPath);
              if (stats.size > 0) {
                // Post-process with FFmpeg to remove static LLM processing frames
                const compressedPath = videoPath.replace('.webm', '_compressed.webm');
                try {
                  const { exec } = require('child_process');
                  const util = require('util');
                  const execPromise = util.promisify(exec);
                  const ffmpegBin = resolveFfmpegPath();
                  await execPromise(`"${ffmpegBin}" -y -i "${videoPath}" -vf "mpdecimate,setpts=N/FRAME_RATE/TB" "${compressedPath}"`);
                  if (fsSync.existsSync(compressedPath) && fsSync.statSync(compressedPath).size > 0) {
                     fsSync.copyFileSync(compressedPath, videoPath);
                  } else {
                     console.error("FFmpeg ran but produced no compressed output, keeping original video.");
                  }
                } catch (ffmpegErr) {
                  console.error("FFmpeg compression failed, falling back to original video:", ffmpegErr);
                }

                const videoData = await fs.readFile(videoPath);
                const { data, error } = await supabase.storage
                  .from('videos')
                  .upload(`${executionId}.mp4`, videoData, { contentType: 'video/mp4', upsert: true });
                  
                if (!error && data) {
                  const { data: publicData } = supabase.storage.from('videos').getPublicUrl(data.path);
                  finalVideoUrl = publicData.publicUrl;
                }
              }
            }
          } catch (e) {
            console.error("Video processing failed in worker", e);
          }
        }

        // Save artifacts to DB
        if (finalVideoUrl) {
          await supabase.from('Video').insert({ executionLogId: executionId, url: finalVideoUrl, storagePath: `videos/${executionId}.webm` });
        }
        if (execResult.screenshotUrl) {
          await supabase.from('Screenshot').insert({ executionLogId: executionId, url: execResult.screenshotUrl, storagePath: `screenshots/${executionId}.png` });
        }



        const durationMs = Date.now() - jobStartTime;

        // Phase 6: Reporting
        emit('agent_progress', { agent: 'ReportingAgent', status: 'reporting' });
        logMsg('Generating final execution report...');
        
        let finalExecutionStatus = 'COMPLETED';
        let requested_count = job.data.requested_count || 0;
        let executed_count = 0;
        let passed_count = 0;
        let failed_count = 0;
        let skipped_count = 0;

        let testMetadataOutput = job.data.testCases ? JSON.stringify(job.data.testCases) : 'N/A';
        
        if (execResult.scenario_status) {
           for (const [scenarioName, status] of Object.entries(execResult.scenario_status)) {
             // Ensure skipped_count tracks correctly instead of falling into executed_count
             if (status === 'PASS') { passed_count++; executed_count++; }
             else if (status === 'FAIL') { failed_count++; executed_count++; }
             else if (status === 'IN_PROGRESS') { failed_count++; executed_count++; } // Did not finish
             else if (status === 'SKIPPED' || status === 'NOT_STARTED') { skipped_count++; }
           }
           
           if (isApiMode && failed_count > 0) {
             finalExecutionStatus = 'FAILED';
           }

           if (job.data.customScenario) {
             if (passed_count < requested_count) {
                finalExecutionStatus = 'FAILED';
             }

             // Format exact requested logging output
             logMsg('====================================================');
             logMsg(`Requested scenarios: ${requested_count}`);
             logMsg(`Executed scenarios: ${executed_count}`);
             logMsg(`Passed: ${passed_count}`);
             logMsg(`Failed: ${failed_count}`);
             logMsg(`Skipped: ${skipped_count}`);
             logMsg('');
             logMsg('Per scenario:');
             for (const [scenarioName, status] of Object.entries(execResult.scenario_status)) {
                logMsg(`${scenarioName} -> ${status}`);
             }
             logMsg('====================================================');
           }
           
           testMetadataOutput = JSON.stringify({
              testCases: job.data.testCases || 'N/A',
              scenario_status: execResult.scenario_status,
              metrics: { requested_count, executed_count, passed_count, failed_count, skipped_count }
           });
        }
        
        // We only reach this success path once script generation produced an executable
        // plan and Playwright actually ran it — feed that authoritative state to the
        // reporting agent so it can't infer a failure from a superseded transient log line.
        const reportRes = await reportAgent.generateReport(executionId, {
          testName,
          status: finalExecutionStatus,
          scriptGenerationStatus: 'SUCCESS',
          playwrightExecutionStatus: (executed_count > 0 || finalStepLogs.length > 0) ? 'COMPLETED' : 'STARTED',
          error: null,
          duration: durationMs / 1000,
          browser: job.data.browser || 'chromium',
          environment: process.env.NODE_ENV || 'Local',
          url: job.data.targetUrl,
          logs: logs.join('\n'),
          testMetadata: testMetadataOutput,
          executedSteps: JSON.stringify(finalStepLogs),
          screenshotUrl: execResult.screenshotUrl || null,
          videoUrl: finalVideoUrl || null,
          executionType: isApiMode ? 'API' : 'WEB'
        });
        
        if (reportRes && reportRes.content) {
            generatedReportContent = (reportRes.content as any).markdown_report || JSON.stringify(reportRes.content, null, 2);
          }
        
        if (reportRes && reportRes.url) {
          await supabase.from('Report').insert({
            executionLogId: executionId,
            url: reportRes.url,
            storagePath: `reports/${executionId}.json`
          }).then(({ error }) => { if (error) logMsg(`Failed to save report to DB: ${error.message}`); });
        }

        finalStepLogs.push({
          action: 'EXECUTION_RESULT',
          status: finalExecutionStatus,
          time: new Date().toISOString(),
          details: 'Execution Completed',
          value: JSON.stringify({
            accessibility: execResult.accessibilityResults,
            security: execResult.securityResults,
            scenario_status: execResult.scenario_status,
            transcript: execResult.transcriptEvents,
            metrics: { requested_count, executed_count, passed_count, failed_count, skipped_count }
          })
        });

        const callCountKey = `execution_stats:${executionId}:llm_calls`;
        const totalTokensKey = `execution_stats:${executionId}:total_tokens`;
        const callsStr = await redisConnection.get(callCountKey);
        const tokensStr = await redisConnection.get(totalTokensKey);
        const llmCalls = callsStr ? parseInt(callsStr, 10) : 0;
        const totalTokens = tokensStr ? parseInt(tokensStr, 10) : 0;
        const estimatedCost = (totalTokens / 1000000) * 5.0; // Assuming $5 per 1M tokens as an average
        
        logMsg(`[Cost Summary] LLM_CALL_COUNT=${llmCalls}, TOTAL_TOKENS=${totalTokens}, ESTIMATED_COST=$${estimatedCost.toFixed(4)}`);

        // AutoHeal is fully automatic end to end: a heal that passed during
        // this run is immediately written back into the saved TestRun.steps
        // (via applyHealedSelectorToTestRun) so the next run of this same
        // test starts from the fixed selector instead of re-healing it from
        // scratch — no human approval step. HealingEvent stays as a
        // read-only log of what AutoHeal did and whether the fix could be
        // persisted (it can't for an ad-hoc run with no saved TestRun).
        for (let i = 0; i < finalStepLogs.length; i++) {
          const step = finalStepLogs[i];
          if (step.action === 'HEAL' && step.status === 'PASSED') {
            let originalSelector = '';
            for (let j = i - 1; j >= 0; j--) {
               if (finalStepLogs[j].action === 'HEAL' && finalStepLogs[j].status === 'TRIGGERED') {
                  originalSelector = finalStepLogs[j].rawSelector || '';
                  break;
               }
            }
            if (originalSelector && step.rawSelector) {
               let persisted = false;
               try {
                 persisted = await applyHealedSelectorToTestRun({
                   suiteId: activeExecution?.suiteId,
                   testName,
                   stepIndex: i,
                   originalSelector,
                   healedSelector: step.rawSelector,
                 });
               } catch (persistErr) {
                 console.error('Failed to persist healed selector to TestRun:', persistErr);
               }
               if (!persisted) {
                 logMsg(`[AutoHeal] Healed step ${i} but could not find a saved TestRun to persist it into (likely an ad-hoc run) — the fix applied for this run only.`);
               }
               await supabase.from('HealingEvent').insert({
                 executionLogId: executionId,
                 originalSelector: originalSelector,
                 healedSelector: step.rawSelector,
                 success: true,
                 status: 'APPLIED',
                 testName: testName,
                 stepIndex: i,
               }).then(({ error }) => { if (error) console.error("Failed to save HealingEvent:", error); });
            }
          }
        }

        await supabase.from('ExecutionLog').update({
          status: finalExecutionStatus,
          completedAt: new Date().toISOString(),
          durationMs,
          logs: JSON.stringify(logs),
          stepLogs: JSON.stringify(finalStepLogs),
          traceData: JSON.stringify(finalStepLogs),
          planData: job.data.planData || null,
          visualRegressionData: execResult.visualRegressionData || null
        }).eq('id', executionId);

        if (finalExecutionStatus === 'FAILED') {
           try {
             const { data: finalDbState } = await supabase
               .from('ExecutionLog')
               .select('*, suite:TestSuite(*)')
               .eq('id', executionId)
               .maybeSingle();
             if (finalDbState && finalDbState.suite) {
                 const { data: jiraIntegration } = await supabase
                   .from('JiraIntegration')
                   .select('*')
                   .eq('projectId', finalDbState.suite.projectId)
                   .maybeSingle();
                 const envUrl = process.env.JIRA_BASE_URL;
                 const envEmail = process.env.JIRA_EMAIL;
                 const envToken = process.env.JIRA_API_TOKEN;
                 const envProject = process.env.JIRA_PROJECT_KEY;

                 const useDb = jiraIntegration && jiraIntegration.isActive;
                 const useEnv = !useDb && envUrl && envEmail && envToken && envProject;

                 if (useDb || useEnv) {
                   logMsg('[Jira] Auto-creating Jira bug for application test failures...');
                   const jiraService = new JiraService(
                     useDb ? jiraIntegration.baseUrl : envUrl!,
                     useDb ? jiraIntegration.email : envEmail!,
                     useDb ? jiraIntegration.apiToken : envToken!,
                     useDb ? jiraIntegration.projectKey : envProject!,
                     useDb ? jiraIntegration.issueType : 'Bug'
                   );
                   const summary = `[NovaTest AI] [Application Failure] ${testName} failed on ${finalDbState.browser || 'Chromium'}`;
                   const reportUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reports/${executionId}`;
                   const adfContent = JiraService.generateBugReportAdf(finalDbState, reportUrl);
                   
                   const issue = await jiraService.createIssue(summary, adfContent);
                   if (issue) {
                     logMsg(`[Jira] Successfully created issue: ${issue.key}`);
                     logMsg('[Telemetry] JIRA_ISSUE_CREATED');
                     let matchingFilesCheck: string[] = [];
                     const checkDir = require('path').resolve(process.cwd(), 'temp', 'screenshots');
                     if (require('fs').existsSync(checkDir)) {
                        matchingFilesCheck = require('fs').readdirSync(checkDir).filter((f: string) => f.startsWith(executionId) && f.endsWith('.png'));
                     }
                     if (execResult.screenshotUrl || matchingFilesCheck.length > 0) {
                         const fsSync = require('fs');
                         const path = require('path');
                         const screenshotDir = path.resolve(process.cwd(), 'temp', 'screenshots');
                         
                         logMsg(`[Jira Screenshot] Execution ID: ${executionId}`);
                         
                         let matchingFiles: string[] = matchingFilesCheck.map((f: string) => path.join(screenshotDir, f));
                         
                         logMsg(`[Jira Screenshot] Matching screenshots found: ${matchingFiles.length}`);
                         
                         if (matchingFiles.length === 0 && execResult.screenshotUrl) {
                            logMsg(`[Jira Screenshot] Local file missing, attempting to download existing screenshot from Supabase...`);
                            try {
                               const axios = require('axios');
                               const response = await axios.get(execResult.screenshotUrl, { responseType: 'arraybuffer' });
                               const localScreenshotPath = path.resolve(screenshotDir, `${executionId}.png`);
                               fsSync.mkdirSync(screenshotDir, { recursive: true });
                               fsSync.writeFileSync(localScreenshotPath, Buffer.from(response.data, 'binary'));
                               matchingFiles.push(localScreenshotPath);
                               logMsg(`[Jira Screenshot] Successfully downloaded existing screenshot.`);
                            } catch (dlErr: any) {
                               logMsg(`[Jira Screenshot] Failed to download screenshot: ${dlErr.message}`);
                            }
                         }

                         if (matchingFiles.length === 0) {
                            logMsg(`[Jira Screenshot] No failed screenshots found for execution: ${executionId}`);
                         } else {
                            const failedSteps = Array.isArray(finalStepLogs) ? finalStepLogs.map((s: any, idx: number) => ({ step: s, index: idx + 1 })).filter(s => s.step && (s.step.status === 'FAIL' || s.step.status === 'FAILED' || s.step.status === 'ERROR' || s.step.error)) : [];
                            logMsg(`[Jira Screenshot] Total failed tests: ${failedSteps.length}`);
                            
                            for (const filePath of matchingFiles) {
                               const baseName = path.basename(filePath);
                               logMsg(`[Jira Screenshot] Found screenshot: ${baseName}`);
                               logMsg(`[Jira Screenshot] Processing: ${baseName}`);
                               logMsg(`[Jira Screenshot] File exists: true`);
                               
                               let screenshotFilename = 'failed-step-screenshot.png';
                               
                               if (baseName === `${executionId}.png`) {
                                   const failedStepObj = failedSteps.length > 0 ? failedSteps[0] : null;
                                   const stepData = failedStepObj ? failedStepObj.step : null;
                                   if (failedStepObj && stepData) {
                                      const aName = (stepData.action || 'unknown').replace(/[^a-zA-Z0-9]/g, '-');
                                      let sName = '';
                                      if (execResult && execResult.transcriptEvents) {
                                          const transcriptFailed = execResult.transcriptEvents.find((t: any) => t.status === 'FAILED' || t.status === 'FAIL');
                                          if (transcriptFailed && transcriptFailed.scenarioName) {
                                              sName = `${transcriptFailed.scenarioName.replace(/[^a-zA-Z0-9]/g, '-')}-`;
                                          }
                                      }
                                      screenshotFilename = `failed-step-${failedStepObj.index}-${sName}${aName}.png`;
                                   }
                               } else {
                                   screenshotFilename = baseName.replace(`${executionId}-`, '');
                                   if (screenshotFilename === baseName) screenshotFilename = baseName;
                               }
                               
                               logMsg(`[Jira Screenshot] Attaching: ${screenshotFilename}`);
                               if (issue.key) {
                                   try {
                                       const attachResult = await jiraService.attachFile(issue.key as string, filePath, screenshotFilename);
                                       if (attachResult) {
                                          logMsg(`[Jira Screenshot] Successfully attached: ${screenshotFilename}`);
                                       } else {
                                          logMsg(`[Jira Screenshot] Failed to attach: ${screenshotFilename}`);
                                          logMsg(`[Jira Screenshot] Error: Attachment returned false`);
                                          logMsg(`[Jira Screenshot] Continuing with remaining screenshots`);
                                       }
                                   } catch (attachErr: any) {
                                       logMsg(`[Jira Screenshot] Failed to attach: ${screenshotFilename}`);
                                       logMsg(`[Jira Screenshot] Error: ${attachErr.message || attachErr}`);
                                       logMsg(`[Jira Screenshot] Continuing with remaining screenshots`);
                                   }
                               }
                            }
                            
                            if (matchingFiles.length === 1 && failedSteps.length > 1) {
                                logMsg(`[Jira Screenshot] Failed tests: ${failedSteps.length}`);
                                logMsg(`[Jira Screenshot] Existing screenshots: 1`);
                                logMsg(`[Jira Screenshot] Only 1 screenshot exists physically; attaching only the existing screenshot.`);
                                logMsg(`[Jira Screenshot] No additional screenshots will be generated.`);
                            }
                         }}
                   } else {
                     logMsg('⚠ Jira Integration Failed');
                     logMsg('Reason: Invalid Project Key, Missing Permissions, Invalid Issue Type, or Authentication Failure');
                     
                     // Update execution status to Completed With Warnings
                     await supabase.from('ExecutionLog').update({ status: 'Completed With Warnings' }).eq('id', executionId);
                     logMsg('Execution Status: Completed With Warnings');
                   }
                 }
             }
           } catch (e: any) {
             logMsg(`⚠ Jira Integration Failed`);
             logMsg(`Reason: ${e.message || 'Unknown Error'}`);

             await supabase.from('ExecutionLog').update({ status: 'Completed With Warnings' }).eq('id', executionId);
             logMsg('Execution Status: Completed With Warnings');
           }
        }
        
        // We will emit 'execution_completed' in the finally block after video upload

      } catch (err: any) {
        logMsg(`[Error] ${err.message}`);
        
        const durationMs = Date.now() - jobStartTime;

        const nextStatus = (err.message.includes('BLOCKED_BY_ANTIBOT') || err.message.includes('BlockedByAntiBotError')) ? 'BLOCKED' : 'FAILED';

        if (aggregatedExecResult && aggregatedExecResult.screenshotUrl) {
          await supabase.from('Screenshot').insert({ executionLogId: executionId, url: aggregatedExecResult.screenshotUrl, storagePath: `screenshots/${executionId}.png` }).then(() => {}, () => {});
        }

        let finalMetadata = job.data.testCases ? JSON.stringify(job.data.testCases) : 'N/A';
        if (aggregatedExecResult && aggregatedExecResult.scenario_status) {
           let requested_count = job.data.requested_count || 0;
           let executed_count = 0;
           let passed_count = 0;
           let failed_count = 0;
           let skipped_count = 0;
           for (const [scenarioName, status] of Object.entries(aggregatedExecResult.scenario_status)) {
             if (status === 'PASS') { passed_count++; executed_count++; }
             else if (status === 'FAIL') { failed_count++; executed_count++; }
             else if (status === 'IN_PROGRESS') { failed_count++; executed_count++; } 
             else if (status === 'SKIPPED' || status === 'NOT_STARTED') { skipped_count++; }
           }
           finalMetadata = JSON.stringify({
              testCases: job.data.testCases || 'N/A',
              scenario_status: aggregatedExecResult.scenario_status,
              metrics: { requested_count, executed_count, passed_count, failed_count, skipped_count }
           });
        }
        
        if (nextStatus === 'BLOCKED') {
          let classification = { vendor: "unknown", type: "unknown" };
          try {
            const match = err.message.match(/BlockedByAntiBotError:\s*(\{.*?\})/);
            if (match && match[1]) {
              classification = JSON.parse(match[1]);
            }
          } catch(e) {}
          finalMetadata += `\n\nExecution mode: stealth\nProtection detected: ${classification.vendor} - ${classification.type}`;
        }

        // Distinguish "script generation never produced an executable plan" from
        // "plan was fine but Playwright execution failed" so the report reflects the
        // real execution state instead of guessing from the error string.
        const genFailedError = /PARTIAL_SCRIPT_GENERATION_RESPONSE|SCRIPT_GENERATION_FAILED|EMPTY_SCENARIO_ACTIONS|MISSING_REQUIRED_CREDENTIAL_ACTIONS|DeterministicSchemaValidationError|Strict scenario generation failed|Validation Gate Failed|Orchestrator failed to plan/i.test(err.message || '');
        const playwrightRan = !!(aggregatedExecResult && aggregatedExecResult.scenario_status && Object.keys(aggregatedExecResult.scenario_status).length > 0);
        const failScriptGenerationStatus = (genFailedError && !playwrightRan) ? 'FAILED' : 'SUCCESS';
        const failPlaywrightExecutionStatus = playwrightRan ? 'STARTED' : 'NOT_STARTED';

        try {
          const reportRes = await reportAgent.generateReport(executionId, {
            testName,
            status: nextStatus,
            scriptGenerationStatus: failScriptGenerationStatus,
            playwrightExecutionStatus: failPlaywrightExecutionStatus,
            error: err.message,
            duration: durationMs / 1000,
            browser: job.data.browser || 'chromium',
            environment: process.env.NODE_ENV || 'Local',
            url: job.data.targetUrl,
            logs: logs.join('\n'),
            testMetadata: finalMetadata,
            executedSteps: JSON.stringify(finalStepLogs),
            screenshotUrl: aggregatedExecResult?.screenshotUrl || null,
            videoUrl: aggregatedExecResult?.videoUrl || null,
            executionType: job.data.mode === 'API' ? 'API' : 'WEB'
          });
          if (reportRes && reportRes.content) {
            generatedReportContent = (reportRes.content as any).markdown_report || JSON.stringify(reportRes.content, null, 2);
          }
          if (reportRes && reportRes.url) {
            await supabase.from('Report').insert({
              executionLogId: executionId,
              url: reportRes.url,
              storagePath: `reports/${executionId}.json`
            }).then(({ error }) => { if (error) logMsg(`Failed to save report to DB: ${error.message}`); });
          }
        } catch (reportErr) {
          logMsg(`[Error] Failed to generate failure report: ${reportErr}`);
        }

        await supabase.from('ExecutionLog').update({
          status: nextStatus,
          completedAt: new Date().toISOString(),
          durationMs,
          logs: JSON.stringify(logs),
          stepLogs: JSON.stringify(finalStepLogs),
          traceData: JSON.stringify(finalStepLogs),
          planData: job.data.planData || null
        }).eq('id', executionId);
        
        if (nextStatus === 'FAILED' || nextStatus === 'BLOCKED') {
           throw err; // Ensure BullMQ properly marks the job as failed
        }
      } finally {
        // Lock remains in Redis for 5 minutes to prevent ghost retries
        logMsg('[Telemetry] VIDEO_FLUSH_STARTED');
        let videoPath = '';
        if (sharedPage) {
          try {
            const video = sharedPage.video();

            // Stop the live screencast before tearing the page down (no-op if the
            // success path already stopped it).
            if (stopLiveView) { await stopLiveView().catch(() => {}); stopLiveView = null; }

            // Persist any challenge-clearance session BEFORE the context is torn
            // down (no-op if the success path already did it).
            await persistClearanceSession('run ended');

            // Explicitly wait for browser context to close FIRST to force flush
            if (sharedContext) {
               await sharedContext.close().catch(() => {});
               logMsg('[Telemetry] BROWSER_CONTEXT_CLOSED');
            }
            if (sharedBrowser) {
               await sharedBrowser.close().catch(() => {});
               logMsg('[Telemetry] BROWSER_INSTANCE_CLOSED');
            }
            
            logMsg('[Telemetry] VIDEO_RECORDING_STOPPED');
            if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_VIDEO_RECORDING_STOPPED');
            
            if (video) {
              videoPath = await video.path().catch(() => '');
              if (videoPath) logMsg('[Video] VIDEO_PATH_RESOLVED');
            }
            
            if (videoPath && fsSync.existsSync(videoPath)) {
              let isReadable = false;
              try {
                fsSync.accessSync(videoPath, fsSync.constants.R_OK);
                isReadable = true;
              } catch(e) {}
              
              const stats = fsSync.statSync(videoPath);
              if (stats.size > 5120 && isReadable) { // Require > 5KB to prevent corrupt ghosts
                logMsg('[Telemetry] VIDEO_FILE_SIZE_VALIDATED');
                logMsg('[Video] VIDEO_SAVED locally. Uploading...');
                
                // Post-process with FFmpeg to remove static LLM processing frames
                const compressedPath = videoPath.replace('.webm', '_compressed.webm');
                try {
                  const { exec } = require('child_process');
                  const util = require('util');
                  const execPromise = util.promisify(exec);
                  const ffmpegBin = resolveFfmpegPath();
                  logMsg(`[Video] Compressing video to remove static LLM wait times (using ${ffmpegBin})...`);
                  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('FFmpeg timeout')), 30000));
                  await Promise.race([
                    execPromise(`"${ffmpegBin}" -y -i "${videoPath}" -vf "mpdecimate,setpts=N/FRAME_RATE/TB" "${compressedPath}"`),
                    timeoutPromise
                  ]);
                  if (fsSync.existsSync(compressedPath) && fsSync.statSync(compressedPath).size > 0) {
                     fsSync.copyFileSync(compressedPath, videoPath);
                     logMsg('[Video] Compression successful');
                  } else {
                     logMsg('[Video] FFmpeg ran but produced no compressed output, keeping original video.');
                  }
                } catch (ffmpegErr: any) {
                  logMsg(`[Video] FFmpeg compression failed, falling back to original video: ${ffmpegErr?.message || ffmpegErr}`);
                }

                const videoData = await fs.readFile(videoPath);
                const { data, error } = await supabase.storage
                  .from('videos')
                  .upload(`${executionId}.webm`, videoData, { contentType: 'video/webm', upsert: true });
                
                if (!error && data) {
                  const { data: publicData } = supabase.storage.from('videos').getPublicUrl(data.path);
                  if (publicData && publicData.publicUrl) {
                      await supabase.from('Video').insert({ executionLogId: executionId, url: publicData.publicUrl, storagePath: `videos/${executionId}.webm` });
                      logMsg('[Telemetry] VIDEO_UPLOAD_VERIFIED');
                      logMsg('[Telemetry] VIDEO_ARTIFACT_PERSISTED');
                      if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_VIDEO_ARTIFACT_PERSISTED');
                  } else {
                      logMsg(`[Video] ERROR VIDEO_CORRUPT: URL missing`);
                      throw new Error('VIDEO_ARTIFACT_INVALID: publicUrl not returned');
                  }
                } else {
                  logMsg(`[Video] ERROR VIDEO_CORRUPT: Upload failed ${error?.message}`);
                  throw new Error('VIDEO_ARTIFACT_INVALID: upload failed');
                }
              } else {
                logMsg(`[Video] ERROR VIDEO_CORRUPT: file empty or unreadable (size=${stats.size})`);
                throw new Error('VIDEO_ARTIFACT_INVALID: size too small');
              }
            } else {
              logMsg('[Video] ERROR VIDEO_CORRUPT: no file');
              throw new Error('VIDEO_ARTIFACT_INVALID: no file generated');
            }
          } catch (e: any) {
            console.error("Video processing failed during error recovery", e);
            logMsg(`[Video] ERROR VIDEO_CORRUPT: exception ${e.message}`);
          }
        }
        
        // Fetch the very latest status from DB before emitting completed
        const { data: finalDbState } = await supabase
           .from('ExecutionLog')
           .select('*, suite:TestSuite(*)')
           .eq('id', executionId)
           .maybeSingle();

        logMsg('[Telemetry] FULL_EXECUTION_COMPLETED');
        logMsg('[Telemetry] WORKER_RESOURCES_RELEASED');
        logMsg('[Telemetry] EXECUTION_TERMINATED');

        if (finalDbState) {
           if (finalDbState.status === 'FAILED' && job.data.features?.autoJira) {
             try {
               const { data: jiraIntegration } = await supabase
                 .from('JiraIntegration')
                 .select('*')
                 .eq('projectId', finalDbState.suite.projectId)
                 .maybeSingle();
                             const envUrl = process.env.JIRA_BASE_URL;
                 const envEmail = process.env.JIRA_EMAIL;
                 const envToken = process.env.JIRA_API_TOKEN;
                 const envProject = process.env.JIRA_PROJECT_KEY;

                 const useDb = jiraIntegration && jiraIntegration.isActive;
                 const useEnv = !useDb && envUrl && envEmail && envToken && envProject;

                 if (useDb || useEnv) {
                   logMsg('[Jira] Auto-creating Jira bug for assertion failures...');
                 const jiraService = new JiraService(
                   useDb ? jiraIntegration.baseUrl : envUrl!,
                   useDb ? jiraIntegration.email : envEmail!,
                   useDb ? jiraIntegration.apiToken : envToken!,
                   useDb ? jiraIntegration.projectKey : envProject!,
                   useDb ? jiraIntegration.issueType : 'Bug'
                 );
                 
                 // Extract error details from logs if possible
                 let errorMsg = 'Execution failed. Check traces for more info.';
                 const errMatch = finalDbState.logs?.match(/\[Error\] (.*)/);
                 if (errMatch && errMatch[1]) {
                   errorMsg = errMatch[1];
                 }
                 
                 let failureType = 'Application Failure';
                 const errLower = errorMsg.toLowerCase();
                 if (errLower.includes('malformed step') || errLower.includes('invalidactiontargeterror') || errLower.includes('page_context_mismatch') || errLower.includes('execution context was destroyed') || errLower.includes('blockedbyantiboterror')) {
                     failureType = 'Framework Failure';
                 }

                 const summary = `[NovaTest AI] [${failureType}] ${testName} failed on ${finalDbState.browser || 'Chromium'}`;
                 
                 const description = `
Autonomous QA Test Execution Failed

*Failure Category:* ${failureType}
*Execution ID:* ${executionId}
*Target URL:* ${job.data.targetUrl || 'N/A'}
*Browser:* ${finalDbState.browser || 'chromium'}

*Error Details:*
${errorMsg}
                 `.trim();
                 
                 try {
                   const issue = await jiraService.createIssue(summary, description);
                   if (issue) {
                     logMsg(`[Jira] Successfully created issue: ${issue.key}`);
                     logMsg('[Telemetry] JIRA_ISSUE_CREATED');
                     
                     let attachmentCount = 0;
                     const attachLocalFile = async (filePath: string, filename: string) => {
                       if (fsSync.existsSync(filePath)) {
                         const success = await jiraService.attachFile(issue.key, filePath, filename);
                         if (success) {
                           attachmentCount++;
                           logMsg(`[Telemetry] JIRA_ATTACHMENT_UPLOADED: ${filename}`);
                         } else {
                           logMsg(`[Telemetry] JIRA_ATTACHMENT_FAILED: ${filename}`);
                         }
                       }
                     };
                     
                     // 1. Video
                     if (videoPath) await attachLocalFile(videoPath, 'execution.mp4');
                     
                     // 2. Screenshot
                     const screenshotPath = (await import('path')).resolve(process.cwd(), 'temp', 'screenshots', `${executionId}.png`);
                     await attachLocalFile(screenshotPath, 'screenshot.png');
                     
                     // 3. Transcript & 4. Trace & 5. Stacktrace
                     const tempDir = (await import('path')).resolve(process.cwd(), 'temp', 'artifacts', executionId);
                     await fs.mkdir(tempDir, { recursive: true }).catch(() => {});
                     
                     const transcriptPath = (await import('path')).join(tempDir, 'transcript.log');
                     const tracePath = (await import('path')).join(tempDir, 'trace.json');
                     const stacktracePath = (await import('path')).join(tempDir, 'stacktrace.txt');
                     const reportPath = (await import('path')).join(tempDir, 'execution-report.md');
                     
                     let transcriptEventsStr = '[]';
                     try {
                       const execResLog = finalStepLogs.find(l => l.action === 'EXECUTION_RESULT');
                       if (execResLog && execResLog.value) {
                         const parsedVal = typeof execResLog.value === 'string' ? JSON.parse(execResLog.value) : execResLog.value;
                         transcriptEventsStr = JSON.stringify(parsedVal.transcript || [], null, 2);
                       }
                     } catch(e) {}
                     await fs.writeFile(transcriptPath, transcriptEventsStr).catch(() => {});
                     await attachLocalFile(transcriptPath, 'transcript.log');
                     
                     await fs.writeFile(tracePath, JSON.stringify(finalStepLogs, null, 2)).catch(() => {});
                     await attachLocalFile(tracePath, 'trace.json');
                     if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_TRACE_ARTIFACT_PERSISTED');
                     
                     await fs.writeFile(stacktracePath, errorMsg + '\n\n' + (finalDbState.logs || '')).catch(() => {});
                     await attachLocalFile(stacktracePath, 'stacktrace.txt');
                     
                     if (generatedReportContent) {
                       await fs.writeFile(reportPath, generatedReportContent).catch(() => {});
                       await attachLocalFile(reportPath, 'execution-report.md');
                     }
                     
                     logMsg('[Telemetry] JIRA_SYNC_COMPLETED');
                     await supabase.from('ExecutionLog').update({
                       jiraTicketId: issue.key,
                       jiraTicketUrl: issue.url,
                       jiraAttachmentCount: attachmentCount,
                       jiraSyncTimestamp: new Date().toISOString()
                     }).eq('id', executionId);
                   } else {
                     logMsg('[Jira] Failed to create issue via API');
                     logMsg('[Telemetry] JIRA_SYNC_FAILED');
                   }
                 } catch(errJira: any) {
                   logMsg(`[Jira] Error during sync: ${errJira.message}`);
                   logMsg('[Telemetry] JIRA_SYNC_FAILED');
                 }
               }
             } catch (jiraErr: any) {
               logMsg(`[Jira] Integration error: ${jiraErr.message}`);
             }
           }

           emit('execution_completed', { 
             executionId, 
             status: finalDbState.status, 
             durationMs: finalDbState.durationMs || 0
             // Note: frontend only uses status and durationMs
           });
           if (job.data.mode === 'EXCEL') logMsg('[Telemetry] EXCEL_RESULT_PERSISTED');
        }
      }
    },
    { 
      connection: redisConnection, 
      concurrency: 4,
      lockDuration: 5 * 60 * 1000
    }
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id || 'unknown'} failed with error: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`BullMQ Worker Error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed with error:`, err.message);
  });

  return worker;
};
