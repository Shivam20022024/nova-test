/**
 * reportTransform.js
 * Normalization and derivation layer for NovaTest AI Test Intelligence Report.
 * Guarantees a stable, fully populated data contract for all UI components.
 */

import { formatDuration, formatTimestamp, classifyIssue, classifyFailure, getBusinessImpact } from "./reportMetrics";

function normalizeStatus(status) {
  const value = String(status ?? "").trim().toUpperCase();
  if (["PASS", "PASSED", "SUCCESS"].includes(value)) return "PASSED";
  if (["FAIL", "FAILED", "ERROR", "FAILURE"].includes(value)) return "FAILED";
  if (["SKIP", "SKIPPED"].includes(value)) return "SKIPPED";
  return "FAILED";
}

export function normalizeExecutionReport(execution, aiReport = null) {
  if (!execution) return null;

  // 1. Basic Metadata
  const id = execution.id || "unknown-run";
  const runNumber = id.substring(0, 8);
  const suiteName = execution.testName || execution.suite?.name || "QA Automated Execution";
  const targetUrl = execution.targetUrl || aiReport?.url || execution.suite?.project?.url || null;
  const testDescription = execution.description || aiReport?.workflow || null;
  const browser = (execution.browser || "chromium").toLowerCase();
  const environment = execution.environment || execution.suite?.environment || "Staging";
  const durationMs = execution.durationMs || (execution.completedAt && execution.startedAt ? new Date(execution.completedAt) - new Date(execution.startedAt) : (aiReport?.duration ? aiReport.duration * 1000 : 0));
  const createdAt = execution.createdAt || new Date().toISOString();
  const startedAt = execution.startedAt || createdAt;
  const completedAt = execution.completedAt || null;

  // 2. Safe Parsing of Step Logs
  let rawStepLogs = [];
  try {
    if (Array.isArray(execution.stepLogs)) {
      rawStepLogs = execution.stepLogs;
    } else if (typeof execution.stepLogs === "string") {
      const parsed = JSON.parse(execution.stepLogs);
      rawStepLogs = Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    rawStepLogs = [];
  }

  // 3. Extract Embedded EXECUTION_RESULT if present
  let executionResult = execution.execution_result || null;
  if (!executionResult && rawStepLogs.length > 0) {
    try {
      const resLog = rawStepLogs.find((s) => s.action === "EXECUTION_RESULT");
      if (resLog && resLog.value) {
        executionResult = typeof resLog.value === "string" ? JSON.parse(resLog.value) : resLog.value;
      }
    } catch {
      executionResult = null;
    }
  }

  // 4. Safe Parsing of Visual Regression
  let visualRegression = null;
  try {
    if (execution.visualRegressionData) {
      visualRegression = typeof execution.visualRegressionData === "string" ? JSON.parse(execution.visualRegressionData) : execution.visualRegressionData;
    }
  } catch {
    visualRegression = null;
  }

  // 5. Normalizing Transcript / Step Events
  let transcript = executionResult?.transcript || [];
  if (!transcript || transcript.length === 0) {
    transcript = rawStepLogs.map((s, idx) => ({
      action: s.action || "Step",
      target: s.target || s.rawSelector || null,
      value: s.error || s.value || s.details || null,
      status: s.status ? s.status.toUpperCase() : "INFO",
      scenarioName: s.scenarioName || (s.action === "HEAL" ? "Self Healing Engine" : suiteName),
      timestamp: s.time ? new Date(s.time).toLocaleTimeString() : `Step ${idx + 1}`,
      durationMs: s.durationMs || 0,
      details: s.details || null,
      rawSelector: s.rawSelector || null,
    }));
  }

  // 6. Normalizing Scenarios / Test Cases
  const scenarioMap = {};
  if (executionResult?.scenario_status && typeof executionResult.scenario_status === "object") {
    Object.entries(executionResult.scenario_status).forEach(([name, status]) => {
      scenarioMap[name] = {
        name,
        status: normalizeStatus(status),
        events: [],
        durationMs: 0,
        healed: false,
        error: null,
      };
    });
  }

  transcript.forEach((ev) => {
    const sName = ev.scenarioName || suiteName;
    if (!scenarioMap[sName]) {
      scenarioMap[sName] = {
        name: sName,
        status: "PASSED",
        events: [],
        durationMs: 0,
        healed: false,
        error: null,
      };
    }
    scenarioMap[sName].events.push(ev);
    scenarioMap[sName].durationMs += ev.durationMs || 0;
    if (ev.status === "ERROR" || ev.status === "FAILED") {
      scenarioMap[sName].status = "FAILED";
      if (!scenarioMap[sName].error) {
        scenarioMap[sName].error = ev.value || ev.details || "Step failed";
      }
    }
    if (ev.action === "HEAL") {
      scenarioMap[sName].healed = true;
    }
  });

  let parsedTestCases = [];
  try {
    if (execution.testMetadata) {
      const meta = JSON.parse(execution.testMetadata);
      if (Array.isArray(meta.testCases) && meta.testCases.length > 0) {
        parsedTestCases = meta.testCases;
      }
    }
  } catch (e) {
    // Ignore parse error
  }

  let scriptActions = [];
  try {
    if (execution.planData) {
      let plan = typeof execution.planData === "string" ? JSON.parse(execution.planData) : execution.planData;
      if (plan.scriptCode) {
        scriptActions = typeof plan.scriptCode === "string" ? JSON.parse(plan.scriptCode) : plan.scriptCode;
      }
    }
  } catch (e) {}

  let globalTotalSteps = 0;
  let globalPassedSteps = 0;
  let globalFailedSteps = 0;
  let globalSkippedSteps = 0;

  let rawActionsCount = 0;
  let normalizedActionsCount = 0;
  let executionActionsCount = 0;
  let executableActionsCount = 0;
  let excludedMetaActionsCount = 0;
  let duplicateActionsRemovedCount = 0;
  let finalStepCount = 0;

  const VALID_ACTIONS = new Set(["goto", "click", "fill", "select", "check", "uncheck", "hover", "press", "assertVisible", "assertText", "assertValue", "upload", "screenshot", "wait"]);

  /* ── Telemetry-authoritative step helpers (report accuracy layer) ──────────
   * An "executable step" is a real user-facing test action. Meta / framework /
   * evidence events (PARSE_JSON, HEAL, EXECUTION_RESULT, ACCESSIBILITY,
   * SECURITY, AI_EYES, screenshots, telemetry markers, plain logs) are never
   * counted as steps. A wait bound to a specific locator is an internal sync
   * wait, not a step. */
  const EXECUTABLE_ACTIONS = new Set([
    "goto", "click", "fill", "type", "select", "check", "uncheck", "hover", "press",
    "assertvisible", "asserttext", "assertvalue", "assertnotvisible", "upload", "wait",
  ]);
  const META_ACTIONS = new Set([
    "parse_json", "heal", "execution", "execution_result", "accessibility", "security",
    "ai_eyes", "screenshot", "consolecapture", "log",
  ]);

  const isExecutableEvent = (ev) => {
    const a = String(ev?.action || "").trim().toLowerCase();
    if (!a || META_ACTIONS.has(a)) return false;
    if (!EXECUTABLE_ACTIONS.has(a)) return false;
    if (a === "wait") {
      const tgt = ev.selector || ev.target || ev.rawSelector || "";
      if (tgt && String(tgt).trim() !== "") return false;
    }
    return true;
  };

  const normStepStatus = (s) => {
    const v = String(s || "").trim().toUpperCase();
    if (["PASSED", "PASS", "SUCCESS", "DONE", "HEALED", "OK", "COMPLETED"].includes(v)) return "PASSED";
    if (["FAILED", "FAIL", "ERROR", "FAILURE"].includes(v)) return "FAILED";
    if (["SKIPPED", "SKIP", "NOT_STARTED", "NOT STARTED"].includes(v)) return "SKIPPED";
    return "INFO";
  };

  const safeSelector = (sel) => {
    const v = sel == null ? "" : String(sel).trim();
    if (!v || v.toLowerCase() === "null" || v.toLowerCase() === "undefined") return null;
    return v;
  };

  const selectorTypeOf = (sel) => {
    const v = safeSelector(sel);
    if (!v) return "NONE";
    if (/getbyrole|getbylabel|getbytext|getbyplaceholder|getbytestid|\brole=/i.test(v)) return "ARIA / ROLE";
    if (/\[data-test(id)?\s*=|\bdata-test(id)?\b/i.test(v)) return "DATA-TEST ATTRIBUTE";
    if (/^#|\bid\s*=/.test(v)) return "ID";
    if (/^xpath=|^\/\//i.test(v)) return "XPATH";
    if (/name\s*=|placeholder\s*=|aria-label\s*=/i.test(v)) return "ATTRIBUTE";
    if (/^https?:\/\//i.test(v)) return "URL";
    return "CSS";
  };

  function processScenarioSteps(name, actions, tcResult) {
    const generatedActions = scriptActions.filter(a => (a.scenarioName || "").toLowerCase() === (name || "").toLowerCase());

    // Fallback to telemetry events only if no script actions could be parsed
    const rawActions = generatedActions.length > 0 ? generatedActions : (actions || tcResult.events || []);

    // Planned executable step count — used ONLY when a scenario produced no
    // telemetry at all (fully skipped / never started).
    const plannedSigs = new Set();
    rawActions.forEach(a => {
      const type = String(a.action || "").trim().toLowerCase();
      if (!EXECUTABLE_ACTIONS.has(type)) { excludedMetaActionsCount++; return; }
      const target = a.selector || a.target || a.url || a.rawSelector || "";
      if (type === "wait" && target && String(target).trim() !== "") { excludedMetaActionsCount++; return; }
      const val = a.value || a.contains || a.details || "";
      const sig = `${type}|${target}|${val}`;
      if (plannedSigs.has(sig)) duplicateActionsRemovedCount++;
      else plannedSigs.add(sig);
    });
    const plannedSteps = plannedSigs.size;

    // AUTHORITATIVE: count executed steps straight from this scenario's step
    // telemetry, using each step's own recorded status.
    const execEvents = (tcResult.events || []).filter(isExecutableEvent);

    rawActionsCount += rawActions.length;
    normalizedActionsCount += rawActions.length;
    executionActionsCount += execEvents.length;
    executableActionsCount += execEvents.length;

    let passedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;
    let expectedSteps = 0;

    if (execEvents.length > 0) {
      execEvents.forEach(ev => {
        const st = normStepStatus(ev.status);
        if (st === "FAILED") failedSteps++;
        else if (st === "SKIPPED") skippedSteps++;
        else passedSteps++; // PASSED, or an executed step with no explicit failure marker
      });
      expectedSteps = passedSteps + failedSteps + skippedSteps;
    } else {
      // No executable telemetry for this scenario — planned steps are skipped
      // (unless the scenario is marked PASSED, which shouldn't happen with 0
      // events, but keep it consistent if it does).
      expectedSteps = plannedSteps;
      if (tcResult.status === "PASSED") passedSteps = plannedSteps;
      else skippedSteps = plannedSteps;
    }

    // Reconcile with the scenario verdict (also telemetry, from scenario_status):
    // a FAILED scenario must carry at least one failed step so the report never
    // shows "scenario failed / 0 failed steps".
    if (tcResult.status === "FAILED" && failedSteps === 0) {
      if (passedSteps > 0) { passedSteps -= 1; failedSteps = 1; }
      else { failedSteps = 1; expectedSteps += 1; }
    }

    finalStepCount += expectedSteps;
    console.log(`[SCENARIO_STEP_COUNT]\nscenario="${name}"\nsteps=${expectedSteps}\npassed=${passedSteps}\nfailed=${failedSteps}\nskipped=${skippedSteps}\nstatus="${tcResult.status}"`);

    globalTotalSteps += expectedSteps;
    globalPassedSteps += passedSteps;
    globalFailedSteps += failedSteps;
    globalSkippedSteps += skippedSteps;

    return { expectedSteps, passedSteps, failedSteps, skippedSteps };
  }

  let tests = [];
  if (parsedTestCases.length > 0) {
    tests = parsedTestCases.map((tc, idx) => {
      const scenarioKey = tc.name || tc.scenario || "Excel Scenario";
      const tcResult = scenarioMap[scenarioKey] || scenarioMap[tc.scenario] || {
        status: "FAILED",
        events: [],
        durationMs: 0,
        error: "Test case execution data missing",
        healed: false
      };
      
      const isPass = tcResult.status === "PASSED";
      const scenarioLabel = tc.name || tcResult.name;
      const classification = !isPass
        ? classifyIssue(tcResult.error, safeSelector(tcResult.events.find((e) => e.target)?.target), { scenario: scenarioLabel, healed: tcResult.healed })
        : null;

      const { expectedSteps, passedSteps, failedSteps, skippedSteps } = processScenarioSteps(tc.name || tcResult.name, tc.actions, tcResult);

      return {
        id: tc.id || `tc-${idx}`,
        scenario: tc.scenario || tcResult.name,
        name: tc.name || tcResult.name,
        status: tcResult.status,
        durationMs: tcResult.durationMs,
        browser,
        risk: isPass ? "LOW" : classification?.severity === "CRITICAL" ? "CRITICAL" : classification?.severity === "MEDIUM" ? "MEDIUM" : "HIGH",
        healed: tcResult.healed,
        events: tcResult.events,
        error: tcResult.error,
        classification,
        impact: !isPass ? getBusinessImpact(tcResult.name) : null,
        totalSteps: expectedSteps,
        passedSteps,
        failedSteps,
        skippedSteps,
      };
    });
  } else {
    tests = Object.values(scenarioMap).map((tc, idx) => {
      const isPass = tc.status === "PASSED";
      const classification = !isPass
        ? classifyIssue(tc.error, safeSelector(tc.events.find((e) => e.target)?.target), { scenario: tc.name, healed: tc.healed })
        : null;

      const { expectedSteps, passedSteps, failedSteps, skippedSteps } = processScenarioSteps(tc.name, tc.events, tc);

      return {
        id: `tc-${idx}`,
        scenario: tc.name,
        name: tc.name,
        status: tc.status,
        durationMs: tc.durationMs,
        browser,
        risk: isPass ? "LOW" : classification?.severity === "CRITICAL" ? "CRITICAL" : classification?.severity === "MEDIUM" ? "MEDIUM" : "HIGH",
        healed: tc.healed,
        events: tc.events,
        error: tc.error,
        classification,
        impact: !isPass ? getBusinessImpact(tc.name) : null,
        totalSteps: expectedSteps,
        passedSteps,
        failedSteps,
        skippedSteps,
      };
    });
  }

  console.log(`[STEP_AGGREGATION]\nrawActions=${rawActionsCount}\nnormalizedActions=${normalizedActionsCount}\nexecutionActions=${executionActionsCount}\nexecutableActions=${executableActionsCount}\nexcludedMetaActions=${excludedMetaActionsCount}\nduplicateActionsRemoved=${duplicateActionsRemovedCount}\nfinalStepCount=${finalStepCount}`);

  // 6b. Scenarios skipped because a prerequisite scenario failed (continuous
  //     session — the executor could not establish the required starting state).
  //     Sourced from the executor's own telemetry, never inferred.
  const upstreamBlockedNames = new Set();
  rawStepLogs.forEach((s) => {
    if (s.action === "SCENARIO_SKIPPED") {
      const m = String(s.details || "").match(/^(.*?):\s*blocked by upstream/i);
      if (m && m[1]) upstreamBlockedNames.add(m[1].trim());
    }
  });
  transcript.forEach((ev) => {
    if (String(ev.action).toLowerCase() === "scenario" && normalizeStatus(ev.status) === "SKIPPED" && /blocked by upstream/i.test(String(ev.value || ev.details || ""))) {
      if (ev.scenarioName) upstreamBlockedNames.add(ev.scenarioName);
    }
  });
  const blockedScenarios = tests
    .filter((t) => t.status === "SKIPPED" && upstreamBlockedNames.has(t.name))
    .map((t) => ({
      scenario: t.name,
      reason: "A prerequisite scenario failed; the required starting page/state could not be established, so this scenario was not executed.",
      category: "TEST_DESIGN_ERROR",
    }));

  // 7. Normalizing Healing Events — success / failure split comes straight
  //    from telemetry. A failed healing attempt is NEVER reported as recovered.
  const rawHealing = execution.healingEvents || [];
  const healingLogs = rawStepLogs.filter((s) => s.action === "HEAL");
  const healing = [];
  let healAttempts = 0;
  let healSuccesses = 0;

  const pushHeal = (id, origRaw, healedRaw, success, stepIndex, testName) => {
    const orig = safeSelector(origRaw);
    healing.push({
      id,
      // Never surface "null" as if it were a selector.
      originalSelector: orig || "Not available",
      selectorStatus: orig ? "PRESENT" : "MISSING_SELECTOR",
      healedSelector: success ? (safeSelector(healedRaw) || "Recovered element") : "None",
      success: !!success,
      status: success ? "RECOVERED" : "FAILED",
      recoveryType: orig ? "SELECTOR_DRIFT_RECOVERY" : "MISSING_SELECTOR_RECOVERY",
      testName: testName || suiteName,
      stepIndex: stepIndex ?? healing.length + 1,
      trigger: orig ? `Selector "${orig}" failed during interaction` : "Step executed without a usable selector",
      validationResult: success ? "Healed selector matched a live DOM element" : "No confident DOM match found",
      reason: success
        ? (orig ? "DOM selector drift resolved by the self-healing engine" : "Missing selector recovered by the self-healing engine")
        : "Self-healing attempted but could not locate an equivalent element",
      confidence: success ? 0.92 : 0.4,
    });
  };

  // Raw HEAL step telemetry is the authoritative attempt ledger because it
  // records BOTH successful and FAILED healing attempts (the healingEvents
  // table only stores successes). TRIGGERED opens an attempt; a following
  // PASSED closes it as recovered; an unclosed attempt is a failed recovery.
  const triggeredCount = healingLogs.filter((s) => String(s.status).toUpperCase() === "TRIGGERED").length;

  if (triggeredCount > 0) {
    let open = null;
    let idx = 0;
    healingLogs.forEach((s) => {
      const st = String(s.status || "").toUpperCase();
      if (st === "TRIGGERED") {
        if (open) { pushHeal(`heal-log-${idx++}`, open.rawSelector || open.details, null, false, open.stepIndex); }
        open = s;
      } else if (st === "PASSED" && open) {
        pushHeal(`heal-log-${idx++}`, open.rawSelector || open.details, s.rawSelector || s.details, true, open.stepIndex);
        open = null;
      }
    });
    if (open) pushHeal(`heal-log-${idx++}`, open.rawSelector || open.details, null, false, open.stepIndex);
    healAttempts = healing.length;
    healSuccesses = healing.filter((h) => h.success).length;

    // Enrich successful rows with the recorded healedSelector from healingEvents
    // when the step log only had the original.
    rawHealing.filter((h) => h.success === true).forEach((h) => {
      const match = healing.find((x) => x.success && (safeSelector(x.healedSelector) === null || x.healedSelector === "Recovered element"));
      if (match && safeSelector(h.healedSelector)) match.healedSelector = h.healedSelector;
    });
  } else if (rawHealing.length > 0) {
    // No HEAL step telemetry — fall back to the healingEvents table (successes,
    // plus any explicitly-failed rows).
    rawHealing.forEach((h, i) => {
      const ok = h.success === true;
      pushHeal(h.id || `heal-${i}`, h.originalSelector, h.healedSelector, ok, h.stepIndex ?? i + 1, h.testName);
    });
    healAttempts = rawHealing.length;
    healSuccesses = rawHealing.filter((h) => h.success === true).length;
  }

  const healingSummary = {
    attempts: healAttempts,
    successes: healSuccesses,
    failures: Math.max(0, healAttempts - healSuccesses),
    recoveryRate: healAttempts > 0 ? Number(((healSuccesses / healAttempts) * 100).toFixed(1)) : 0,
  };

  // 8. Normalizing Accessibility
  const rawA11y = executionResult?.accessibility || null;
  const a11yStepFailed = rawStepLogs.some(
    (s) => s.status === "FAILED" && (s.action?.toLowerCase().includes("access") || (s.error || "").toLowerCase().includes("accessibility"))
  );

  let a11yStatus = "UNAVAILABLE";
  let a11yViolations = [];
  let a11yScores = { critical: 0, serious: 0, moderate: 0, minor: 0 };

  if (rawA11y) {
    if (rawA11y.success === true) {
      a11yStatus = "COMPLIANT";
    } else if ((!rawA11y.violations || rawA11y.violations.length === 0) && rawA11y.error) {
      // The axe-core scan threw before producing results — this is NOT a
      // compliance verdict, so don't report "0 violations / NON_COMPLIANT".
      a11yStatus = "UNAVAILABLE";
    } else {
      a11yStatus = "NON_COMPLIANT";
      a11yViolations = rawA11y.violations || [];
      a11yViolations.forEach((v) => {
        const impact = (v.impact || "moderate").toLowerCase();
        if (a11yScores[impact] !== undefined) a11yScores[impact]++;
        else a11yScores.moderate++;
      });
    }
  } else if (a11yStepFailed) {
    a11yStatus = "PARTIAL_FAILURE";
  }

  // Telemetry-derived label — the accessibility section's single source of truth.
  const a11yEvaluated = a11yStatus === "COMPLIANT" || a11yStatus === "NON_COMPLIANT";
  const a11yLabel = a11yStatus === "COMPLIANT"
    ? "PASS"
    : a11yStatus === "NON_COMPLIANT"
      ? (a11yScores.critical > 0 || a11yScores.serious > 0 ? "FAIL" : "WARN")
      : "NOT_EVALUATED";

  // 9. Normalizing Security Sanity Checks — this is a NARROW sanity check
  //    (transport + form only), never a full security assessment. The report
  //    wording must reflect that scope.
  const rawSec = executionResult?.security || null;
  let secStatus = "UNAVAILABLE";
  let secIssues = { mixedContent: false, insecureForms: false, missingHeaders: [] };
  if (rawSec) {
    secStatus = rawSec.success ? "PASSED" : "ISSUES_DETECTED";
    if (rawSec.issues) {
      secIssues = {
        mixedContent: !!rawSec.issues.mixedContent,
        insecureForms: !!rawSec.issues.insecureForms,
        missingHeaders: Array.isArray(rawSec.issues.missingHeaders) ? rawSec.issues.missingHeaders : [],
      };
    }
  }
  const secEvaluated = !!rawSec;
  const secChecksPerformed = ["Mixed Content", "Insecure Form Actions"];
  const secLabel = !secEvaluated
    ? "NOT_EVALUATED"
    : secStatus === "PASSED"
      ? "PASS"
      : "WARN";
  const secScope = "Basic transport / form security sanity checks only. This is NOT a comprehensive security assessment (no auth, injection, headers, dependency, or infra testing).";

  // 10. Metrics Calculation — every value below derives from the SAME
  //     authoritative telemetry pass above, so totals can never contradict.
  const scenarioCount = tests.length || Object.keys(scenarioMap).length || 1;
  const testDataCount = scenarioCount;
  const testCaseCount = scenarioCount;

  // Scenario tallies (independent of step tallies).
  const passedScenarios = tests.length > 0
    ? tests.filter((t) => t.status === "PASSED").length
    : (executionResult?.metrics?.passed_count ?? (execution.status === "PASSED" || execution.status === "COMPLETED" ? 1 : 0));
  const failedScenarios = tests.length > 0
    ? tests.filter((t) => t.status === "FAILED").length
    : (executionResult?.metrics?.failed_count ?? (execution.status === "FAILED" ? 1 : 0));
  const skippedScenarios = tests.length > 0
    ? tests.filter((t) => t.status === "SKIPPED").length
    : (executionResult?.metrics?.skipped_count ?? 0);
  const partiallyPassedScenarios = tests.filter((t) => (t.passedSteps || 0) > 0 && (t.failedSteps || 0) > 0).length;

  // Step tallies — passed + failed + skipped === total, always.
  const passedSteps = globalPassedSteps;
  const failedSteps = globalFailedSteps;
  const skippedSteps = globalSkippedSteps;
  const totalSteps = passedSteps + failedSteps + skippedSteps;
  const executableStepTotal = totalSteps;

  // Pass rate = passed executable steps / total executable steps.
  const passRate = executableStepTotal > 0
    ? Number(((passedSteps / executableStepTotal) * 100).toFixed(2))
    : (execution.status === "PASSED" || execution.status === "COMPLETED" ? 100 : 0);

  console.log(`[STEP_PASS_RATE]\ntotalSteps=${totalSteps}\npassedSteps=${passedSteps}\nfailedSteps=${failedSteps}\nskippedSteps=${skippedSteps}\npassRate=${passRate}%`);
  console.log(`[REPORT_AGGREGATION]\nscenarios=${scenarioCount}\npassedScenarios=${passedScenarios}\nfailedScenarios=${failedScenarios}\nskippedScenarios=${skippedScenarios}\nsteps=${totalSteps}\npassedSteps=${passedSteps}\nfailedSteps=${failedSteps}\npassRate=${passRate}%`);

  // 11. Deterministic Quality Scorecard
  const functionalScore = passRate;
  const a11yScore = a11yStatus === "COMPLIANT" ? 100 : a11yStatus === "NON_COMPLIANT" ? Math.max(0, 100 - a11yViolations.length * 10) : null;
  const secScore = secStatus === "PASSED" ? 100 : secStatus === "ISSUES_DETECTED" ? 60 : null;
  const stabilityScore = aiReport?.dom_stability === "High" ? 98 : aiReport?.dom_stability === "Low" ? 50 : 85;

  let calculatedHealth = aiReport?.health_score ?? null;
  if (calculatedHealth == null) {
    let weightSum = 0.7;
    let scoreSum = functionalScore * 0.7;
    if (a11yScore != null) {
      scoreSum += a11yScore * 0.2;
      weightSum += 0.2;
    }
    if (secScore != null) {
      scoreSum += secScore * 0.1;
      weightSum += 0.1;
    }
    calculatedHealth = Math.round(scoreSum / weightSum);
  }

  // 11b. Execution Classification — separates an APPLICATION failure from a
  //      TEST / INFRASTRUCTURE / ANTI-BOT problem so the report never blames
  //      the site for a runner or environment issue.
  const rawStatusU = String(execution.status || "").toUpperCase();
  const logBlob = `${execution.logs || ""} ${execution.error || ""} ${aiReport?.reason || ""} ${aiReport?.ai_summary || ""}`.toLowerCase();

  const infraHit = /infrastructure failure|worker could not connect|redis connection|bullmq worker connection|econnrefused|etimedout|enotfound|upstash|supabase auth error|lock renewal failure|could not renew lock|und_err_connect_timeout|connecttimeouterror/.test(logBlob);
  const antiBotHit = rawStatusU === "BLOCKED" || /blockedbyantibot|blocked_by_antibot|anti-bot|\bcaptcha\b|recaptcha|cloudflare|just a moment|checking your browser|verify you are human|turnstile|http 403|\b403\b forbidden|http 429|\b429\b too many|access denied|bot detection|\bwaf\b/.test(logBlob);

  let executionClassification;
  if (infraHit) {
    executionClassification = {
      type: "INFRASTRUCTURE_FAILURE",
      executionStatus: "BLOCKED",
      blockType: "INFRASTRUCTURE",
      applicationEvaluated: false,
      reason: "An infrastructure / connectivity failure (queue, Redis, or Supabase) prevented the run from completing.",
      recommendedAction: "Restore backend connectivity and re-run. No application-quality conclusion can be drawn from this execution.",
    };
  } else if (antiBotHit) {
    executionClassification = {
      type: "ANTI_BOT_BLOCK",
      executionStatus: "BLOCKED",
      blockType: "ANTI-BOT / WAF",
      applicationEvaluated: false,
      reason: "Execution was blocked by an anti-bot challenge, WAF rule, or access-control response before the application could be validated.",
      recommendedAction: "Use an approved QA/test environment, allowlist the test runner, or enable the application's authorized automation-testing mode. This is not evidence of an application defect.",
    };
  } else if (failedScenarios > 0 || rawStatusU === "FAILED") {
    const failClasses = tests.filter((t) => t.status === "FAILED").map((t) => t.classification?.code).filter(Boolean);
    const anyAppDefect = tests.some((t) => t.status === "FAILED" && t.classification?.isApplicationDefect);
    // "Test-side" = the failure originates from the automation or the way the
    // scenario was designed, not from proven application behaviour.
    const TEST_SIDE = ["TEST_SCRIPT_ERROR", "SELECTOR_ERROR", "SELECTOR_DRIFT", "TIMING_ERROR", "PAGE_STATE_ERROR", "NAVIGATION_ERROR", "TEST_DESIGN_ERROR"];
    const allTestSide = failClasses.length > 0 && failClasses.every((c) => TEST_SIDE.includes(c));
    const anyAuth = failClasses.includes("AUTHENTICATION_ERROR");
    // Never default to "application defect" — that requires positive evidence.
    let ecType, ecReason;
    if (anyAppDefect) {
      ecType = "APPLICATION_FAILURE";
      ecReason = "One or more scenarios failed with evidence pointing to application behaviour (e.g. an assertion mismatch on an element that was present, or a server error).";
    } else if (allTestSide) {
      ecType = "TEST_EXECUTION_FAILURE";
      ecReason = "Scenario failures appear to originate from the automation or test design (selectors, timing, page state, navigation, sequencing) — not confirmed application defects.";
    } else if (anyAuth && failClasses.every((c) => c === "AUTHENTICATION_ERROR" || TEST_SIDE.includes(c))) {
      ecType = "TEST_EXECUTION_FAILURE";
      ecReason = "Authentication did not succeed. This is most often a test-data / credentials issue; confirm the credentials before treating it as an application defect.";
    } else {
      ecType = "INCONCLUSIVE";
      ecReason = "Scenario failures were detected but could not be confidently attributed to the application. Review each failure's evidence before assigning ownership — do not assume an application defect.";
    }
    executionClassification = {
      type: ecType,
      executionStatus: "COMPLETED",
      blockType: null,
      applicationEvaluated: true,
      reason: ecReason,
      recommendedAction: "Review the per-failure root cause below before assigning ownership.",
    };
  } else {
    executionClassification = {
      type: "COMPLETED",
      executionStatus: "COMPLETED",
      blockType: null,
      applicationEvaluated: true,
      reason: "Execution completed and every evaluated scenario passed.",
      recommendedAction: null,
    };
  }

  // 12. Deterministic Release Decision
  const isBlockedExecution = executionClassification.executionStatus === "BLOCKED";

  let decision = "APPROVED"; // "APPROVED" | "CONDITIONAL" | "BLOCKED"
  let decisionTitle = "APPROVED FOR PRODUCTION";
  let riskLevel = "LOW"; // "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  let decisionReasons = [];
  let applicationQuality = "EVALUATED";

  if (isBlockedExecution) {
    decision = "BLOCKED";
    decisionTitle = executionClassification.type === "ANTI_BOT_BLOCK"
      ? "EXECUTION BLOCKED — ANTI-BOT / WAF"
      : "RELEASE BLOCKED — INFRASTRUCTURE";
    riskLevel = "CRITICAL";
    applicationQuality = "NOT EVALUATED";
    decisionReasons.push(executionClassification.reason);
    decisionReasons.push(executionClassification.recommendedAction);
  } else if (failedScenarios > 0 || execution.status === "FAILED") {
    const hasCriticalFlowFailed = tests.some(
      (t) => t.status === "FAILED" && (
        /login|log ?in|auth|sign ?in|checkout|check ?out|payment|\bpay\b|\border\b|billing/i.test(t.name) || t.risk === "CRITICAL"
      )
    );
    const appDefect = executionClassification.type === "APPLICATION_FAILURE";
    if (!appDefect) applicationQuality = "INCONCLUSIVE — failures not confirmed as application defects; see Failure Details";
    if (hasCriticalFlowFailed || failedScenarios > Math.ceil(scenarioCount / 3)) {
      decision = "BLOCKED";
      decisionTitle = "RELEASE BLOCKED";
      riskLevel = "HIGH";
      decisionReasons.push(`${failedScenarios} of ${scenarioCount} scenario${failedScenarios > 1 ? "s" : ""} failed during execution.`);
      if (hasCriticalFlowFailed) decisionReasons.push("A core high-risk business workflow (login / checkout / payment) failed validation — the app could not be certified on that flow regardless of fault.");
      decisionReasons.push(appDefect
        ? "Failure evidence points to application behaviour."
        : `Root cause classification: ${executionClassification.type.replace(/_/g, " ").toLowerCase()} — confirm whether failures are application- or test/automation-side before release.`);
    } else {
      decision = "CONDITIONAL";
      decisionTitle = "CONDITIONAL APPROVAL";
      riskLevel = "MEDIUM";
      decisionReasons.push(`${failedScenarios} non-critical scenario failure${failedScenarios > 1 ? "s" : ""} detected.`);
      decisionReasons.push("Review failure root causes before proceeding to production.");
    }
  } else if (a11yStatus === "NON_COMPLIANT" && a11yScores.critical > 0) {
    decision = "CONDITIONAL";
    decisionTitle = "CONDITIONAL APPROVAL";
    riskLevel = "MEDIUM";
    decisionReasons.push("All functional scenarios passed, but a critical accessibility violation was detected.");
    decisionReasons.push("Review the affected control before release.");
  } else {
    decision = "APPROVED";
    decisionTitle = "APPROVED FOR PRODUCTION";
    riskLevel = "LOW";
    decisionReasons.push("All evaluated functional scenarios passed.");
    decisionReasons.push("No blocking defects, infrastructure faults, or access blocks detected.");
  }

  // 13. Failures List — every field derived from this run's own telemetry.
  const rawShots = execution.screenshots || [];
  const screenshotsPresent = rawShots.length > 0;
  const evidenceRef = screenshotsPresent
    ? "Failure screenshot captured — see the Screenshot / Evidence section"
    : "Evidence unavailable — no screenshot was captured for this step";
  // A run's failure screenshot(s): the engine names failure captures
  // "<id>-failed-step-<N>.png" / "<id>.png". Cite the actual URL so the
  // developer can open it — but only claim step-precision when there is exactly
  // one failure screenshot AND one failed step (otherwise the mapping is not
  // reliable, and Priority 9 forbids showing the wrong step's screenshot).
  const failureShots = rawShots.filter((s) => /failed-step-\d+/i.test(`${s.url || ""} ${s.storagePath || ""}`));
  // If there is only one screenshot overall and the run failed, it is the
  // failure capture even without a "failed-step" name.
  const effectiveFailureShots = failureShots.length > 0
    ? failureShots
    : (rawShots.length === 1 && (String(execution.status || "").toUpperCase() === "FAILED") ? rawShots : []);
  const singleFailureShotUrl = effectiveFailureShots.length === 1 ? effectiveFailureShots[0].url : null;
  const totalFailedStepsAll = (() => {
    try {
      return rawStepLogs.filter((s) => normStepStatus(s.status) === "FAILED" && isExecutableEvent(s)).length;
    } catch { return 0; }
  })();
  const evidenceForStep = () => {
    if (singleFailureShotUrl && totalFailedStepsAll <= 1) return `Failure screenshot (this step): ${singleFailureShotUrl}`;
    if (effectiveFailureShots.length > 0 || failureShots.length > 0) return `Failure screenshot(s) captured — see the Screenshot / Evidence section${singleFailureShotUrl ? ` (${singleFailureShotUrl})` : ""}`;
    return evidenceRef;
  };

  // Per failed executable step: reconstruct scenario / page / action / selector
  // / error / category / root cause / developer action from telemetry.
  function buildFailureDetails(t) {
    const evs = t.events || [];
    let currentPage = targetUrl || null;
    let stepNo = 0;
    const details = [];

    evs.forEach((ev) => {
      const act = String(ev.action || "").toLowerCase();
      if (act === "goto") {
        currentPage = safeSelector(ev.target || ev.url || ev.rawSelector) || currentPage;
      }
      if (isExecutableEvent(ev)) stepNo++;
      if (normStepStatus(ev.status) !== "FAILED") return;

      const sel = safeSelector(ev.selector || ev.target || ev.rawSelector);
      const errText = ev.value || ev.details || ev.error || t.error || "Step failed";
      const cls = classifyFailure(errText, sel, {
        scenario: t.name,
        page: currentPage,
        action: act,
        risk: t.risk,
        healed: t.healed,
      });

      details.push({
        scenario: t.name,
        page: currentPage || "Not available",
        stepNumber: stepNo || null,
        action: (ev.action || "STEP").toUpperCase(),
        selector: sel || "Not available",
        selectorStatus: sel ? "PRESENT" : "MISSING_SELECTOR",
        selectorType: selectorTypeOf(sel),
        expectedResult: cls.expected,
        actualResult: cls.actual,
        error: String(errText).slice(0, 400),
        failureCategory: cls.code,
        severity: cls.severity,
        likelyRootCause: cls.likelyCause,
        developerAction: cls.developerAction,
        isApplicationDefect: cls.isApplicationDefect,
        healed: t.healed,
        evidence: evidenceForStep(),
      });
    });

    if (details.length === 0 && t.status === "FAILED") {
      const sel = safeSelector((t.events.find((e) => e.target) || {}).target);
      const cls = classifyFailure(t.error, sel, { scenario: t.name, page: currentPage, risk: t.risk, healed: t.healed });
      details.push({
        scenario: t.name,
        page: currentPage || "Not available",
        stepNumber: null,
        action: "SCENARIO",
        selector: sel || "Not available",
        selectorStatus: sel ? "PRESENT" : "MISSING_SELECTOR",
        selectorType: selectorTypeOf(sel),
        expectedResult: cls.expected,
        actualResult: cls.actual,
        error: String(t.error || "Scenario failed").slice(0, 400),
        failureCategory: cls.code,
        severity: cls.severity,
        likelyRootCause: cls.likelyCause,
        developerAction: cls.developerAction,
        isApplicationDefect: cls.isApplicationDefect,
        healed: t.healed,
        evidence: evidenceForStep(),
      });
    }
    return details;
  }

  const failures = tests
    .filter((t) => t.status === "FAILED")
    .map((t) => {
      const failureDetails = buildFailureDetails(t);
      const primary = failureDetails[0] || {};
      return {
        scenario: t.scenario || t.name,
        severity: primary.severity || t.risk,
        error: primary.error || t.error || "Step failed",
        classification: t.classification,
        failureCategory: primary.failureCategory || t.classification?.code || "UNKNOWN",
        impact: t.impact || getBusinessImpact(t.name),
        events: t.events.filter((e) => normStepStatus(e.status) === "FAILED"),
        failureDetails,
        page: primary.page || targetUrl || "Not available",
        failedElement: primary.selector || "Not available",
        rootCause: primary.likelyRootCause || t.error || "Root cause could not be determined from telemetry.",
        suggestedFix: primary.developerAction || "Review the step telemetry, screenshot, and video for this scenario.",
      };
    });

  // Overall run failed but no scenario-level failure was isolated.
  if (failures.length === 0 && (execution.status === "FAILED" || isBlockedExecution)) {
    const cls = classifyFailure(execution.error || aiReport?.reason, null, { scenario: suiteName });
    failures.push({
      scenario: suiteName,
      severity: isBlockedExecution ? "CRITICAL" : cls.severity,
      error: execution.error || aiReport?.reason || "Execution failed",
      classification: cls,
      failureCategory: isBlockedExecution ? executionClassification.type : cls.code,
      impact: isBlockedExecution ? "Execution was blocked before application quality could be assessed." : "Workflow failed validation.",
      events: [],
      failureDetails: [{
        scenario: suiteName,
        page: targetUrl || "Not available",
        stepNumber: null,
        action: "EXECUTION",
        selector: "Not available",
        selectorStatus: "MISSING_SELECTOR",
        selectorType: "NONE",
        expectedResult: cls.expected,
        actualResult: cls.actual,
        error: String(execution.error || "Execution failed").slice(0, 400),
        failureCategory: isBlockedExecution ? executionClassification.type : cls.code,
        severity: isBlockedExecution ? "CRITICAL" : cls.severity,
        likelyRootCause: isBlockedExecution ? executionClassification.reason : cls.likelyCause,
        developerAction: isBlockedExecution ? executionClassification.recommendedAction : cls.developerAction,
        isApplicationDefect: false,
        healed: false,
        evidence: evidenceForStep(),
      }],
      page: targetUrl || "Not available",
      failedElement: "Not available",
      rootCause: isBlockedExecution ? executionClassification.reason : (cls.likelyCause || execution.error || "System error during test execution"),
      suggestedFix: isBlockedExecution ? executionClassification.recommendedAction : cls.developerAction,
    });
  }

  // 13b. Developer Action Center — one row per distinct failed element / issue,
  //      priority derived from severity (never random).
  const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const developerActions = [];
  failures.forEach((f) => {
    (f.failureDetails || []).forEach((d) => {
      developerActions.push({
        priority: d.severity || "MEDIUM",
        scenario: d.scenario,
        page: d.page,
        failedElement: d.selector,
        problem: `${d.action}: ${d.actualResult || d.error}`,
        recommendedAction: d.developerAction,
        category: d.failureCategory,
      });
    });
  });
  if (a11yStatus === "NON_COMPLIANT") {
    a11yViolations
      .filter((v) => ["critical", "serious"].includes(String(v.impact || "").toLowerCase()))
      .forEach((v) => {
        developerActions.push({
          priority: String(v.impact).toLowerCase() === "critical" ? "HIGH" : "MEDIUM",
          scenario: "Accessibility (WCAG)",
          page: targetUrl || "Not available",
          failedElement: v.id,
          problem: `WCAG violation (${v.impact}): ${v.description}`,
          recommendedAction: `Remediate the "${v.id}" rule on the affected node(s) before release.`,
          category: "ACCESSIBILITY",
        });
      });
  }
  healing.filter((h) => !h.success).forEach((h) => {
    developerActions.push({
      priority: "HIGH",
      scenario: h.testName,
      page: targetUrl || "Not available",
      failedElement: h.originalSelector,
      problem: `Self-healing could not recover ${h.originalSelector === "Not available" ? "a step with no selector" : `"${h.originalSelector}"`}`,
      recommendedAction: "Provide a stable selector for this step or confirm the target element still exists.",
      category: "SELF_HEALING_FAILURE",
    });
  });
  blockedScenarios.forEach((b) => {
    developerActions.push({
      priority: "MEDIUM",
      scenario: b.scenario,
      page: targetUrl || "Not available",
      failedElement: "n/a",
      problem: `Scenario skipped — ${b.reason}`,
      recommendedAction: `Fix the prerequisite scenario that failed before "${b.scenario}", or add the navigation/setup steps "${b.scenario}" needs to reach its own starting state. This is a test-design / sequencing issue, not an application defect.`,
      category: "TEST_DESIGN_ERROR",
    });
  });
  developerActions.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4));

  // 13c. Page-wise Validation Matrix — built only from pages actually visited.
  const pageMap = {};
  tests.forEach((t) => {
    let currentPage = targetUrl || "Not available";
    (t.events || []).forEach((ev) => {
      const act = String(ev.action || "").toLowerCase();
      if (act === "goto") currentPage = safeSelector(ev.target || ev.url || ev.rawSelector) || currentPage;
      if (!isExecutableEvent(ev)) return;
      if (!pageMap[currentPage]) {
        pageMap[currentPage] = { url: currentPage, scenarios: new Set(), stepsExecuted: 0, passed: 0, failed: 0, issues: [] };
      }
      const p = pageMap[currentPage];
      p.scenarios.add(t.name);
      p.stepsExecuted++;
      if (normStepStatus(ev.status) === "FAILED") {
        p.failed++;
        p.issues.push(`${(ev.action || "step").toUpperCase()} failed: ${String(ev.value || ev.details || "error").slice(0, 90)}`);
      } else {
        p.passed++;
      }
    });
  });
  const pageAnalysis = Object.values(pageMap).map((p) => ({
    url: p.url,
    scenarios: Array.from(p.scenarios),
    stepsExecuted: p.stepsExecuted,
    passed: p.passed,
    failed: p.failed,
    healingAttempts: null, // healing telemetry is not reliably page-scoped; see Self-Healing section
    issues: p.issues.slice(0, 5),
    status: p.failed > 0 ? "FAIL" : "PASS",
  }));

  // 13d. Performance — duration-based ONLY. Core Web Vitals (LCP/TBT/CLS) are
  //      not collected by this execution engine and must never be fabricated.
  const stepDurations = rawStepLogs
    .filter((s) => isExecutableEvent(s) && typeof s.durationMs === "number" && s.durationMs > 0)
    .map((s) => s.durationMs);
  const performance = {
    evaluated: stepDurations.length > 0 || durationMs > 0,
    executionDurationMs: durationMs || 0,
    executionDurationFormatted: formatDuration(durationMs || 0),
    avgStepDurationMs: stepDurations.length ? Math.round(stepDurations.reduce((a, b) => a + b, 0) / stepDurations.length) : null,
    fastestStepMs: stepDurations.length ? Math.min(...stepDurations) : null,
    slowestStepMs: stepDurations.length ? Math.max(...stepDurations) : null,
    coreWebVitals: null,
    note: "Derived from step execution timing. Browser performance metrics (LCP / TBT / CLS) are not collected by this runner.",
  };

  // 14. Screenshots & Evidence. The execution engine names failure captures
  //     "<executionId>-failed-step-<N>.png" — parse N so evidence can be tied
  //     to the step that failed rather than positionally guessed.
  const screenshots = (execution.screenshots || []).map((s, idx) => {
    const nameSrc = `${s.url || ""} ${s.storagePath || ""} ${s.name || ""}`;
    const stepMatch = nameSrc.match(/failed-step-(\d+)/i);
    const stepIndex = stepMatch ? parseInt(stepMatch[1], 10) : null;
    const isFailure = !!stepIndex || (failures.length > 0 && idx === execution.screenshots.length - 1);
    return {
      id: s.id || `shot-${idx}`,
      url: s.url,
      storagePath: s.storagePath || null,
      stepIndex,
      stepLabel: stepIndex ? `Captured at failed step ${stepIndex}` : null,
      title: s.name || (stepIndex ? `Failure State — step ${stepIndex}` : idx === 0 ? "Initial Viewport Snapshot" : isFailure ? "Failure State Snapshot" : `Step ${idx + 1} Snapshot`),
      timestamp: formatTimestamp(s.createdAt || execution.createdAt),
      isFailure,
    };
  });

  // 14b. API Requests (present only for executionType === 'API' runs)
  const requests = rawStepLogs
    .filter((s) => s.action === "http_request")
    .map((s, idx) => {
      let detail = null;
      try {
        detail = typeof s.value === "string" ? JSON.parse(s.value) : s.value;
      } catch {
        detail = null;
      }
      return {
        id: `req-${idx}`,
        method: detail?.method || "GET",
        url: detail?.url || "",
        status: detail?.status ?? null,
        latencyMs: detail?.latencyMs ?? s.durationMs ?? 0,
        requestHeaders: detail?.requestHeaders || {},
        requestBody: detail?.requestBody ?? null,
        responseHeaders: detail?.responseHeaders || {},
        responseBody: detail?.responseBody ?? null,
        assertionResults: detail?.assertionResults || [],
        schemaDrift: detail?.schemaDrift || [],
        extracted: detail?.extracted || {},
        passed: s.status === "PASSED",
        details: s.details || "",
      };
    });

  // 15. Videos
  const videos = (execution.videos || []).map((v, idx) => ({
    id: v.id || `vid-${idx}`,
    url: v.url,
    storagePath: v.storagePath || null,
    browser,
    durationFormatted: formatDuration(durationMs),
  }));

  // 16. AI Observations — telemetry-guarded. Any LLM observation that
  //     contradicts hard execution telemetry is dropped; deterministic,
  //     fact-derived observations are always present and listed first.
  const contradictsTelemetry = (o) => {
    const txt = `${o?.title || ""} ${o?.description || ""}`.toLowerCase();
    if (a11yViolations.length > 0 && /(no|zero|0)\s+(wcag|accessibility)\s+(violation|issue|problem)|fully\s+accessible|no\s+accessibility\s+(problem|violation|issue)/.test(txt)) return true;
    if (failedScenarios > 0 && /(all|every)\s+(scenario|test|workflow|step)s?\s+(pass|passed|succeed|succeeded|completed successfully)|no\s+failures?\s+(detected|found|occurred)|complete (test )?suite success/.test(txt)) return true;
    if (/100%\s*secure|application\s+is\s+secure|fully\s+secure|comprehensive security (assessment|scan)|no security (issues|risks)/.test(txt)) return true;
    if (healingSummary.failures > 0 && /all (selectors|healing)\s+(were\s+)?recovered|100%\s+(healing|recovery)/.test(txt)) return true;
    return false;
  };
  const llmObservations = (aiReport?.observations || []).filter((o) => o && !contradictsTelemetry(o));

  const detObservations = [];
  if (isBlockedExecution) {
    detObservations.push({
      type: "RISK",
      title: executionClassification.type === "ANTI_BOT_BLOCK" ? "Execution Blocked by Anti-Bot / WAF" : "Infrastructure Failure",
      description: `${executionClassification.reason} Application quality was NOT evaluated.`,
      evidence: String(execution.error || "").slice(0, 200),
    });
  } else if (failedScenarios === 0 && passedScenarios > 0) {
    detObservations.push({
      type: "SUCCESS",
      title: "All Scenarios Passed",
      description: `${passedScenarios} of ${scenarioCount} scenario(s) passed. ${passedSteps} of ${executableStepTotal} executable step(s) succeeded (${passRate}%).`,
      evidence: "",
    });
  }
  if (failedScenarios > 0) {
    detObservations.push({
      type: "RISK",
      title: `${failedScenarios} Scenario Failure${failedScenarios > 1 ? "s" : ""} Detected`,
      description: `${failedScenarios} of ${scenarioCount} scenario(s) failed; ${failedSteps} of ${executableStepTotal} executable step(s) failed.`,
      evidence: failures[0]?.failureDetails?.[0]?.error || failures[0]?.error || "",
    });
  }
  if (blockedScenarios.length > 0) {
    detObservations.push({
      type: "WARNING",
      title: `${blockedScenarios.length} Scenario${blockedScenarios.length > 1 ? "s" : ""} Skipped — Prerequisite Failed`,
      description: `${blockedScenarios.map((b) => `"${b.scenario}"`).join(", ")} could not run because a prerequisite scenario failed and the required starting page/state was not established. This is a test-design / sequencing issue, not an application defect — fix the failing prerequisite scenario first.`,
      evidence: "",
    });
  }
  if (a11yStatus === "COMPLIANT") {
    detObservations.push({
      type: "SUCCESS",
      title: "No WCAG Violations Detected",
      description: "The automated axe-core scan found no WCAG 2.1 A/AA violations in the audited DOM states.",
      evidence: "",
    });
  } else if (a11yStatus === "NON_COMPLIANT") {
    detObservations.push({
      type: "WARNING",
      title: `${a11yViolations.length} WCAG Accessibility Violation${a11yViolations.length > 1 ? "s" : ""} Detected`,
      description: `${a11yScores.critical} critical, ${a11yScores.serious} serious, ${a11yScores.moderate} moderate. The affected control(s) should be reviewed before release.`,
      evidence: a11yViolations[0]?.description || "",
    });
  }
  if (secEvaluated) {
    detObservations.push({
      type: secLabel === "PASS" ? "SUCCESS" : "WARNING",
      title: `Security Sanity Checks: ${secLabel}`,
      description: `${secScope} Checks performed: ${secChecksPerformed.join(", ")}.`,
      evidence: "",
    });
  }
  if (healingSummary.attempts > 0) {
    detObservations.push({
      type: healingSummary.failures > 0 ? "WARNING" : "INFO",
      title: "Self-Healing Activity",
      description: `${healingSummary.successes} of ${healingSummary.attempts} selector-healing attempt(s) recovered (${healingSummary.recoveryRate}%). ${healingSummary.failures} attempt(s) did not recover.`,
      evidence: "",
    });
  }

  const seenObsTitles = new Set();
  let observations = [...detObservations, ...llmObservations].filter((o) => {
    const k = String(o.title || "").toLowerCase().trim();
    if (!k || seenObsTitles.has(k)) return false;
    seenObsTitles.add(k);
    return true;
  });

  // Deterministic AI Executive Summary — assembled only from verified facts so
  // it can never contradict the scenario / step / a11y / security / healing /
  // infrastructure sections.
  const buildDeterministicSummary = () => {
    if (isBlockedExecution) {
      return `${executionClassification.reason} Application quality was NOT evaluated for this run. ${executionClassification.recommendedAction}`;
    }
    const parts = [];
    parts.push(`${passedScenarios} of ${scenarioCount} scenario(s) completed successfully.`);
    if (failedScenarios > 0) {
      const names = failures.map((f) => f.scenario).slice(0, 3).join(", ");
      parts.push(`${failedScenarios} scenario(s) encountered execution failures${names ? ` (${names})` : ""}.`);
      parts.push(`${passedSteps} of ${executableStepTotal} executable steps passed (${passRate}%).`);
      if (partiallyPassedScenarios > 0) parts.push(`${partiallyPassedScenarios} scenario(s) partially completed before failing.`);
    } else {
      parts.push(`All ${executableStepTotal} executable steps passed.`);
    }
    if (blockedScenarios.length > 0) {
      parts.push(`${blockedScenarios.length} scenario(s) were skipped because a prerequisite scenario failed (test-design / sequencing, not an application defect).`);
    }
    if (a11yStatus === "NON_COMPLIANT") parts.push(`${a11yViolations.length} WCAG accessibility violation(s) were detected (${a11yScores.critical} critical).`);
    else if (a11yStatus === "COMPLIANT") parts.push("No WCAG accessibility violations were detected.");
    if (secEvaluated) parts.push(`Security sanity checks (${secChecksPerformed.join(", ")}) ${secLabel === "PASS" ? "passed for the checks performed" : "flagged issues"}.`);
    if (healingSummary.attempts > 0) parts.push(`Self-healing recovered ${healingSummary.successes} of ${healingSummary.attempts} selector(s).`);
    return parts.join(" ");
  };
  const deterministicSummary = buildDeterministicSummary();

  // 17. Recommendations — deterministic, from telemetry; LLM items appended.
  const recommendations = [];
  if (isBlockedExecution) {
    recommendations.push(executionClassification.recommendedAction);
  }
  developerActions.slice(0, 4).forEach((a) => {
    recommendations.push(`[${a.priority}] ${a.scenario}: ${a.recommendedAction}`);
  });
  if (a11yStatus === "NON_COMPLIANT" && a11yScores.critical > 0) {
    recommendations.push("Resolve the critical WCAG violation(s) before release.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Suite is performing cleanly. Maintain stable selector attributes (id / data-test) on interactive elements.");
  }
  (aiReport?.recommendations || []).forEach((r) => {
    if (r && !recommendations.includes(r)) recommendations.push(r);
  });

  return {
    metadata: {
      id,
      runNumber,
      suiteName,
      targetUrl,
      testDescription,
      browser,
      environment,
      durationMs,
      durationFormatted: formatDuration(durationMs),
      createdAt,
      createdAtFormatted: formatTimestamp(createdAt),
      startedAt,
      completedAt,
      rawStatus: execution.status,
      jiraTicketId: execution.jiraTicketId,
      jiraTicketUrl: execution.jiraTicketUrl,
      jiraSyncTimestamp: execution.jiraSyncTimestamp,
      executionType: execution.executionType || "WEB",
    },
    summary: {
      healthScore: calculatedHealth,
      aiConfidence: aiReport?.ai_confidence_score ?? 96,
      interactionSuccessRate: passRate,
      domStability: aiReport?.dom_stability || (failedScenarios > 0 ? "Medium" : "High"),
      totalTests: scenarioCount, // Used as 'SCENARIOS EXECUTED' or 'TEST DATA EXECUTED' in UI
      passedCount: passedScenarios,
      failedCount: failedScenarios,
      skippedCount: skippedScenarios,
      partiallyPassedCount: partiallyPassedScenarios,
      passRate,
      totalSteps, // executable steps: passedSteps + failedSteps + skippedSteps
      passedSteps,
      failedSteps,
      skippedSteps,
      executableStepTotal,
      selfHealedCount: healingSummary.successes,
      aiSummaryText: deterministicSummary,
      validationResults: aiReport?.validation_results || [],
    },
    releaseDecision: {
      decision,
      title: decisionTitle,
      riskLevel,
      reasons: decisionReasons,
      confidence: aiReport?.ai_confidence_score ?? 95,
      healthScore: calculatedHealth,
      failureClass: executionClassification.type,
      blockType: executionClassification.blockType,
      applicationQuality,
      executionStatus: executionClassification.executionStatus,
    },
    executionClassification,
    healingSummary,
    developerActions,
    blockedScenarios,
    pageAnalysis,
    performance,
    quality: {
      functionalScore,
      a11yScore,
      secScore,
      stabilityScore,
    },
    tests,
    timeline: transcript,
    aiTimeline: aiReport?.timeline || [],
    failures,
    healing,
    accessibility: {
      status: a11yStatus,
      label: a11yLabel,
      evaluated: a11yEvaluated,
      violations: a11yViolations,
      scores: a11yScores,
    },
    security: {
      status: secStatus,
      label: secLabel,
      evaluated: secEvaluated,
      scope: secScope,
      checksPerformed: secChecksPerformed,
      issues: secIssues,
    },
    evidence: {
      screenshots,
      screenshotsAvailable: screenshotsPresent,
      videos,
      visualRegression,
      requests,
    },
    ai: {
      observations,
      recommendations,
      narrative: aiReport?.ai_summary || null,
      detectedIssues: aiReport?.detected_issues || [],
      screenshotAnalysis: aiReport?.screenshot_analysis || null,
      markdownReport: aiReport?.markdown_report || null,
      reason: aiReport?.reason || null,
    },
    technical: {
      rawLogs: execution.logs || "",
      stepLogs: rawStepLogs,
      traceData: execution.traceData || null,
      planData: execution.planData || null,
      rawExecution: execution,
    },
  };
}
