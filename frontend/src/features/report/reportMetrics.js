/**
 * reportMetrics.js
 * Utility helpers for QA metrics, duration formatting, and error classification.
 */

export function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  return `${mins}m ${secs}s`;
}

export function formatTimestamp(isoOrDateStr) {
  if (!isoOrDateStr) return "N/A";
  try {
    const d = new Date(isoOrDateStr);
    if (isNaN(d.getTime())) return String(isoOrDateStr);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(isoOrDateStr);
  }
}

export function formatTimeOnly(isoOrDateStr) {
  if (!isoOrDateStr) return "";
  try {
    const d = new Date(isoOrDateStr);
    if (isNaN(d.getTime())) return String(isoOrDateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(isoOrDateStr);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Failure classification
 *
 * Produces a specific, evidence-driven category for a single failed step or a
 * failed scenario. The categories are deliberately conservative: a failure is
 * only labelled APPLICATION_ERROR when the evidence actually points at the
 * application (assertion mismatch on an element that WAS found, explicit 5xx /
 * application error). Missing elements, selector problems, wrong-page state and
 * timeouts are attributed to the automation or page state, not the site.
 * ──────────────────────────────────────────────────────────────────────────── */

export const FAILURE_CATEGORIES = [
  "APPLICATION_ERROR",
  "SELECTOR_ERROR",
  "SELECTOR_DRIFT",
  "PAGE_STATE_ERROR",
  "TIMING_ERROR",
  "NAVIGATION_ERROR",
  "TEST_DESIGN_ERROR",
  "TEST_SCRIPT_ERROR",
  "AUTHENTICATION_ERROR",
  "INFRASTRUCTURE_ERROR",
  "ANTI_BOT_BLOCK",
  "UNKNOWN",
];

function isCriticalFlow(name) {
  return /login|log ?in|auth|sign ?in|sign ?up|register|checkout|check ?out|payment|\bpay\b|billing|\border\b|purchase|cart/i.test(name || "");
}

/**
 * @param {string} errorText   raw error string from telemetry
 * @param {string|null} selector  the selector the step targeted (null if none)
 * @param {object} context     { scenario, page, action, risk, healed }
 * @returns {object} full classification
 */
export function classifyFailure(errorText, selector, context = {}) {
  const e = String(errorText || "").toLowerCase();
  const sel = selector == null ? "" : String(selector).trim();
  const selLower = sel.toLowerCase();
  const missingSelector = !sel || selLower === "null" || selLower === "undefined";
  const scenario = context.scenario || "";
  const action = String(context.action || "").toLowerCase();
  const critFlow = isCriticalFlow(scenario) || isCriticalFlow(context.page);

  let code = "UNKNOWN";
  let isApplicationDefect = false;
  let likelyCause = "Root cause could not be determined automatically from the available telemetry.";
  let developerAction = "Review the step telemetry, screenshot, and video for this scenario.";
  let expected = "The step to complete successfully.";
  let actual = errorText ? String(errorText).slice(0, 200) : "The step did not complete.";

  if (/blocked by upstream scenario|required starting (page|state) (was not|not) established|precondition scenario failed|scenario has no navigation|missing prerequisite step|depends on (a prior|an earlier) scenario/.test(e)) {
    code = "TEST_DESIGN_ERROR";
    likelyCause = `The scenario's steps assume a page or state that an earlier step or scenario was responsible for establishing, but it was not established (an upstream scenario failed, or the scenario definition omits the navigation/setup it needs).`;
    developerAction = `Review the definition of "${scenario}" — either add the navigation/setup steps it needs to reach its starting state, or fix the scenario it depends on so it passes first. This is a test-design / sequencing issue, not an application defect.`;
    expected = "The scenario's required starting page/state to be in place before its steps run.";
    actual = "The required starting state was not established, so the scenario was not executed against the correct page.";
  } else if (/infrastructure failure|worker could not connect|redis connection|bullmq worker connection|econnrefused|etimedout|enotfound|upstash|supabase auth error|lock renewal failure|could not renew lock|und_err_connect_timeout|connecttimeouterror/.test(e)) {
    code = "INFRASTRUCTURE_ERROR";
    likelyCause = "A backend dependency (queue / Redis / Supabase) was unreachable, so the run could not complete.";
    developerAction = "Restore Redis / Supabase connectivity and re-run. This execution does not reflect application quality.";
    expected = "The test runner infrastructure to be reachable.";
    actual = "The runner lost connectivity to a required backend service before completing.";
  } else if (/blockedbyantibot|blocked_by_antibot|anti-bot|\bcaptcha\b|recaptcha|cloudflare|just a moment|checking your browser|verify you are human|turnstile|\b403\b|http 403|http 429|\b429\b|access denied|bot detection|\bwaf\b/.test(e)) {
    code = "ANTI_BOT_BLOCK";
    likelyCause = "The target responded with an anti-bot / WAF challenge or an access-control block, preventing the application from being exercised.";
    developerAction = "Use an approved QA environment, allowlist the test runner, or enable the app's authorized automation-testing mode. Not an application defect.";
    expected = "The target page to load normally for the automated client.";
    actual = "The target returned a bot-challenge / access-denied response.";
  } else if (/net::err_|err_name_not_resolved|err_connection_(refused|reset|closed|timed_out)|err_aborted|err_address_unreachable|frame was detached|navigating to .* failed|page\.goto|failed to navigate|navigation (failed|timeout|to .* interrupted)/.test(e) || (action === "goto" && /timeout|timed out|exceeded|not found|no element/.test(e))) {
    code = "NAVIGATION_ERROR";
    likelyCause = "Navigation to the page did not complete — DNS/connection failure, the URL is wrong or unreachable from the runner, or the page never finished loading.";
    developerAction = `Verify the target URL used by "${scenario}" is correct and reachable from the test runner's network, and that no redirect/interstitial is blocking the load.`;
    expected = `Navigation to ${context.page || "the target URL"} to complete.`;
    actual = "The navigation step did not reach a loaded page.";
  } else if (/selector policy forbids|invalid_action_target|invalidactiontargeterror|non-clickable|must be input|attempted (click|fill|select)\(\) on|malformed step|missing selector|invalid_fill_selector|empty_fill_value|fill_verification_failed/.test(e)) {
    code = "TEST_SCRIPT_ERROR";
    likelyCause = "The generated step targeted the wrong kind of element or violated an action rule (e.g. fill() on a non-input, click() on a container).";
    developerAction = `Correct the generated step for "${scenario}" so the ${action || "action"} targets an appropriate element.`;
    expected = `A valid target element for the "${action || "step"}" action.`;
  } else if (missingSelector && /selector|element|locator|not found/.test(e)) {
    code = "TEST_SCRIPT_ERROR";
    likelyCause = "The step ran without a usable selector — the generator did not produce one for this action.";
    developerAction = `Regenerate the step for "${scenario}" with an explicit selector, or verify the scenario wording maps to a real element.`;
    expected = "A concrete selector for the step.";
    actual = "No selector was available (selector was null / missing).";
  } else if (/invalid selector|selector resolution failed|selector_resolution_failed|hallucinat|unexpected token|invalid regular expression|locator parsing|not a valid (selector|locator)/.test(e)) {
    code = "SELECTOR_ERROR";
    likelyCause = "The selector was syntactically invalid or referenced an attribute that does not exist in the DOM (a generation artefact).";
    developerAction = `Fix the selector for "${scenario}". Prefer a stable attribute (id, data-test, name) confirmed to exist in the page.`;
    expected = "A syntactically valid selector that resolves in the DOM.";
  } else if (!/timeout|timed out|exceeded/.test(e) && /selector not found in dom|element(\(s\))? not found|no element(s)? matches|waiting for (locator|selector)|locator.*not found|element is not attached/.test(e)) {
    // Element genuinely not present when the step ran (and it was NOT a timeout —
    // "Timeout ... waiting for locator" is a timing failure, handled below).
    // Distinguish page-state (wrong page / prior step did not land us where
    // expected) from drift.
    if (/checkout|step-one|step-two|overview|complete|inventory|products/.test(String(context.page || "").toLowerCase()) || action === "fill" || action === "click") {
      code = "PAGE_STATE_ERROR";
      likelyCause = `The element was not on the page when the step executed — navigation may not have reached ${context.page || "the expected page"}, or a previous step did not complete.`;
      developerAction = `Confirm the flow actually reaches ${context.page || "the expected page"} before this step, then confirm "${sel || "the target"}" exists in that DOM state.`;
      expected = `Element "${sel || "target"}" to be present on ${context.page || "the current page"}.`;
      actual = "The element was not found in the DOM at the time the step ran.";
    } else {
      code = "SELECTOR_DRIFT";
      likelyCause = "The element the selector points to is no longer in the DOM in that form — the markup likely changed since the selector was generated.";
      developerAction = `Update the selector for "${sel || "the target"}" to match the current DOM, or rely on self-healing.`;
      expected = `Selector "${sel || "target"}" to still match an element.`;
      actual = "The selector matched no element (possible DOM drift).";
    }
  } else if (/timeout|timed out|exceeded|deadline|network idle/.test(e)) {
    code = "TIMING_ERROR";
    likelyCause = "The step timed out waiting for the element or page state — the app was slow, an async transition did not settle, or the wait was too short.";
    developerAction = `Add/extend an explicit wait before this step in "${scenario}", or investigate why ${context.page || "the page"} was slow to respond.`;
    expected = "The awaited element / state to be ready within the timeout.";
    actual = "The wait expired before the condition was met.";
  } else if (/wrongpageerror|reached an error page|404 not found|page not found|error page|page_context_mismatch|execution context was destroyed/.test(e)) {
    code = "PAGE_STATE_ERROR";
    likelyCause = "The run landed on an unexpected page (error page / 404 / context lost) before the step could execute.";
    developerAction = `Verify navigation in "${scenario}" — the prior step is not leaving the browser on ${context.page || "the expected page"}.`;
    expected = "The expected page to be loaded.";
    actual = "The browser was on an error / unexpected page.";
  } else if (/unauthor|forbidden|session expired|not logged in|invalid credential|login failed|authentication (failed|error)/.test(e) || (critFlow && /assert/.test(e) && isCriticalFlow(scenario) && /login|sign ?in/i.test(scenario))) {
    code = "AUTHENTICATION_ERROR";
    likelyCause = "Authentication did not succeed — credentials were rejected, the session was lost, or the post-login state never rendered.";
    developerAction = `Verify the credentials used for "${scenario}" and confirm the login response renders the expected authenticated state.`;
    expected = "A successful authenticated session after login.";
    actual = "The authenticated state was not reached.";
  } else if (/assertion failed: expected .* to (be|have)/.test(e) && /getbytext\(|\.nth\(|\.first\(\)|\.last\(\)/i.test(sel)) {
    // The check ran against a generic text match / "first of several" element, so it may not have been the
    // control the scenario meant (e.g. "Save" also matches "Save this message"). That cannot prove the
    // application is wrong.
    code = "TEST_SCRIPT_ERROR";
    likelyCause = "The state check was made on a generic text match ('first element containing the word'), which can be a different control from the one the scenario meant. A mismatch on such a target is not evidence of an application defect.";
    developerAction = `Re-run after making the target unambiguous in "${scenario}" (name the exact button/field, e.g. its label or position). Confirm in the video which element was checked.`;
    expected = "The check to be made on the exact control named in the scenario.";
    actual = "The check was made on an ambiguous match and did not hold.";
  } else if (/assertion failed: expected .* to contain|but got ["'].*["']|assertion failed: expected .* to (be|have)/.test(e)) {
    // Element was found, but its text/value did not match — genuine app behaviour.
    code = "APPLICATION_ERROR";
    isApplicationDefect = true;
    likelyCause = "The element was present but its content did not match what the scenario expected — the application produced a different result than specified.";
    developerAction = `Confirm whether the expected value in "${scenario}" is correct. If it is, this is an application defect: the page rendered a different value.`;
    const m = String(errorText || "").match(/expected .*? to contain "(.*?)", but got "(.*?)"/i);
    if (m) { expected = `Content containing "${m[1]}".`; actual = `The element contained "${m[2]}".`; }
    else { expected = "The asserted content to match."; }
  } else if (/assertion (step )?failed|assert(text|visible|value).*fail|expected .* (visible|present)/.test(e)) {
    // Asserted element/state not found — more likely wrong page/state than a bug.
    code = "PAGE_STATE_ERROR";
    likelyCause = "An expected element/state was not present when asserted — most often the flow was not on the expected page, rather than an application defect.";
    developerAction = `Check that "${scenario}" actually reaches the state it asserts. Only treat as an app bug if the element is confirmed missing on the correct page.`;
    expected = `The asserted element / state ("${sel || "target"}") to be present.`;
    actual = "The asserted element / state was not present.";
  } else if (/\b5\d\d\b|internal server error|server error|application error|unhandled exception|stack trace/.test(e)) {
    code = "APPLICATION_ERROR";
    isApplicationDefect = true;
    likelyCause = "The application returned a server-side error (5xx / unhandled exception) during the scenario.";
    developerAction = `Investigate the server-side error triggered by "${scenario}" — check application logs for the failing request.`;
    expected = "A successful application response.";
    actual = "The application returned a server error.";
  }

  // Severity — derived, never random.
  let severity;
  if (code === "INFRASTRUCTURE_ERROR") severity = "CRITICAL";
  else if (code === "AUTHENTICATION_ERROR") severity = "CRITICAL";
  else if (code === "ANTI_BOT_BLOCK") severity = "HIGH";
  else if (isApplicationDefect && critFlow) severity = "CRITICAL";
  else if (critFlow) severity = "HIGH";
  else if (isApplicationDefect) severity = "HIGH";
  else if (context.healed === false && (code === "SELECTOR_DRIFT" || code === "SELECTOR_ERROR")) severity = "HIGH";
  else if (code === "NAVIGATION_ERROR") severity = critFlow ? "HIGH" : "MEDIUM";
  else if (code === "TEST_DESIGN_ERROR") severity = "MEDIUM";
  else if (code === "UNKNOWN") severity = "MEDIUM";
  else severity = "MEDIUM";

  return {
    code,
    severity,
    isApplicationDefect,
    likelyCause,
    developerAction,
    expected,
    actual,
    // Legacy-compatible fields (kept so existing consumers don't break)
    type:
      code === "SELECTOR_ERROR" || code === "SELECTOR_DRIFT" || code === "TEST_SCRIPT_ERROR"
        ? "Locator / Automation Fault"
        : code === "APPLICATION_ERROR"
        ? "Application Behaviour Mismatch"
        : code === "PAGE_STATE_ERROR"
        ? "Page State"
        : code === "NAVIGATION_ERROR"
        ? "Navigation"
        : code === "TEST_DESIGN_ERROR"
        ? "Test Design / Sequencing"
        : code === "TIMING_ERROR"
        ? "Timing / Synchronisation"
        : code === "INFRASTRUCTURE_ERROR"
        ? "Infrastructure / Connectivity"
        : code === "ANTI_BOT_BLOCK"
        ? "Anti-Bot / Access Block"
        : code === "AUTHENTICATION_ERROR"
        ? "Authentication"
        : "Uncategorised",
    category: isApplicationDefect ? "Target Application" : code === "INFRASTRUCTURE_ERROR" ? "Platform / Infrastructure" : "Framework / Automation",
    owner: isApplicationDefect
      ? "Engineering Team"
      : code === "INFRASTRUCTURE_ERROR"
      ? "Platform Team"
      : code === "ANTI_BOT_BLOCK"
      ? "QA / DevOps"
      : "Automation Core Team",
    effort:
      code === "TEST_SCRIPT_ERROR" || code === "SELECTOR_ERROR"
        ? "15 mins"
        : code === "APPLICATION_ERROR"
        ? "Investigate"
        : code === "TIMING_ERROR"
        ? "10 mins"
        : "20 mins",
  };
}

/**
 * Backwards-compatible wrapper kept for existing callers. Returns the legacy
 * shape plus the richer fields from classifyFailure.
 */
export function classifyIssue(err, tgt, context = {}) {
  return classifyFailure(err, tgt, context);
}

export function getBusinessImpact(scenarioName) {
  const name = (scenarioName || "").toLowerCase();
  if (name.includes("login") || name.includes("auth") || name.includes("signin")) {
    return "Users may be blocked from authenticating into the platform.";
  }
  if (name.includes("checkout") || name.includes("pay") || name.includes("order")) {
    return "Purchases, payment processing, or order submission may fail.";
  }
  if (name.includes("cart")) {
    return "Users are unable to manage or add items to their shopping cart.";
  }
  if (name.includes("search")) {
    return "Product or content discovery flows are impaired.";
  }
  if (name.includes("dashboard")) {
    return "Main dashboard telemetry or user home overview fails to load.";
  }
  return "Core business functionality or visual validation failed.";
}
