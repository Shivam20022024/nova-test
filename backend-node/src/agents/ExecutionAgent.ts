import { chromium, firefox, webkit, Browser } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import { getModel } from './llm';
import { sanitizeExecutionPlan, resolveSelector } from '../utils/sanitizer';
import { ScriptGenerationAgent } from './ScriptGenerationAgent';
import { extractCompactDom } from './DiscoveryAgent';
import { validateSelector as validateSelectorDOM } from './selectorValidator';
import { supabase } from '../utils/storage'; // Assumes storage.ts exports a configured Supabase client
import { ChallengeSolverAgent } from './ChallengeSolverAgent';
import { humanMoveToLocator, humanType, warmUp } from '../utils/humanize';
import { detectAntiBotInterstitial } from '../utils/antiBotInterstitial';
import { findDeterministicFallback } from '../utils/selectorFallback';
import { checkProtectedAction } from '../utils/protectedActions';
import { pickBestMatch } from '../utils/elementRanking';
import { isCustomDropdown, chooseCustomOption } from '../utils/customDropdown';
import { dismissBlockingOverlay, dismissBlockingOverlayForStep } from '../utils/overlayDismiss';
import { extractIntentPhrases, checkIntentPhrases, isConditionalIntent, isNegatedIntent, checkPhrasesAbsent } from '../utils/assertionIntent';

// Failure screenshots are saved per failure. Step numbers restart for every scenario, so the file name also
// carries a running per-execution counter; otherwise each scenario's failure overwrote the previous one.
const failShotCounters = new Map<string, number>();
function nextFailShot(executionId: string): number {
  const n = (failShotCounters.get(executionId) || 0) + 1;
  failShotCounters.set(executionId, n);
  return n;
}

export class ExecutionAgent {
  async executeScript(
    executionId: string, 
    scriptCode: string, 
    browserName: string = 'chromium',
    emitLog: (type: string, message: string) => void,
    options: { accessibility?: boolean; security?: boolean; sharedPage?: any; testCases?: any[]; [key: string]: any } = {},
    emitFrame?: (frame: string) => void
  ) {
    let browser: any;
    let context: any;
    let page: any;

    // Anti-bot Phase 4/5 knobs (default off => unchanged behaviour).
    const humanize: boolean = !!options.humanize;
    const solver = options.solver;
    const challengeSolver = new ChallengeSolverAgent(emitLog);
    let warmedUp = false;

    if (options.sharedPage) {
      page = options.sharedPage;
      context = page.context();
      browser = context.browser();
      
      const contextId = (context as any)._guid || 'unknown-context';
      const pageId = (page as any)._guid || 'unknown-page';
      
      emitLog('browser_launch', `Using shared browser context for execution. EXECUTION_CONTEXT_ID: ${contextId}, EXECUTION_PAGE_ID: ${pageId}`);
    } else {
      emitLog('browser_launch', `Launching ${browserName} browser`);
      const browserNameLower = browserName.toLowerCase();
      if (browserNameLower === 'firefox') {
        browser = await firefox.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'] });
      } else if (browserNameLower === 'webkit' || browserNameLower === 'safari') {
        browser = await webkit.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'] });
      } else if (browserNameLower === 'edge' || browserNameLower === 'msedge') {
        browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'] });
      } else {
        browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'] });
      }

      const videoDir = `./temp/videos/${executionId}`;
      const screenshotDir = './temp/screenshots';
      await fs.mkdir(videoDir, { recursive: true });
      await fs.mkdir(screenshotDir, { recursive: true });

      context = await browser.newContext({
        recordVideo: {
          dir: videoDir,
          size: { width: 1280, height: 720 }
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280 + Math.floor(Math.random() * 100), height: 720 + Math.floor(Math.random() * 100) }
      });

      await context.addInitScript(() => {
        // WebDriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        
        // Plugins
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        
        // Hardware
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        
        // Chrome
        (window as any).chrome = { runtime: {} };
        
        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) => (
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters)
        );

        // WebGL
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.apply(this, [parameter]);
        };
      });

      page = await context.newPage();
    }
    
    page.on('console', (msg: any) => emitLog('browser_log', `Console [${msg.type()}]: ${msg.text()}`));
    page.on('pageerror', (error: any) => emitLog('browser_log', `Page Error: ${error.message}`));

    // JS dialog handling (alert/confirm/prompt). With no listener at all,
    // Playwright auto-dismisses these on its own — so a test written before
    // this existed already saw dialogs silently go away, and dismiss stays
    // the default below. This only adds the ability for a step to arm the
    // NEXT dialog to be accepted (optionally with typed text) via the new
    // `handleDialog` action, for tests that need to interact with one on
    // purpose.
    let pendingDialogAction: { accept: boolean; promptText?: string } | null = null;
    page.on('dialog', async (dialog: any) => {
      const instruction = pendingDialogAction;
      pendingDialogAction = null;
      emitLog('browser_log', `JS dialog appeared [${dialog.type()}]: ${dialog.message()}`);
      try {
        if (instruction && instruction.accept) {
          await dialog.accept(instruction.promptText);
        } else {
          await dialog.dismiss();
        }
      } catch (e) {
        // Dialog may already have been handled/closed — not fatal.
      }
    });

    let screenshotUrl: string | null = null;
    let videoUrl: string | null = null;
    let success = false;
    let executionError: string | null = null;
    let stepLogs: Array<{ action: string, status: string, time: string, durationMs?: number, details?: string, value?: string, rawSelector?: string }> = [];
    let accessibilityResults: any = null;
    let securityResults: any = null;

    // Per-scenario tally of verification steps, so a scenario whose checks never actually ran
    // (all skipped/unresolved) is not reported as passed.
    let currentScenarioName: string | undefined;
    const assertionTally: Record<string, { passed: number; skipped: number; failed: number }> = {};
    const addStep = (action: string, status: string, durationMs?: number, details?: string, value?: string, rawSelector?: string) => {
      if (currentScenarioName && /^assert/i.test(action)) {
        const t = (assertionTally[currentScenarioName] ||= { passed: 0, skipped: 0, failed: 0 });
        if (status === 'PASSED') t.passed++;
        else if (status === 'SKIPPED') t.skipped++;
        else if (status === 'FAILED') t.failed++;
      }
      const step: any = { action, status, time: new Date().toISOString() };
      // Stamp every step with its scenario so reports can group by scenario even when the run is cut
      // short and the final per-scenario summary is missing.
      if (currentScenarioName) step.scenarioName = currentScenarioName;
      if (durationMs !== undefined) step.durationMs = durationMs;
      if (details !== undefined) step.details = details;
      if (value !== undefined) step.value = value;
      if (rawSelector !== undefined) step.rawSelector = rawSelector;
      stepLogs.push(step);
    };

    let transcriptEvents: any[] = [];
    const logTranscriptEvent = (actionType: string, target: string, value: string | undefined, status: string, scenarioName?: string) => {
        transcriptEvents.push({
            action: actionType, target, value, status, scenarioName, timestamp: new Date().toISOString()
        });
    };

    let frameInterval: NodeJS.Timeout | null = null;
    if (emitFrame) {
      frameInterval = setInterval(async () => {
        try {
          if (!page.isClosed()) {
            const frameBuffer = await page.screenshot({
              type: "jpeg",
              quality: 50
            });
            emitFrame(frameBuffer.toString('base64'));
          }
        } catch (e) {
          // Ignore errors during screenshot, e.g. target closed
        }
      }, 1000);
    }
    let scenario_status: Record<string, string> = {};

    try {
      emitLog('executing', 'Running generated script');
      
      const { SelfHealingAgent } = await import('./SelfHealingAgent');
      const healingAgent = new SelfHealingAgent();
      
      if (options.security) {
        emitLog('agent_log', 'Running SecuritySanityAgent checks...');
        const { SecuritySanityAgent } = await import('./SecuritySanityAgent');
        const securityAgent = new SecuritySanityAgent();
        // Wait for page to initially load something to check headers/mixed content
      }

      scriptCode = sanitizeExecutionPlan(scriptCode, (msg) => emitLog('agent_log', msg));
      const actions = JSON.parse(scriptCode);
      addStep('PARSE_JSON', 'PASSED', 0, `Parsed ${actions.length} actions`);
      
      if (options.testCases && Array.isArray(options.testCases)) {
         options.testCases.forEach((tc: any) => {
           if (tc.scenarioName) {
              scenario_status[tc.scenarioName] = 'NOT_STARTED';
           }
         });
      }
      
      actions.forEach((action: any) => {
         if (action.scenarioName && !scenario_status[action.scenarioName]) {
            scenario_status[action.scenarioName] = 'NOT_STARTED';
         }
      });
      
      const validActions = ['goto', 'fill', 'click', 'assertVisible', 'assertText', 'select', 'hover', 'wait', 'screenshot', 'consoleCapture', 'log', 'dragAndDrop', 'handleDialog'];
      for (let i = 0; i < actions.length; i++) {
        if (!actions[i].action && actions[i].type) {
          actions[i].action = actions[i].type;
        }
        if (!actions[i].action) {
           console.warn(`Malformed step at index ${i}: missing "action" property.`);
           actions[i] = { action: 'log', message: `SKIPPED: Missing action property. Keys: ${Object.keys(actions[i]).join(', ')}` };
           continue;
        }
        if (actions[i].action === 'goto') {
           if (!actions[i].url) {
              console.warn(`Malformed step at index ${i}: "goto" action missing "url"`);
              actions[i] = { action: 'log', message: `SKIPPED: goto missing url` };
              continue;
           }
           try { 
              new URL(actions[i].url); 
           } catch (e) { 
              if (options.targetUrl) {
                 try {
                    actions[i].url = new URL(actions[i].url, options.targetUrl).href;
                 } catch (e2) {
                    console.warn(`Malformed step at index ${i}: invalid URL "${actions[i].url}"`);
                    actions[i] = { action: 'log', message: `SKIPPED: invalid URL "${actions[i].url}"` };
                    continue;
                 }
              } else {
                 console.warn(`Malformed step at index ${i}: invalid URL "${actions[i].url}"`); 
                 actions[i] = { action: 'log', message: `SKIPPED: invalid URL "${actions[i].url}"` };
                 continue;
              }
           }
        }
        if (['click', 'fill', 'select', 'dragAndDrop'].includes(actions[i].action) && !actions[i].selector) {
           console.warn(`Malformed step at index ${i}: action "${actions[i].action}" missing "selector"`);
           actions[i] = { action: 'log', message: `SKIPPED: action "${actions[i].action}" missing selector` };
           continue;
        }
      }
      
      if (actions.length === 0) {
         throw new Error(`Execution plan validation failed: 0 steps generated.`);
      }
      let finalAttemptSuccess = false;
      for (let recoveryAttempt = 1; recoveryAttempt <= 3; recoveryAttempt++) {
        if (recoveryAttempt > 1) {
           emitLog('agent_log', `[Recovery Strategy] Initiating execution retry attempt ${recoveryAttempt}/3 on existing page without destroying session...`);
           await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        
        const injectHumanSimulation = recoveryAttempt >= 2;
        const injectSlowCrawl = recoveryAttempt >= 3;
        let scriptBlocked = false;
        stepLogs = []; // Reset logs for fresh attempt
        let failedScenarios = new Set<string>();
        let skippedScenarios = new Set<string>();
        // Scenarios run back-to-back on one shared page (continuous session).
        // Once a scenario fails, the browser is left in an unknown state; a
        // later scenario that has no navigation of its own cannot reach its
        // required starting page, so its steps would run against the wrong DOM
        // and report a misleading FAIL. Track this so such scenarios are SKIPPED
        // (blocked by upstream) instead — without injecting navigation or
        // resetting browser state.
        let chainCompromised = false;

      for (const action of actions) {
         currentScenarioName = action.scenarioName || currentScenarioName;
         if (action.scenarioName) {
            if (failedScenarios.has(action.scenarioName) || skippedScenarios.has(action.scenarioName)) {
               continue;
            }
            if (scenario_status[action.scenarioName] === 'NOT_STARTED') {
               const scenarioActions = actions.filter((a: any) => a.scenarioName === action.scenarioName);
               const hasOwnNavigation = scenarioActions.some((a: any) => a.action === 'goto' && a.url);
               if (chainCompromised && !hasOwnNavigation) {
                  // PAGE_STATE_ERROR: a preceding scenario failed and this one
                  // has no navigation to re-establish its required starting
                  // state. Do NOT run its steps against an unknown page.
                  scenario_status[action.scenarioName] = 'SKIPPED';
                  skippedScenarios.add(action.scenarioName);
                  emitLog('agent_log', `[Scenario State] SKIPPING scenario "${action.scenarioName}" — a preceding scenario failed and left the browser in an unknown state; this scenario has no navigation of its own to reach its required starting page. Not executing its steps against the wrong page.`);
                  emitLog('telemetry', `SCENARIO_SKIPPED=${action.scenarioName}`);
                  addStep('SCENARIO_SKIPPED', 'SKIPPED', 0, `${action.scenarioName}: blocked by upstream scenario failure — required starting state was not established`, undefined, undefined);
                  logTranscriptEvent('scenario', '', 'Blocked by upstream scenario failure — required starting page/state was not established', 'SKIPPED', action.scenarioName);
                  continue;
               }
               if (hasOwnNavigation) {
                  // This scenario re-establishes its own state; treat the chain
                  // as recovered for it and everything after it.
                  chainCompromised = false;
               }
               scenario_status[action.scenarioName] = 'IN_PROGRESS';
            }
         }
         
        const startTime = Date.now();
        emitLog('executing', `Executing action: ${action.action}`);
        emitLog('telemetry', `ACTION_STARTED=${action.action}`);
        if (action.selector) {
           emitLog('telemetry', `TRACE_ACTION_TARGET=${action.selector}`);
        }
        
        let attempts = 0;
        let successAction = false;
        let isUnsupported = false;
        let skipReason: string | undefined;
        // What NovaTest did on its own for this step (chose among duplicates, dismissed a dialog, used a
        // fallback...). Appended to the step details so the report is its own audit trail.
        let stepNote = '';
        const noteStep = (m: string) => { stepNote += (stepNote ? '; ' : '') + m; emitLog('agent_log', m); };
        let details = action.selector || action.url || '';
        
        action.selector = resolveSelector(action.selector);
        
        // `all` returns every match instead of only the first (used to detect ambiguity).
        const getPlaywrightLocator = (page: any, sel: string, all: boolean = false) => {
          if (!sel) return null;
          const pickOne = (l: any) => (all ? l : l.first());
          // Frame targeting: when a step sets `frameSelector`, resolve
          // against that iframe's content instead of the top-level page.
          // Absent frameSelector (every existing test/action), `root` is
          // just `page` — identical to before this existed.
          //
          // Shadow DOM note: Playwright's locator engines already pierce
          // OPEN shadow roots on their own, so `root.locator(sel)` below
          // works inside an open shadow tree with no special handling
          // needed. A CLOSED shadow root is a browser-level lock nothing
          // (Playwright or otherwise) can open from outside — a genuine
          // limitation, not a gap in this code.
          const root = action.frameSelector ? page.frameLocator(action.frameSelector) : page;
          if (sel.startsWith('locator(') || sel.startsWith('getByRole(') || sel.startsWith('getByLabel(') || sel.startsWith('getByTestId(') || sel.startsWith('getByText(') || sel.startsWith('getByPlaceholder(')) {
             try {
               return pickOne(new Function('page', `return page.${sel}`)(root));
             } catch (e: any) {
               if (e instanceof SyntaxError && e.message.includes('Invalid regular expression')) {
                  let sanitizedSel = sel;
                  sanitizedSel = sanitizedSel.replace(/\/([^\/]+)\/([a-z]*)/g, (match, pattern, flags) => {
                     try {
                        new RegExp(pattern, flags);
                        return match; // valid regex
                     } catch (err) {
                        // invalid regex, convert to literal string
                        const literal = pattern.replace(/'/g, "\\'");
                        return `'${literal}'`;
                     }
                  });
                  if (sanitizedSel !== sel) {
                     try {
                        return pickOne(new Function('page', `return page.${sanitizedSel}`)(root));
                     } catch (e2) {
                        console.warn(`[ExecutionAgent] Failed evaluating sanitized Playwright selector ${sanitizedSel}`, e2);
                     }
                  }
               }
               console.warn(`[ExecutionAgent] Failed evaluating Playwright selector ${sel}`, e);
             }
          }
          return pickOne(root.locator(sel));
        };
        
        const rawSelector = action.selector || action.url;
        
        if (action.action === 'goto') details = `Navigating to ${action.url}`;
        else if (action.action === 'click') details = `Clicking element: ${action.selector}`;
        else if (action.action === 'fill') details = `Filling input: ${action.selector}`;
        else if (action.action === 'assertText') details = `Asserting text "${action.contains}" in ${action.selector}`;
        else if (action.action === 'assertVisible') details = `Asserting visibility of ${action.selector}`;
        else if (action.action === 'select') details = `Selecting option in ${action.selector}`;
        else if (action.action === 'hover') details = `Hovering over ${action.selector}`;
        else if (action.action === 'dragAndDrop') details = `Dragging ${action.selector} to ${action.targetSelector || action.destinationSelector}`;
        else if (action.action === 'handleDialog') details = `Arming next JS dialog handler`;
        else if (action.action === 'wait') details = action.state === 'domcontentloaded' ? 'Waiting for DOMContentLoaded' : `Waiting for ${action.timeout || action.value || 1000}ms`;
        else if (action.action === 'screenshot') details = `Taking screenshot`;
        else if (action.action === 'consoleCapture') details = `Capturing console logs`;
        
        const timeouts = [5000, 10000, 20000];
        while (!successAction && attempts < 3) {
          // Checks fail fast: waiting 5s, then 10s, then 20s for an element that is not there only makes
          // runs slow (the page either has it or it does not). Interactions keep the longer ladder.
          const currentTimeout = action.action.startsWith('assert')
            ? Math.min(timeouts[attempts] || 5000, 4000)
            : (timeouts[attempts] || 5000);
          
          const waitForLocatorAttached = async (loc: any, sel: string) => {
            if (!loc) {
               throw new Error(`Selector resolution failed: provided selector "${sel}" was null or invalid.`);
            }
            try {
              await loc.waitFor({ state: 'attached', timeout: currentTimeout });
            } catch (e) {}
            if (await loc.count() === 0) {
              throw new Error(`Selector not found in DOM: ${sel}`);
            }
          };

          const runDomValidation = async (sel: string) => {
             if (!sel || sel === 'null') return;
             try {
                await page.waitForLoadState('networkidle', { timeout: 1500 });
             } catch (e) {}
             await page.waitForTimeout(250);

             const currentUrl = page.url();
             const currentDomSnapshot = await page.evaluate(() => document.body.innerHTML);
             
             emitLog('agent_log', `[LIVE_DOM_REFRESH]\nscenario=${action.scenarioName}\nstep=${action.action}\nurl=${currentUrl}\ndomSize=${currentDomSnapshot.length}`);
             
             const validation = validateSelectorDOM(sel, currentDomSnapshot);
             emitLog('agent_log', `[SELECTOR_VALIDATION]\nselector=${sel}\ndomContainsSelector=${validation.valid}`);
             
             if (!validation.valid) {
                 if (!action || !action.selector || action.selector === 'null' || !actions || actions.length === 0) {
                     emitLog('agent_log', `[SELECTOR_VALIDATION_FAILED] Guard: Invalid action or empty selector. Skipping regeneration.`);
                     throw new Error(`INVALID SELECTOR: ${validation.reason}`);
                 }
                 // Cheap, deterministic repair first: probe the live page for the obvious real
                 // element (type=email, matching label/placeholder, button/link by name). Only
                 // if nothing real matches do we spend an LLM call on a regenerated selector.
                 // The page may simply not have finished rendering yet (slow single-page app under
                 // load), so keep probing for a short while before concluding the element is absent.
                 let fallbackSel: string | null = null;
                 const fallbackDeadline = Date.now() + 20000;
                 do {
                     fallbackSel = await findDeterministicFallback(page, sel, action.action, getPlaywrightLocator);
                     if (fallbackSel) break;
                     await page.waitForTimeout(1000);
                 } while (Date.now() < fallbackDeadline);
                 if (fallbackSel) {
                     emitLog('agent_log', `[DETERMINISTIC_FALLBACK]\nfailed=${sel}\nuse=${fallbackSel}`);
                     stepNote += (stepNote ? '; ' : '') + `[Fallback] ${sel} not found; used ${fallbackSel}`;
                     action.selector = fallbackSel;
                     emitLog('agent_log', `[VALIDATED_SELECTOR_EXECUTION]\nselector=${fallbackSel}`);
                     return;
                 }
                 emitLog('agent_log', `[SELECTOR_GENERATION_HALLUCINATION]\nselector=${sel}\nreason=Attribute not found in current DOM`);
                 emitLog('agent_log', `[DOM_SELECTOR_GENERATION]\nscenario=${action.scenarioName}\nstep=${action.action}\nintent=${action.assertion || action.selector}\ncurrentUrl=${currentUrl}\ndomSize=${currentDomSnapshot.length}`);
                 
                 const compactDomObj = await extractCompactDom(page);
                 const compactDomString = JSON.stringify(compactDomObj, null, 2);
                 
                 const scriptGenAgent = new ScriptGenerationAgent(executionId);
                 const regenerated = await scriptGenAgent.regenerateSelector(action.assertion || action.selector || '', action.action, compactDomString);
                 emitLog('agent_log', `[GENERATED_SELECTOR]\nintent=${action.assertion || action.selector}\nselector=${regenerated}`);
                 
                 if (regenerated) {
                     const reValidation = validateSelectorDOM(regenerated, currentDomSnapshot);
                     emitLog('agent_log', `[SELECTOR_VALIDATION]\nselector=${regenerated}\nvalid=${reValidation.valid}\nreason=${reValidation.reason || 'N/A'}`);
                     if (reValidation.valid) {
                         action.selector = regenerated;
                         sel = regenerated;
                     } else {
                         emitLog('agent_log', `[SELECTOR_VALIDATION_FAILED]\nselector=${sel}\nreason=${validation.reason}\ncurrentUrl=${currentUrl}\ndomSize=${currentDomSnapshot.length}`);
                         throw new Error(`INVALID SELECTOR: ${validation.reason}`);
                     }
                 } else {
                     emitLog('agent_log', `[SELECTOR_VALIDATION_FAILED]\nselector=${sel}\nreason=${validation.reason}\ncurrentUrl=${currentUrl}\ndomSize=${currentDomSnapshot.length}`);
                     throw new Error(`INVALID SELECTOR: ${validation.reason}`);
                 }
             }
             emitLog('agent_log', `[VALIDATED_SELECTOR_EXECUTION]\nselector=${sel}`);
          };

          const checkForAntiBot = async () => {
             const { light: isLightweight, hard: isHardBlock } = await detectAntiBotInterstitial(page);

             if (isLightweight) {
                emitLog('agent_log', 'Detected lightweight JS challenge. Waiting 7 seconds to resolve...');
                await page.waitForTimeout(7000);
                const recheckContent = await page.content().catch(() => '');
                if (recheckContent.toLowerCase().includes('just a moment...') || page.url().includes('challenges.cloudflare.com')) {
                   // Phase 5: give the challenge solver a chance before giving up.
                   const cleared = await challengeSolver.maybeSolve(page, solver).catch(() => false);
                   if (!cleared) throw new Error('BlockedByAntiBotError: {"vendor":"cloudflare","type":"js_challenge_timeout"}');
                   emitLog('agent_log', '[AntiBot] Challenge cleared; continuing execution.');
                }
             } else if (isHardBlock) {
                const cleared = await challengeSolver.maybeSolve(page, solver).catch(() => false);
                if (!cleared) throw new Error('BlockedByAntiBotError: {"vendor":"cloudflare","type":"browser_challenge"}');
                emitLog('agent_log', '[AntiBot] Challenge cleared; continuing execution.');
             }
          };
          
          try {
            if (['click', 'fill', 'select', 'check', 'assertText', 'assertVisible', 'assertEnabled', 'assertDisabled', 'hover'].includes(action.action)) {
               await checkForAntiBot();
               // Clear an informational dialog (welcome tour, notice) BEFORE locating the target: while it is
               // open the page behind it is aria-hidden, so role-based locators cannot see anything there.
               await dismissBlockingOverlayForStep(page, `${action.selector || ''} ${action.assertion || ''}`, noteStep);
            }

            if (['click', 'fill', 'select'].includes(action.action) && action.selector) {
               await runDomValidation(action.selector);
               let loc = getPlaywrightLocator(page, action.selector);
               try {
                 await waitForLocatorAttached(loc, action.selector);
               } catch (notFound) {
                 // The selector looked plausible but matches nothing on the live page. Before failing (or
                 // paying for an LLM repair), probe for the real element - keep retrying briefly in case the
                 // page is still rendering.
                 let fb: string | null = null;
                 const fbDeadline = Date.now() + 15000;
                 do {
                   fb = await findDeterministicFallback(page, action.selector, action.action, getPlaywrightLocator);
                   if (fb) break;
                   await page.waitForTimeout(1000);
                 } while (Date.now() < fbDeadline);
                 if (!fb) throw notFound;
                 noteStep(`[Fallback] ${action.selector} not found; used ${fb}`);
                 action.selector = fb;
                 loc = getPlaywrightLocator(page, action.selector);
                 await waitForLocatorAttached(loc, action.selector);
               }
               const tagName = await loc.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');
               const isContentEditable = await loc.evaluate((el: any) => el.isContentEditable).catch(() => false);
               
               if (action.action === 'select' && tagName !== 'select' && await isCustomDropdown(loc)) {
                  emitLog('agent_log', `[Custom dropdown] ${action.selector} is a custom dropdown (<${tagName}>); will open it and click the option.`);
               } else if (action.action === 'select' && tagName !== 'select') {
                  emitLog('agent_log', `[Auto-Convert] Selector ${action.selector} is a <${tagName}>, not a <select>. Converting action 'select' to 'fill'.`);
                  action.action = 'fill';
               } else if (action.action === 'fill' && !['input', 'textarea'].includes(tagName) && !isContentEditable) {
                  emitLog('agent_log', `[Auto-Convert] Selector ${action.selector} is a <${tagName}>, not a text input. Converting action 'fill' to 'click'.`);
                  action.action = 'click';
               }
            }

            switch (action.action) {
              case 'goto': {
                const currentNavTimeout = 60000;
                await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: currentNavTimeout });
                
                try {
                  await page.waitForFunction(() => document.readyState === 'complete' || document.readyState === 'interactive', { timeout: 5000 }).catch(() => {});
                } catch(e) {}

                // Single-page apps often paint a "Loading..." splash first and only render the
                // real UI seconds later. Wait (best effort, capped) for something interactive to
                // appear so the next step doesn't look for an element that isn't there yet.
                await page.waitForSelector('input, button, textarea, select, a[href]', { state: 'visible', timeout: 12000 }).catch(() => {});
                // ...and make sure we are not still looking at a bare "Loading..." splash.
                await page.waitForFunction(
                  () => !/^\s*loading/i.test((document.body?.innerText || '').trim()) || !!document.querySelector('input, textarea, select'),
                  { timeout: 15000 },
                ).catch(() => {});

                if (injectSlowCrawl) await page.waitForTimeout(5000);
                const gotoChallenge = await detectAntiBotInterstitial(page);
                if (gotoChallenge.light || gotoChallenge.hard) {
                  const cleared = await challengeSolver.maybeSolve(page, solver).catch(() => false);
                  if (!cleared) throw new Error('BlockedByAntiBotError: {"vendor":"generic","type":"captcha"}');
                  emitLog('agent_log', '[AntiBot] Challenge cleared after navigation; continuing.');
                }
                // Phase 4: warm up the session once, right after the first real navigation.
                if (humanize && !warmedUp) {
                  warmedUp = true;
                  await warmUp(page, emitLog);
                }
                break;
              }
              case 'click': {
                try {
                  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                } catch(e) {}
                
                const selLower = action.selector.toLowerCase();
                if (selLower.includes('text=login') || selLower.includes('text="login"') || selLower.includes("text='login'")) {
                    throw new Error(`INVALID_ACTION_TARGET: Selector policy forbids text="Login". Required: button, #id, [data-testid], or role=button.`);
                }
                
                let loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);

                // Ambiguity guard: several elements can match one name (a "Sign in" tab AND a submit
                // button, hidden twins, controls behind an open dialog...). `.first()` silently picks the
                // first in the DOM, so rank the candidates instead (see utils/elementRanking.ts).
                try {
                  const allMatches = getPlaywrightLocator(page, action.selector, true);
                  const best = allMatches ? await pickBestMatch(allMatches) : null;
                  if (best) {
                    loc = allMatches.nth(best.index);
                    noteStep(`[Ambiguous click] ${best.count} elements matched; chose #${best.index + 1} (${best.reason})`);
                  }
                } catch (_) { /* best effort - fall back to the first match */ }

                await dismissBlockingOverlay(page, loc, noteStep);

                // Safety guard: never click controls whose label is irreversible/account-destroying
                // unless the run explicitly allows it (see utils/protectedActions.ts).
                const clickLabel: string = await loc.evaluate((n: HTMLElement) => [n.getAttribute('aria-label'), n.getAttribute('title'), n.innerText, (n as HTMLInputElement).value].filter(Boolean).join(' ').replace(/s+/g, ' ').trim().slice(0, 200)).catch(() => '');
                const protectedHit = checkProtectedAction(clickLabel, { protectedActions: options.protectedActions, allowProtectedActions: options.allowProtectedActions });
                if (protectedHit) {
                  skipReason = `Refused by safety policy: "${clickLabel}" ${protectedHit}. Not clicked. (Allow explicitly per run with allowProtectedActions.)`;
                  isUnsupported = true;
                  break;
                }

                const tagName = await loc.evaluate((node: HTMLElement) => node.tagName.toUpperCase()).catch(() => 'UNKNOWN');
                const isClickable = await loc.evaluate((node: HTMLElement) => {
                   return ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT'].includes(node.tagName.toUpperCase()) || 
                          window.getComputedStyle(node).cursor === 'pointer' || 
                          node.onclick !== null || 
                          node.hasAttribute('onclick') ||
                          node.getAttribute('role') === 'button' ||
                          node.getAttribute('role') === 'link' ||
                          node.getAttribute('role') === 'menuitem' ||
                          node.getAttribute('role') === 'checkbox' ||
                          node.getAttribute('role') === 'radio' ||
                          node.getAttribute('type') === 'submit' ||
                          node.getAttribute('type') === 'checkbox';
                }).catch(() => true);
                
                if (!isClickable && !['DIV', 'SPAN'].includes(tagName)) {
                   throw new Error(`InvalidActionTargetError: Attempted click() on non-clickable <${tagName}>.`);
                }
                
                await loc.scrollIntoViewIfNeeded();
                await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                if (!(await loc.isEnabled())) throw new Error("Element is not enabled");
                if (humanize) {
                  await humanMoveToLocator(page, loc);
                } else {
                  await loc.hover();
                }
                await page.waitForTimeout(100 + Math.random() * 200);

                if (injectHumanSimulation) {
                  await page.waitForTimeout(1000 + Math.random() * 1000);
                }
                if (injectSlowCrawl) await page.waitForTimeout(3000);
                
                try {
                  await Promise.all([
                    page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}),
                    loc.click({ timeout: currentTimeout }).catch(async (e: any) => {
                       emitLog('agent_log', `Standard click failed: ${e.message}. Attempting force click...`);
                       await loc.click({ force: true, timeout: currentTimeout });
                    })
                  ]);
                } catch (e: any) {
                  if (e.message && (e.message.includes('Execution context was destroyed') || e.message.includes('Target page, context or browser has been closed') || e.message.includes('Navigating'))) {
                    emitLog('agent_log', `Navigation race detected during click (context destroyed), treating click as successful navigation.`);
                  } else {
                    throw e;
                  }
                }
                
                // SPA Navigation Fix
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

                // Menu / drawer opener: give the slide-in animation time to finish
                // and its items become hittable before the next step runs. Keyed
                // off the step's own wording so it never fires for a normal click.
                if (/burger|hamburger|open\s*menu|side\s*menu|sidebar|nav(?:igation)?\s*(?:menu|toggle|drawer)|drawer|dropdown/i
                    .test(`${action.assertion || ''} ${rawSelector || ''}`)) {
                  await page.waitForTimeout(800);
                }

                // Removed hardcoded login assertions to allow negative test cases to proceed normally and be verified by their own explicit assertions.

                emitLog('telemetry', 'CLICK_VERIFIED');
                break;
              }
              case 'fill': {
                try {
                  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                } catch(e) {}
                
                const selLower = action.selector.toLowerCase();
                if (selLower.includes('text=') || selLower.includes('contains(') || selLower.startsWith('span') || selLower.startsWith('div') || selLower.startsWith('body') || selLower.startsWith('label')) {
                    throw new Error(`INVALID_FILL_SELECTOR: Selector policy forbids text or structural container matching for fill: ${action.selector}`);
                }
                
                await runDomValidation(action.selector);
                let loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);

                // Same ranking as click: avoid hidden twins / fields behind an open dialog.
                try {
                  const allMatches = getPlaywrightLocator(page, action.selector, true);
                  const best = allMatches ? await pickBestMatch(allMatches) : null;
                  if (best) {
                    loc = allMatches.nth(best.index);
                    noteStep(`[Ambiguous fill] ${best.count} elements matched; chose #${best.index + 1} (${best.reason})`);
                  }
                } catch (_) { /* best effort */ }
                await dismissBlockingOverlay(page, loc, noteStep);

                const tagName = await loc.evaluate((node: HTMLElement) => node.tagName.toUpperCase()).catch(() => 'UNKNOWN');
                const isContentEditable = await loc.evaluate((node: HTMLElement) => node.isContentEditable).catch(() => false);
                if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) && !isContentEditable) {
                   throw new Error(`InvalidActionTargetError: Attempted fill() on <${tagName}>. Must be input/textarea/select/contenteditable.`);
                }
                
                const pageTitle = await page.title().catch(() => '');
                if (pageTitle.toLowerCase().includes('not found') || pageTitle.includes('404')) {
                   throw new Error(`WrongPageError: Reached an error page / 404 Not Found.`);
                }
                await loc.scrollIntoViewIfNeeded();
                await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                if (!(await loc.isEnabled())) throw new Error("Element is not enabled");
                if (injectHumanSimulation) {
                  await loc.hover();
                  await page.waitForTimeout(1000 + Math.random() * 1000);
                }
                if (injectSlowCrawl) await page.waitForTimeout(3000);
                // Credential tokens: the generator writes __USERNAME__ / __PASSWORD__ instead of inventing
                // credentials. The real values come from the run (Test username / Test password boxes) and
                // are substituted only here, so they never enter the saved plan or the step log.
                const rawFill = String(action.value ?? '');
                const usesCredToken = /__(USERNAME|EMAIL|PASSWORD)__/.test(rawFill);
                const runCreds: any = options.credentials || {};
                let fillValue = rawFill;
                if (usesCredToken) {
                  const needUser = /__(USERNAME|EMAIL)__/.test(rawFill) && !runCreds.username;
                  const needPass = /__PASSWORD__/.test(rawFill) && !runCreds.password;
                  if (needUser || needPass) {
                    throw new Error('MISSING_CREDENTIALS: this step needs the ' + (needUser ? 'test username' : 'test password') + ', but none was provided for the run. Fill the Test username / Test password fields (or put the credentials in the scenario) - NovaTest will not invent them.');
                  }
                  fillValue = rawFill.replace(/__(USERNAME|EMAIL)__/g, runCreds.username ?? '').replace(/__PASSWORD__/g, runCreds.password ?? '');
                }
                const isSecretField = usesCredToken || (await loc.evaluate((el: any) => (el.getAttribute('type') || '').toLowerCase() === 'password').catch(() => false));

                await loc.fill('', { timeout: currentTimeout }).catch(() => {});
                if (humanize) {
                  if (page.mouse) { await humanMoveToLocator(page, loc); }
                  await humanType(loc, fillValue);
                } else {
                  // Natural typing speed for short text; fast for long text. The time limit grows with the text
                  // length - a fixed 5s limit made any sentence over ~40 characters time out while typing.
                  const typeDelay = fillValue.length > 30 ? 12 : Math.floor(Math.random() * (180 - 50 + 1) + 50);
                  await loc.type(fillValue, { delay: typeDelay, timeout: Math.max(currentTimeout, fillValue.length * typeDelay + 5000) });
                }

                let verificationResult = undefined;
                const actual = await loc.inputValue().catch(() => loc.evaluate((el: any) => el.value || el.innerText || '').catch(() => ''));
                emitLog('telemetry', `TRACE_FILL_ACTUAL=${isSecretField ? '[hidden]' : actual}`);
                if (actual.trim() !== fillValue.trim()) {
                   emitLog('telemetry', `TRACE_FILL_VERIFIED=false`);
                   throw new Error("FILL_VERIFICATION_FAILED: Field did not accept the expected value");
                }
                emitLog('telemetry', `TRACE_FILL_VERIFIED=true`);
                verificationResult = "SUCCESS";

                break;
              }
              case 'wait':
                if (action.state === 'networkidle' || action.value === 'networkidle') {
                  emitLog('agent_log', 'Downgrading networkidle request to domcontentloaded to prevent deadlock');
                  await page.waitForLoadState('domcontentloaded').catch(() => {});
                  await page.waitForTimeout(3000);
                } else if (action.state === 'domcontentloaded' || action.value === 'domcontentloaded') {
                  await page.waitForLoadState('domcontentloaded');
                } else {
                  await page.waitForTimeout(parseInt(action.timeout || action.value || "1000", 10));
                }
                break;
              case 'screenshot':
                await page.screenshot();
                break;
              case 'consoleCapture':
                // Already capturing globally, just emit a log marking it
                emitLog('browser_log', 'Console capture checkpoint executed');
                break;
              case 'assertText': {
                await runDomValidation(action.selector);
                const loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);
                const text = await loc.innerText({ timeout: currentTimeout });
                const expectedText = action.contains || action.value;
                if (expectedText && expectedText !== "null") {
                  if (!text.includes(expectedText)) {
                    throw new Error(`Assertion failed: expected ${action.selector} to contain "${expectedText}", but got "${text}"`);
                  }
                } else if (!text || text.trim() === '') {
                  throw new Error(`Assertion failed: expected ${action.selector} to contain text, but it was empty`);
                }
                break;
              }
              case 'assertVisible': {
                await runDomValidation(action.selector);
                const loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);
                await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                break;
              }
              case 'assertUrl': {
                // Verify the current page address. `value`/`contains` is a plain substring or a /regex/.
                // NOTE: the generator stores the natural-language intent in `contains`, so the expected
                // address comes from `value` (or `url`, or a non-locator `selector`), never `contains`.
                const selAsText = typeof action.selector === 'string' && !/^(getBy|locator\()/.test(action.selector) ? action.selector : '';
                const want = String(action.value ?? action.url ?? selAsText ?? '').trim();
                if (!want) throw new Error('assertUrl needs the expected URL text in value.');
                // "/profile/edit" is a PATH, not a regex: only treat /.../flags as a regex when the flags are valid.
                const rxm = /^\/(.+)\/([a-z]*)$/.exec(want);
                const rx = rxm && /^[dgimsuvy]*$/.test(rxm[2] || '') ? rxm : null;
                const matches = (u: string) => rx ? new RegExp(rx[1] as string, rx[2] || 'i').test(u) : u.toLowerCase().includes(want.toLowerCase());
                try {
                  await page.waitForURL((u: URL) => matches(u.toString()), { timeout: currentTimeout });
                } catch {
                  throw new Error(`Assertion failed: expected the page address to match "${want}", but it is "${page.url()}"`);
                }
                break;
              }
              case 'assertEnabled':
              case 'assertDisabled': {
                await runDomValidation(action.selector);
                const loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);
                const wantEnabled = action.action === 'assertEnabled';
                // An informational dialog (e.g. the welcome tour) must not distort a state check.
                await dismissBlockingOverlay(page, loc, noteStep);
                // Several controls can share one name (e.g. "Save" and "Save this message"): rank them like
                // click/fill do, so the check is made on the right one.
                let stateLoc = loc;
                try {
                  const allMatches = getPlaywrightLocator(page, action.selector, true);
                  const best = allMatches ? await pickBestMatch(allMatches) : null;
                  if (best) {
                    stateLoc = allMatches.nth(best.index);
                    noteStep(`[Ambiguous check] ${best.count} elements matched; chose #${best.index + 1} (${best.reason})`);
                  }
                } catch (_) { /* best effort */ }
                const deadline = Date.now() + currentTimeout;
                let ok = false;
                while (Date.now() < deadline) {
                  const enabled = await stateLoc.isEnabled().catch(() => false);
                  if (enabled === wantEnabled) { ok = true; break; }
                  await page.waitForTimeout(250);
                }
                if (!ok) throw new Error(`Assertion failed: expected ${action.selector} to be ${wantEnabled ? 'enabled' : 'disabled'}.`);
                break;
              }
              case 'press': {
                const key = String(action.key ?? action.value ?? '').trim();
                if (!key) throw new Error('press needs a key name in value (e.g. Enter, Escape, Tab).');
                if (action.selector) {
                  const loc = getPlaywrightLocator(page, action.selector);
                  await waitForLocatorAttached(loc, action.selector);
                  await loc.press(key, { timeout: currentTimeout });
                } else {
                  await page.keyboard.press(key);
                }
                break;
              }
              case 'assertNotVisible': {
                const loc = getPlaywrightLocator(page, action.selector);
                if (loc) {
                   await loc.waitFor({ state: 'hidden', timeout: currentTimeout });
                }
                break;
              }
              case 'select': {
                try {
                  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                } catch(e) {}
                
                await runDomValidation(action.selector);
                const loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);
                
                const tagName = await loc.evaluate((node: HTMLElement) => node.tagName.toUpperCase()).catch(() => 'UNKNOWN');
                if (tagName !== 'SELECT') {
                   if (await isCustomDropdown(loc)) {
                      await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                      const wantText = String(action.value ?? action.contains ?? '');
                      try {
                        const chosen = await chooseCustomOption(page, loc, wantText, currentTimeout);
                        noteStep(`[Custom dropdown] chose "${chosen}"`);
                      } catch (dropErr: any) {
                        // The choice may not be a dropdown option at all but a radio / tab / segmented button
                        // (e.g. a unit toggle). Try those by the option text before giving up.
                        await page.keyboard.press('Escape').catch(() => {});
                        const esc = wantText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        let picked = '';
                        for (const role of ['radio', 'tab', 'button', 'menuitemradio']) {
                          const cand = page.getByRole(role as any, { name: new RegExp(esc, 'i') });
                          const cnt = await cand.count().catch(() => 0);
                          for (let ci = 0; ci < cnt; ci++) {
                            const el = cand.nth(ci);
                            if (await el.isVisible().catch(() => false)) { await el.click({ timeout: currentTimeout }); picked = role; break; }
                          }
                          if (picked) break;
                        }
                        if (!picked) throw dropErr;
                        noteStep(`[Choice] selected "${wantText}" as a ${picked}`);
                      }
                      break;
                   }
                   throw new Error(`InvalidActionTargetError: Attempted select() on <${tagName}>. Must be SELECT or a custom dropdown (role=combobox/listbox).`);
                }
                
                await loc.scrollIntoViewIfNeeded();
                await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                if (!(await loc.isEnabled())) throw new Error("Element is not enabled");
                await loc.selectOption(action.value, { timeout: currentTimeout });
                break;
              }
              case 'hover': {
                await runDomValidation(action.selector);
                const loc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(loc, action.selector);
                await loc.scrollIntoViewIfNeeded();
                await loc.waitFor({ state: 'visible', timeout: currentTimeout });
                await loc.hover({ timeout: currentTimeout });
                break;
              }
              case 'dragAndDrop': {
                const targetSelector = action.targetSelector || action.destinationSelector;
                if (!targetSelector) {
                  throw new Error(`INVALID_ACTION_TARGET: dragAndDrop requires a "targetSelector" (or "destinationSelector") in addition to "selector".`);
                }
                await runDomValidation(action.selector);
                const sourceLoc = getPlaywrightLocator(page, action.selector);
                await waitForLocatorAttached(sourceLoc, action.selector);
                const targetLoc = getPlaywrightLocator(page, targetSelector);
                await waitForLocatorAttached(targetLoc, targetSelector);
                await sourceLoc.scrollIntoViewIfNeeded();
                await sourceLoc.dragTo(targetLoc, { timeout: currentTimeout });
                break;
              }
              case 'handleDialog': {
                // Arms the NEXT alert/confirm/prompt to be accepted (default)
                // or dismissed, optionally with text typed into a prompt().
                // The actual browser event is handled by the page.on('dialog')
                // listener registered above, not here — dialogs fire
                // asynchronously mid-action, so there is nothing to await.
                const accept = action.accept !== false;
                pendingDialogAction = { accept, promptText: action.value };
                emitLog('browser_log', `Armed next JS dialog to be ${accept ? 'accepted' : 'dismissed'}${action.value ? ` with text "${action.value}"` : ''}.`);
                break;
              }
              case 'log':
                emitLog('browser_log', `Log action: ${action.message || action.value || action.details || ''}`);
                break;
              default:
                emitLog('browser_log', `Unknown action type: ${action.action}`);
                isUnsupported = true;
            }
            successAction = true;
            
            if (isUnsupported) {
              if (action.scenarioName) {
                scenario_status[action.scenarioName] = 'SKIPPED';
              }
              emitLog('telemetry', `ACTION_SKIPPED=${action.action}`);
              if (skipReason && action.scenarioName) { skippedScenarios.add(action.scenarioName); chainCompromised = true; }
              addStep(action.action, 'SKIPPED', Date.now() - startTime, skipReason || `Unsupported action type: ${action.action}`, action.value, rawSelector);
              logTranscriptEvent(action.action, rawSelector, skipReason || `Unsupported action type`, 'SKIPPED', action.scenarioName);
            } else {
              if (action.scenarioName) {
                scenario_status[action.scenarioName] = 'PASS';
              }
              emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
              addStep(action.action, 'PASSED', Date.now() - startTime, stepNote ? `${details} ${stepNote}` : details, action.value, rawSelector);
              logTranscriptEvent(action.action, rawSelector, action.value, 'SUCCESS', action.scenarioName);
            }
          } catch (err: any) {
            attempts++;
            if (err.message.includes("anti-bot system")) {
              scriptBlocked = true;
              break; // Break inner retry loop
            }
            if (err.message.includes("Execution context was destroyed") || err.message.includes("NavigationRace") || err.message.includes("Target page, context or browser has been closed") || err.message.includes("Navigating")) {
               emitLog('healing', `Navigation Race detected: ${err.message}. Treating action as successfully initiating a navigation.`);
               await page.waitForLoadState('domcontentloaded').catch(() => {});
               successAction = true;
               if (action.scenarioName) {
                 scenario_status[action.scenarioName] = 'PASS';
               }
               emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
               addStep(action.action, 'PASSED', Date.now() - startTime, `Navigation Race (success): ${details}`, action.value, rawSelector);
               logTranscriptEvent(action.action, rawSelector, action.value, 'SUCCESS', action.scenarioName);
               break;
            }
            emitLog('healing', `Checking healing eligibility for step type: ${action.action}`);
            if (action.action.startsWith('assert')) {
                // FAST PATH (no AI call, no long retries): when the step's own wording quotes the text to
                // verify, look for that text directly in what the user can see. Present -> the check is
                // satisfied; still absent after a short grace period -> a real failure with a precise reason.
                if ((action.action === 'assertVisible' || action.action === 'assertText')
                    && !action._intentPhraseTried && typeof action.assertion === 'string') {
                  action._intentPhraseTried = true;
                  const phrases = extractIntentPhrases(action.assertion);
                  if (phrases.length > 0 && isNegatedIntent(action.assertion) && !isConditionalIntent(action.assertion)) {
                    // "... is no longer visible" / "... is not shown": the quoted text must be ABSENT.
                    const absent = await checkPhrasesAbsent(page, phrases, 4000);
                    if (absent.found.length === 0) {
                      successAction = true;
                      if (action.scenarioName) scenario_status[action.scenarioName] = 'PASS';
                      emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
                      addStep(action.action, 'PASSED', Date.now() - startTime, `${details} [Verified absent from the page: ${phrases.map(p => `"${p}"`).join(', ')}]`, action.value, rawSelector);
                      logTranscriptEvent(action.action, rawSelector, action.value, 'SUCCESS', action.scenarioName);
                      break;
                    }
                    action._assertRegenTried = true;
                    action._assertRoleRelaxTried = true;
                    err.message = `Assertion failed: expected ${absent.found.map(p => `"${p}"`).join(', ')} to be absent, but it is still shown on the page.`;
                  } else if (phrases.length > 0) {
                    const check = await checkIntentPhrases(page, phrases, 3500);
                    if (check.missing.length === 0) {
                      successAction = true;
                      if (action.scenarioName) scenario_status[action.scenarioName] = 'PASS';
                      emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
                      addStep(action.action, 'PASSED', Date.now() - startTime, `${details} [Verified from the page's visible text: ${check.found.map(p => `"${p}"`).join(', ')}]`, action.value, rawSelector);
                      logTranscriptEvent(action.action, rawSelector, action.value, 'SUCCESS', action.scenarioName);
                      break;
                    }
                    if (check.found.length === 0 && !isConditionalIntent(action.assertion)) {
                      // Nothing it asked for is on the page: a real failure, and an AI selector rewrite
                      // cannot conjure text that is not there. Fail now, with the reason.
                      action._assertRegenTried = true;
                      action._assertRoleRelaxTried = true;
                      action._phrasesMissing = check.missing;
                      err.message = `Assertion failed: the page does not show ${check.missing.map(p => `"${p}"`).join(', ')} (checked the visible text, placeholders and labels for ${3.5}s).`;
                    } else if (check.found.length === 0) {
                      // Conditional step ("If a ... is shown, ...") that did not apply: no AI call needed.
                      action._assertRegenTried = true;
                      action._assertRoleRelaxTried = true;
                    }
                  }
                }
                // Assertions are not eligible for SelfHealingAgent (it must not swap the
                // asserted element for a different one). But a failed assertion is very
                // often just a stale/guessed SELECTOR for the RIGHT element on a page
                // whose DOM was not available at generation time (e.g. everything behind
                // a login).
                //
                // Recovery 1 (deterministic, no LLM): if the selector is a role-scoped
                // locator - getByRole('<role>', { name: /X/i }) - the role/tag is the
                // fragile part (a title that is a <span>, not an <h1>, still means the
                // page loaded). Retry the SAME assertion with the tag-agnostic
                // getByText(/X/i) derived from that accessible name.
                if ((action.action === 'assertVisible' || action.action === 'assertText')
                    && !action._assertRoleRelaxTried && typeof action.selector === 'string'
                    && /getBy(Role|Label|Placeholder)\s*\(/.test(action.selector)) {
                  action._assertRoleRelaxTried = true;
                  const nameMatch = action.selector.match(/name\s*:\s*\/([^/]+)\/[a-z]*/i)
                     || action.selector.match(/name\s*:\s*['"]([^'"]+)['"]/i)
                     || action.selector.match(/getBy(?:Label|Placeholder)\s*\(\s*\/([^/]+)\/[a-z]*/i)
                     || action.selector.match(/getBy(?:Label|Placeholder)\s*\(\s*['"]([^'"]+)['"]/i);
                  if (nameMatch && nameMatch[1]) {
                    const relaxed = `getByText(/${nameMatch[1]}/i)`;
                    try {
                      emitLog('agent_log', `[ASSERTION_ROLE_RELAX]\nscenario=${action.scenarioName}\noriginal=${action.selector}\nrelaxed=${relaxed}`);
                      const relaxedLoc = getPlaywrightLocator(page, relaxed);
                      if (action.action === 'assertVisible') {
                        await relaxedLoc.waitFor({ state: 'visible', timeout: currentTimeout });
                      } else {
                        const t = await relaxedLoc.innerText({ timeout: currentTimeout });
                        const want = action.contains || action.value;
                        if (want && want !== 'null' && !t.includes(want)) throw new Error(`text mismatch`);
                      }
                      action.selector = relaxed;
                      successAction = true;
                      if (action.scenarioName) scenario_status[action.scenarioName] = 'PASS';
                      emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
                      // Record the recovery as a heal so the report's self-heal
                      // count and the HealingEvent ledger both see it (the worker
                      // derives both from HEAL TRIGGERED -> HEAL PASSED step pairs).
                      addStep('HEAL', 'TRIGGERED', 0, `Failed selector: ${rawSelector}`, undefined, rawSelector);
                      addStep('HEAL', 'PASSED', Date.now() - startTime, `Recovered role-agnostic selector: ${relaxed}`, undefined, relaxed);
                      addStep(action.action, 'PASSED', Date.now() - startTime, `${details} (recovered: role-agnostic ${relaxed})`, action.value, relaxed);
                      logTranscriptEvent(action.action, relaxed, action.value, 'SUCCESS', action.scenarioName);
                      break;
                    } catch (relaxErr: any) {
                      emitLog('agent_log', `[ASSERTION_ROLE_RELAX] did not recover: ${relaxErr.message}`);
                    }
                  }
                }
                // Recovery 2 (LLM): one regenerateSelector attempt against the LIVE DOM,
                // driven by the natural-language intent - the same regenerateSelector
                // used for clicks/fills, no element substitution.
                if ((action.action === 'assertVisible' || action.action === 'assertText')
                    && action.assertion && action.assertion !== 'null'
                    && !action._assertRegenTried) {
                  action._assertRegenTried = true;
                  try {
                    const liveUrl = page.url();
                    const liveDom = await page.evaluate(() => document.body.innerHTML);
                    const compactDom = JSON.stringify(await extractCompactDom(page), null, 2);
                    emitLog('agent_log', `[ASSERTION_SELECTOR_REGENERATION]\nscenario=${action.scenarioName}\nstep=${action.action}\nintent=${action.assertion}\ncurrentUrl=${liveUrl}`);
                    const regenAgent = new ScriptGenerationAgent(executionId);
                    const regen = await regenAgent.regenerateSelector(action.assertion, action.action, compactDom);
                    emitLog('agent_log', `[ASSERTION_SELECTOR_REGENERATION]\nintent=${action.assertion}\nselector=${regen}`);
                    if (regen && regen !== 'null' && regen.trim() !== '' && validateSelectorDOM(regen, liveDom).valid) {
                      const regenLoc = getPlaywrightLocator(page, regen);
                      if (action.action === 'assertVisible') {
                        await regenLoc.waitFor({ state: 'visible', timeout: currentTimeout });
                      } else {
                        const t = await regenLoc.innerText({ timeout: currentTimeout });
                        const want = action.contains || action.value;
                        if (want && want !== 'null' && !t.includes(want)) {
                          throw new Error(`Assertion failed after regeneration: expected "${want}", got "${t}"`);
                        }
                      }
                      action.selector = regen;
                      successAction = true;
                      if (action.scenarioName) scenario_status[action.scenarioName] = 'PASS';
                      emitLog('telemetry', `ACTION_COMPLETED=${action.action}`);
                      // Record the recovery as a heal (see role-relax path above).
                      addStep('HEAL', 'TRIGGERED', 0, `Failed selector: ${rawSelector}`, undefined, rawSelector);
                      addStep('HEAL', 'PASSED', Date.now() - startTime, `Recovered via selector regeneration: ${regen}`, undefined, regen);
                      addStep(action.action, 'PASSED', Date.now() - startTime, `${details} (recovered via selector regeneration: ${regen})`, action.value, regen);
                      logTranscriptEvent(action.action, regen, action.value, 'SUCCESS', action.scenarioName);
                      break;
                    }
                  } catch (regenErr: any) {
                    emitLog('agent_log', `[ASSERTION_SELECTOR_REGENERATION] failed: ${regenErr.message}`);
                  }
                }
                // A visibility/text assertion that survived BOTH recovery attempts
                // (deterministic role-relax + one LLM regeneration) without binding
                // to any real element is an assertion we simply cannot express -
                // usually a semantic "the X page loads / X is visible" check the
                // generator guessed a selector for because that page's DOM was never
                // available at generation time. A check we could not run tells us
                // nothing about whether the app is broken, so:
                //   - record the STEP as SKIPPED / not-evaluated
                //   - do NOT fail the scenario and do NOT compromise the chain
                //     (a genuine app fault will surface on the following interaction
                //      steps, which need real elements)
                if ((action.action === 'assertVisible' || action.action === 'assertText') && !action._phrasesMissing) {
                    // Guard: if the page is visibly an error / not-found page, this is a
                    // real failure, not an un-runnable check.
                    const errPage = await (async () => {
                      try {
                        const t = (await page.title().catch(() => '')).toLowerCase();
                        if (/(404|not found|error|forbidden|denied|unavailable)/.test(t)) return true;
                        const bodyErr = await page.evaluate(() => /\b(4\d\d|5\d\d)\b.*\b(error|not found)\b|something went wrong|page (not found|unavailable)/i.test((document.body.innerText || '').slice(0, 400))).catch(() => false);
                        return !!bodyErr;
                      } catch { return false; }
                    })();
                    if (!errPage) {
                      emitLog('agent_log', `[ASSERTION_NOT_EVALUATED]\nscenario=${action.scenarioName}\nstep=${action.action}\nintent=${action.assertion || ''}\nselector=${action.selector}\nreason=could not bind this assertion to a real element after role-relax + regeneration; page is not an error page`);
                      emitLog('telemetry', `ACTION_SKIPPED=${action.action}`);
                      addStep(action.action, 'SKIPPED', Date.now() - startTime, `Assertion not evaluated - could not resolve a real element for intent: ${action.assertion || rawSelector}`, action.value, rawSelector);
                      logTranscriptEvent(action.action, rawSelector, action.assertion || '', 'SKIPPED', action.scenarioName);
                      successAction = true;
                      break;
                    }
                    emitLog('agent_log', `[ASSERTION_FAILED_ON_ERROR_PAGE] The page looks like an error/not-found page - treating the unresolved assertion as a real failure.`);
                }
                emitLog('healing', `Healing Decision: REJECTED (Reason: Assertions are not eligible for healing)`);

                 try {
                   const stepIndex = stepLogs.length + 1; const shotSeq = nextFailShot(executionId);
                   const screenshotPath = `./temp/screenshots/${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`;
                   await require('fs/promises').mkdir('./temp/screenshots', { recursive: true }).catch(() => {});
                   await page.screenshot({ path: screenshotPath, fullPage: true });
                   const fileData = await require('fs/promises').readFile(screenshotPath);
                   const { data, error } = await supabase.storage
                     .from('screenshots')
                     .upload(`${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`, fileData, { contentType: 'image/png', upsert: true });
                   if (!error && data) {
                     const { data: publicData } = supabase.storage.from('screenshots').getPublicUrl(data.path);
                     screenshotUrl = publicData.publicUrl;
                     emitLog('screenshot_uploaded', 'Assertion failure screenshot uploaded successfully');
                   }
                 } catch (captureErr: any) {
                   emitLog('agent_log', `Failed to capture assertion screenshot: ${captureErr.message}`);
                 }

                if (action.scenarioName) {
                    scenario_status[action.scenarioName] = 'FAIL';
                    failedScenarios.add(action.scenarioName);
                    chainCompromised = true;
                }
                addStep(action.action, 'FAILED', Date.now() - startTime, err.message, action.value, rawSelector);
                logTranscriptEvent(action.action, rawSelector, err.message, 'FAILED', action.scenarioName);
                break;
            }
            emitLog('healing', `Healing Decision: ELIGIBLE`);

            // A click/fill whose role/text-scoped selector did not resolve to a
            // usable control:
            //   - it landed on a non-interactive element (InvalidActionTargetError)
            //     — e.g. an ambiguous getByText(/X/i).first() hitting a heading
            //       or a hidden modal title (demoblaze's "Place order" <h5>), OR
            //   - it matched nothing at all — an <a> with no href has no 'link'
            //     role (saucedemo's #logout_sidebar_link), an icon link has no
            //     accessible name, a <span> title is not a heading.
            // Derive the intended NAME from the selector (getByText OR
            // getByRole({name})) and probe the other common shapes before
            // falling through to full healing. Emits HEAL steps.
            const _relaxable = (action.action === 'click' || action.action === 'fill') && !action._targetRelaxTried;
            const _nameMatch = String(action.selector || '').match(/getByText\s*\(\s*\/([^/]+)\/[a-z]*/i)
               || String(action.selector || '').match(/getByText\s*\(\s*['"]([^'"]+)['"]/i)
               || String(action.selector || '').match(/name\s*:\s*\/([^/]+)\/[a-z]*/i)
               || String(action.selector || '').match(/name\s*:\s*['"]([^'"]+)['"]/i)
               || String(action.selector || '').match(/text\s*=\s*["']?([^"'\]]+)/i);
            const _notResolved = err.message.includes("InvalidActionTargetError")
               || err.message.includes("not present in current DOM")
               || err.message.includes("Selector not found in DOM")
               || err.message.includes("Selector resolution failed")
               || err.message.includes("waiting for") // playwright visibility/attached timeout
               || err.message.includes("strict mode violation");
            if (_relaxable && _notResolved && _nameMatch && _nameMatch[1]) {
              action._targetRelaxTried = true;
              const healStart = Date.now();
              const originalSelector = action.selector;
              const nm = _nameMatch[1].trim().replace(/\//g, '\\/');
              const candidates: string[] = [
                `getByText(/${nm}/i)`,
                `getByRole('button', { name: /${nm}/i })`,
                `getByRole('link', { name: /${nm}/i })`,
                `getByRole('menuitem', { name: /${nm}/i })`,
              ].filter((c) => c !== originalSelector);
              let recovered = '';
              for (const cand of candidates) {
                try {
                  const cloc = getPlaywrightLocator(page, cand);
                  await cloc.waitFor({ state: 'visible', timeout: 3000 });
                  if (action.action !== 'click' || (await cloc.isEnabled())) { recovered = cand; break; }
                } catch { /* try next candidate */ }
              }
              if (!recovered && action.assertion && action.assertion !== 'null') {
                try {
                  const compactDom = JSON.stringify(await extractCompactDom(page), null, 2);
                  const regen = await new ScriptGenerationAgent(executionId)
                    .regenerateSelector(action.assertion, action.action, compactDom);
                  const liveDom = await page.evaluate(() => document.body.innerHTML);
                  if (regen && regen !== 'null' && regen.trim() !== '' && validateSelectorDOM(regen, liveDom).valid) {
                    recovered = regen;
                  }
                } catch (regenErr: any) {
                  emitLog('agent_log', `[TARGET_RELAX] regeneration failed: ${regenErr.message}`);
                }
              }
              if (recovered) {
                emitLog('healing', `[TARGET_RELAX] ${originalSelector} -> ${recovered}`);
                addStep('HEAL', 'TRIGGERED', 0, `Failed selector: ${originalSelector}`, undefined, originalSelector);
                addStep('HEAL', 'PASSED', Date.now() - healStart, `Re-pointed to interactive element: ${recovered}`, undefined, recovered);
                action.selector = recovered;
                continue; // retry the action with the interactive selector
              }
            }

            if (err.message.includes("InvalidActionTargetError") || err.message.includes("WrongPageError") || err.message.includes("BlockedByAntiBotError") || err.message.includes("SELECTOR_RESOLUTION_FAILED") || err.message.includes("LOGIN_ASSERTION_FAILED") || err.message.includes("FILL_VERIFICATION_FAILED") || err.message.includes("EMPTY_FILL_VALUE") || err.message.includes("INVALID_ACTION_TARGET") || err.message.includes("Assertion failed")) {

                 if (err.message.includes("Assertion failed") || err.message.includes("ASSERTION_FAILED")) {
                   try {
                     const stepIndex = stepLogs.length + 1; const shotSeq = nextFailShot(executionId);
                     const screenshotPath = `./temp/screenshots/${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`;
                     await require('fs/promises').mkdir('./temp/screenshots', { recursive: true }).catch(() => {});
                     await page.screenshot({ path: screenshotPath, fullPage: true });
                     const fileData = await require('fs/promises').readFile(screenshotPath);
                     const { data, error } = await supabase.storage
                       .from('screenshots')
                       .upload(`${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`, fileData, { contentType: 'image/png', upsert: true });
                     if (!error && data) {
                       const { data: publicData } = supabase.storage.from('screenshots').getPublicUrl(data.path);
                       screenshotUrl = publicData.publicUrl;
                       emitLog('screenshot_uploaded', 'Assertion failure screenshot uploaded successfully');
                     }
                   } catch (captureErr: any) {
                     emitLog('agent_log', `Failed to capture assertion screenshot: ${captureErr.message}`);
                   }
                 }

                if (action.scenarioName) {
                    scenario_status[action.scenarioName] = 'FAIL';
                    failedScenarios.add(action.scenarioName);
                    chainCompromised = true;
                }
                addStep(action.action, 'FAILED', Date.now() - startTime, err.message, action.value, rawSelector);
                logTranscriptEvent(action.action, rawSelector, err.message, 'FAILED', action.scenarioName);
                break; 
            }
            if (attempts >= 4 || !action.selector) {
              if (action.scenarioName) {
                 scenario_status[action.scenarioName] = 'FAIL';
                 failedScenarios.add(action.scenarioName);
                 chainCompromised = true;
              }
              emitLog('telemetry', `ACTION_FAILED=${action.action}`);
              addStep(action.action, 'FAILED', Date.now() - startTime, err.message, action.value, rawSelector);
              logTranscriptEvent(action.action, rawSelector, err.message, 'FAILED', action.scenarioName);
              break;
            }
            emitLog('healing', `Action failed for selector: ${action.selector}`);
            const healStart = Date.now();
            addStep('HEAL', 'TRIGGERED', 0, `Failed selector: ${action.selector}`, undefined, action.selector);
            
            if (!action.healedSelectors) {
              const currentUrl = page.url();
              const domSnapshot = await page.evaluate(() => document.body.innerHTML);
              emitLog('agent_log', `[SELF_HEALING_CURRENT_DOM]\nscenario=${action.scenarioName}\nstep=${action.action}\nurl=${currentUrl}\ndomSize=${domSnapshot.length}`);
              const intent = action.assertion || action.selector || `Action type: ${action.action}`;
              action.healedSelectors = await healingAgent.healSelector(err.message, `Intended target: ${intent}`, domSnapshot);
              emitLog('healing', `SelfHealingAgent proposed fallback selectors: ${JSON.stringify(action.healedSelectors)}`);
            }
            
            const confidentSelectors = action.healedSelectors.filter((s: any) => s.confidence >= 0.85);
            if (confidentSelectors.length === 0) {
              if (action.scenarioName) {
                  scenario_status[action.scenarioName] = 'FAIL';
                  failedScenarios.add(action.scenarioName);
                  chainCompromised = true;
              }
              addStep(action.action, 'FAILED', Date.now() - startTime, `HEALING_FAILED: ${err.message}`, action.value, rawSelector);
              logTranscriptEvent(action.action, rawSelector, `HEALING_FAILED: ${err.message}`, 'FAILED', action.scenarioName);
              break;
            }

            const healTarget = confidentSelectors[attempts - 1] || confidentSelectors[0];
            const newSelector = healTarget.selector;
            emitLog('healing', `Trying fallback selector: ${newSelector} (Confidence: ${healTarget.confidence})`);
            addStep('HEAL', 'PASSED', Date.now() - healStart, `New selector: ${newSelector} (Conf: ${healTarget.confidence})`, undefined, newSelector);
            action.selector = newSelector;
          }
        }
        }
        
        if (scriptBlocked) {
          if (recoveryAttempt >= 3) {
            throw new Error("BLOCKED_BY_ANTIBOT: Site protected by anti-bot mechanisms after 3 recovery attempts.");
          }
          continue; // Move to next recovery attempt
        }
        
        finalAttemptSuccess = true;
        
        // Mark any IN_PROGRESS or NOT_STARTED scenarios as PASS if they had actions that executed successfully.
        // Wait, if an action was executed and we didn't throw, we can mark all IN_PROGRESS as PASS.
        // Also any NOT_STARTED that didn't even have actions might be SKIPPED later, 
        // but if the entire execution plan finishes successfully, all generated scenarios passed.
        for (const scenario in scenario_status) {
           if (scenario_status[scenario] === 'IN_PROGRESS' || scenario_status[scenario] === 'PASS') {
              const t = assertionTally[scenario];
              if (t && t.failed === 0 && t.passed === 0 && t.skipped > 0) {
                 // Every verification step was unresolved: nothing was actually verified, so this is
                 // NOT a pass. (A run that only navigated and never checked anything proves nothing.)
                 scenario_status[scenario] = 'FAIL';
                 addStep('SCENARIO_UNVERIFIED', 'FAILED', 0, `${scenario}: none of its ${t.skipped} verification step(s) could be evaluated, so the scenario is not reported as passed.`, undefined, undefined);
                 logTranscriptEvent('scenario', '', `Unverified: ${t.skipped} check(s) skipped, 0 evaluated`, 'FAILED', scenario);
              } else {
                 scenario_status[scenario] = 'PASS';
              }
           }
        }

        break; // Successfully completed actions, exit recovery loop
      }
      
      if (!finalAttemptSuccess) {
         throw new Error("Execution failed after recovery attempts");
      }
      
      if (options.accessibility) {
        emitLog('agent_log', 'Running AccessibilityAgent scans...');
        const { AccessibilityAgent } = await import('./AccessibilityAgent');
        const a11yAgent = new AccessibilityAgent();
        accessibilityResults = await a11yAgent.runAccessibilityScan(page);
        if (!accessibilityResults.success) {
           addStep('ACCESSIBILITY', 'FAILED', 0, `Violations found: ${accessibilityResults.violations.length}`);
           emitLog('agent_log', `Accessibility failed with ${accessibilityResults.violations.length} violations.`);
        } else {
           addStep('ACCESSIBILITY', 'PASSED', 0, 'No WCAG violations found.');
        }
      }

      if (options.security) {
        const { SecuritySanityAgent } = await import('./SecuritySanityAgent');
        const securityAgent = new SecuritySanityAgent();
        securityResults = await securityAgent.runSecurityChecks(page);
        if (!securityResults.success) {
           addStep('SECURITY', 'FAILED', 0, 'Mixed content or insecure forms found.');
        } else {
           addStep('SECURITY', 'PASSED', 0, 'Basic security checks passed.');
        }
      }
      
      success = true;
    } catch (err: any) {
      success = false;
      executionError = err.message;
      emitLog('browser_log', `Execution failed: ${err.message}`);
      addStep('EXECUTION', 'FAILED', err.message);
      
      // Mark any pending scenarios as FAILED or SKIPPED
      for (const scenario in scenario_status) {
         if (scenario_status[scenario] === 'IN_PROGRESS') {
            scenario_status[scenario] = 'FAIL';
         } else if (scenario_status[scenario] === 'NOT_STARTED') {
            scenario_status[scenario] = 'SKIPPED';
         }
      }
      
      // Capture screenshot on failure
      const stepIndex = stepLogs.length + 1; const shotSeq = nextFailShot(executionId);
      const screenshotPath = `./temp/screenshots/${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      try {
        const fileData = await fs.readFile(screenshotPath);
        const { data, error } = await supabase.storage
          .from('screenshots')
          .upload(`${executionId}-failed-step-${stepIndex}-f${shotSeq}.png`, fileData, { contentType: 'image/png', upsert: true });
          
        if (!error && data) {
          const { data: publicData } = supabase.storage.from('screenshots').getPublicUrl(data.path);
          screenshotUrl = publicData.publicUrl;
          emitLog('screenshot_uploaded', 'Screenshot uploaded successfully');
        }
      } catch (uploadErr) {
        console.error("Screenshot upload failed", uploadErr);
      }
      
      // Safety net: anything still NOT_STARTED gets SKIPPED
      for (const scenario in scenario_status) {
         if (scenario_status[scenario] === 'NOT_STARTED') {
            scenario_status[scenario] = 'SKIPPED';
         }
      }
    } finally {
      if (frameInterval) clearInterval(frameInterval);
      
      let visualRegressionData: string | null = null;
      const wantsAiEyes = !!options.enableAiEyes;
      const wantsVisualBaseline = !!options.enableVisualBaseline;
      if ((wantsAiEyes || wantsVisualBaseline) && !page.isClosed()) {
        let finalScreenshotData: Buffer | null = null;
        try {
          const finalScreenshotPath = `./temp/screenshots/${executionId}_final.png`;
          await page.screenshot({ path: finalScreenshotPath, fullPage: true });
          if (fsSync.existsSync(finalScreenshotPath)) {
            finalScreenshotData = await fs.readFile(finalScreenshotPath);
          }
        } catch (e: any) {
          emitLog('agent_log', `Final screenshot capture failed: ${e.message}`);
        }

        // Both sub-checks below are additional SIGNALS, exactly like the
        // pre-existing AI Eyes behavior they sit alongside: neither ever
        // flips the overall execution's pass/fail — they only add a step
        // and a data point. A test that doesn't opt into either sees no
        // change at all (both flags default off).
        let aiEyesResult: { hasVisualBugs: boolean; issues: string[] } | null = null;
        let baselineResult: import('./VisualRegressionAgent').VisualBaselineResult | null = null;

        if (finalScreenshotData && wantsAiEyes) {
          try {
            emitLog('agent_log', 'Running VisualRegressionAgent (AI Eyes)...');
            const base64Image = finalScreenshotData.toString('base64');
            const { VisualRegressionAgent } = await import('./VisualRegressionAgent');
            const visualAgent = new VisualRegressionAgent(executionId);
            aiEyesResult = await visualAgent.analyzeScreenshot(base64Image);
            if (aiEyesResult.hasVisualBugs) {
                emitLog('agent_log', `AI Eyes detected visual bugs: ${aiEyesResult.issues.join(', ')}`);
                addStep('AI_EYES', 'FAILED', 0, `Visual bugs detected: ${aiEyesResult.issues.join(', ')}`);
            } else {
                emitLog('agent_log', `AI Eyes found no visual bugs.`);
                addStep('AI_EYES', 'PASSED', 0, 'No visual bugs detected.');
            }
          } catch (e: any) {
            emitLog('agent_log', `AI Eyes analysis failed: ${e.message}`);
            console.error("AI Eyes processing failed", e);
          }
        }

        if (finalScreenshotData && wantsVisualBaseline) {
          try {
            emitLog('agent_log', 'Running visual baseline comparison...');
            const { VisualRegressionAgent } = await import('./VisualRegressionAgent');
            const visualAgent = new VisualRegressionAgent(executionId);
            const baselineKey = options.visualBaselineKey || `${options.testName || 'untitled'}::${options.targetUrl || ''}`;
            baselineResult = await visualAgent.compareAgainstBaseline(baselineKey, finalScreenshotData);
            if (baselineResult.error) {
              emitLog('agent_log', `Visual baseline comparison: ${baselineResult.error}`);
              addStep('VISUAL_BASELINE', 'SKIPPED', 0, baselineResult.error);
            } else if (!baselineResult.hasBaseline) {
              emitLog('agent_log', "No prior baseline for this test — this run's screenshot is now the baseline.");
              addStep('VISUAL_BASELINE', 'SKIPPED', 0, 'Baseline established from this run; nothing to compare yet.');
            } else {
              emitLog('agent_log', `Visual diff vs baseline: ${baselineResult.diffPercent}% of pixels changed.`);
              addStep('VISUAL_BASELINE', baselineResult.passed ? 'PASSED' : 'FAILED', 0,
                `${baselineResult.diffPercent}% pixel difference vs baseline (${baselineResult.mismatchedPixels}/${baselineResult.totalPixels} px).`);
            }
          } catch (e: any) {
            emitLog('agent_log', `Visual baseline comparison failed: ${e.message}`);
          }
        }

        if (aiEyesResult || baselineResult) {
          visualRegressionData = JSON.stringify({ aiEyes: aiEyesResult, baseline: baselineResult });
        }
      }

      if (!options.sharedPage) {
        const video = page.video();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});

        // Video processing
        try {
          if (video) {
            const videoPath = await video.path();
            if (fsSync.existsSync(videoPath)) {
              const stats = fsSync.statSync(videoPath);
              if (stats.size === 0) {
                throw new Error("Video artifact is empty");
              }
              const videoData = await fs.readFile(videoPath);
              const { data, error } = await supabase.storage
                .from('videos')
                .upload(`${executionId}.mp4`, videoData, { contentType: 'video/mp4', upsert: true });
                
              if (!error && data) {
                const { data: publicData } = supabase.storage.from('videos').getPublicUrl(data.path);
                videoUrl = publicData.publicUrl;
              } else {
                console.error("Supabase upload error:", error);
              }
            }
          }
        } catch (e) {
          console.error("Video processing failed", e);
        }
      }

      return {
        success,
        error: executionError,
        screenshotUrl,
        videoUrl,
        stepLogs,
        transcriptEvents,
        accessibilityResults,
        securityResults,
        scenario_status,
        visualRegressionData
      };
    }
  }
}
