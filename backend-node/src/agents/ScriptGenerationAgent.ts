import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';
import { validateSelector } from './selectorValidator';
import { z } from 'zod';

export class ScriptGenerationAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async generateScript(testName: string, steps: any[], isContinuation: boolean = false): Promise<string> {
    const jsonSchema = {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actionType: { type: "string" },
              target: { type: ["string", "null"] },
              value: { type: ["string", "null"] },
              assertion: { type: ["string", "null"] },
              scenarioName: { type: ["string", "null"] }
            },
            required: ["actionType", "target", "value", "assertion", "scenarioName"],
            additionalProperties: false
          }
        }
      },
      required: ["actions"],
      additionalProperties: false
    };
    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: "ScriptGeneration", strict: true });
    const CHUNK_SIZE = 5;
    let allActions: any[] = [];

    // Generic, website-agnostic decomposition of conjunctive steps. A single
    // authored step that chains TWO OR MORE imperative interactions ("Go to the
    // shopping cart and click Checkout", "Navigate back to products and add a
    // product to the cart") is split so each interaction becomes its own action
    // and cannot be silently dropped by the LLM. Only split when EVERY fragment
    // reads as its own instruction (contains an imperative verb) - so an
    // enumeration like "Fill in the First Name, Last Name and Postal Code"
    // (no verb after the conjunction) stays a single step.
    const IMPERATIVE = /\b(open|navigate|go|visit|return|head|click|press|tap|select|choose|add|remove|delete|enter|type|fill|search|submit|log ?in|sign ?in|sign ?out|log ?out|logout|login|scroll|hover|check|verify|confirm|ensure|validate|assert|wait|upload|download|drag|drop|close|expand|collapse|toggle)\b/i;
    const splitCompoundLine = (line: string): string[] => {
      const parts = line.split(/\s*(?:,\s*(?:and|then)\b|\band then\b|\band\b|\bthen\b)\s+/i);
      if (parts.length < 2) return [line];
      const trimmed = parts.map(p => p.trim().replace(/[.;]+$/, '')).filter(Boolean);
      if (trimmed.length >= 2 && trimmed.every(p => IMPERATIVE.test(p))) return trimmed;
      return [line];
    };
    // Rewrite the "Steps"/"Steps to Execute" block of each planReq string, applying
    // the split to each enumerated line. Non-string steps and other formats pass through.
    const preprocessedSteps = (Array.isArray(steps) ? steps : []).map((step: any) => {
      if (typeof step !== 'string') return step;
      return step.replace(
        /(Steps(?:\s+to\s+Execute)?:[ \t]*\n?)([\s\S]*?)(\n[ \t]*(?:Assertions|Expected\s+Result|DOM\s+Summary|Test\s+Data)[ \t]*:|$)/i,
        (_m: string, head: string, body: string, tail: string) => {
          const rewritten = body
            .split('\n')
            .map((raw: string) => {
              const m = raw.match(/^(\s*(?:\d+[.)]\s+|[-*]\s+)?)(\S.*)$/);
              if (!m) return raw;
              const [, prefix, text] = m;
              const pieces = splitCompoundLine(text!.trim());
              if (pieces.length < 2) return raw;
              return pieces.map(p => `${prefix}${p}`).join('\n');
            })
            .join('\n');
          return `${head}${rewritten}${tail}`;
        }
      );
    });

    for (let i = 0; i < preprocessedSteps.length; i += CHUNK_SIZE) {
      const chunkSteps = preprocessedSteps.slice(i, i + CHUNK_SIZE);
      const chunkIsContinuation = isContinuation || i > 0;
      
      const generateScriptPrompt = PromptTemplate.fromTemplate(`
Generate Playwright actions (JSON array) for {testName}.
RULES:
0. COMPOUND / MULTI-CLAUSE STEPS (highest priority — a dropped clause fails the run): a single user step that joins TWO OR MORE distinct interactions with "and", "then", "and then", "," or "after" MUST become one action PER clause, in the written order. Never emit only the last clause. Examples: "Go to the shopping cart and click Checkout" -> (a) click the cart link/icon, (b) assertVisible a cart-page element, (c) click Checkout. "Open the menu and click Logout" -> (a) click the menu button, (b) assertVisible the Logout item, (c) click Logout. "Navigate back to products and add a product" -> (a) click the back/products control, (b) assertVisible a product, (c) click the add-to-cart control. It is CORRECT for the action count to exceed the user step count.
1. WAIT vs ASSERT: Use a bare 'wait' ONLY to let the page load/settle (e.g. after a submit/navigation). To confirm an element exists before interacting, use 'assertVisible', not 'wait'. A 'wait' action is NEVER a substitute for a verification the user explicitly asked for. AFTER opening a menu / sidebar / drawer / dropdown / modal / accordion (e.g. clicking a burger/hamburger/"Open Menu" button), the very next action MUST be an 'assertVisible' for the item you are about to interact with inside it, so the open animation completes before the click.
2. SELECTORS & ACTION TYPES: Prioritize robust Playwright locators wrapped in case-insensitive regex! 
Example 1 (Clicks): If the step says "Click Submit", set actionType="click" and target="getByRole('button', {{ name: /Submit/i }})". 
Example 2 (Fills): If the step says "Fill First Name", DO NOT blindly generate getByPlaceholder(/First Name/i). Instead, find the actual element in the DOM Summary and use its stable attribute, e.g., target="locator('[data-test=\"firstName\"]')" or target="input[name=\"firstName\"]".
CRITICAL: Extract the EXACT text from the provided steps ONLY IF it maps to actual DOM text. DO NOT hallucinate generic names or placeholders! You MAY use exact CSS selectors like [data-test="..."] or #id ONLY IF explicitly listed in the DOM Selector Summary.
3. FORMS: Map semantic fields logically. NEVER call fill() on a 'form' element itself. CRITICAL: YOU MUST INCLUDE BOTH USERNAME AND PASSWORD ACTIONS IF SPECIFIED.
4. NAVIGATION VS CLICKS: Natural-language navigation intent ("Open", "Navigate", "Visit", "Go to") for the TARGET APPLICATION itself MUST be converted to a 'goto' action with 'target' set to the target URL. DO NOT generate a 'click' action for the website name (e.g. if the instruction is "Open SauceDemo", generate goto target="https://www.saucedemo.com", do NOT generate a click on a link named SauceDemo). Mid-test interactions like "Click", "Select", "Press" MUST be Playwright interaction actions (e.g. 'click'). Do NOT restart the flow with a 'goto' to the root URL mid-test. EXCEPTION - explicit IN-APP navigation steps ("navigate/go/return/head back to the <section>", "open the <section> page", "return to <page>"): emit a 'goto' ONLY when a concrete same-origin path for that destination is actually visible in the provided Steps or DOM Summary (e.g. an href/link already shown there). If no such path is available, emit a 'click' whose target is a role/link/button locator matching the destination wording (e.g. getByRole('link', {{ name: /<destination words>/i }})), and immediately follow it with an 'assertVisible' for an element that the NEXT step implies exists on the destination page. NEVER invent an exact visible-text label (e.g. "Back to products") that is not present in any provided DOM.
5. ASSERTIONS: Use regex for assertions to avoid exact match failures (e.g., 'getByText(/Success|Thank you/i)'). For removed elements, use assertNotVisible. Do NOT invent custom 'Success notification' string matchers unless you use a valid selector. EVERY user step that verifies/checks/confirms/ensures/validates state (wording such as "Verify", "Confirm", "Ensure", "Check", "Validate", "should be/appear", "is visible/displayed", "loads", "is removed", "no longer", "disappears") MUST be represented by an assert* action - assertVisible or assertText for presence/state, assertNotVisible for removal/absence - and NEVER by a bare 'wait'. Do not drop, skip, or merge verification steps.
6. VALID TYPES: goto, click, fill, wait, screenshot, assertText, assertVisible, assertNotVisible, assertUrl, assertEnabled, assertDisabled, press, select, hover. Use assertUrl (value = a substring or /regex/ of the expected address) to verify which page the user is on - NEVER try to verify the address with getByText. Use assertEnabled / assertDisabled for "button is enabled/disabled". Use press (value = key name such as Enter or Escape, selector optional) for keyboard steps. Use select for BOTH native dropdowns and custom dropdowns (role=combobox buttons): selector = the dropdown control, value = the option text to choose. Text that changes with the date, time of day or user data (greetings, day counts, dates, counters) MUST be matched with a regular expression, never an exact string.
7. FILL ACTIONS: When generating a 'fill' action, you MUST provide the text to be typed in the 'value' field. NEVER leave 'value' null for a 'fill' action! CREDENTIALS: NEVER invent login details (no "test_username", "user@example.com", "password123"). When a step says to type the (test) username / email / login or the (test) password and the scenario text does not state the literal value, set value to the exact token __USERNAME__ for the username/email or __PASSWORD__ for the password; the runner substitutes the real values. If the scenario states the literal value, use that.
8. INTENT TRACKING: Populate the 'assertion' field with the original natural language instruction to enable self-healing if the static selector fails.
9. PLAYWRIGHT API STRICTNESS: Generated selectors MUST use valid Playwright Locator APIs ONLY. Do NOT chain native DOM element methods like .closest(), .querySelector(), .parentElement, etc., directly onto Playwright Locators. INVALID: getByText(/1/i).closest('span'). VALID: locator('span').filter({{ hasText: /1/i }}) or locator('..'). Always use the DOM context to target the correct semantic element (e.g., the actual cart badge) rather than arbitrarily finding any matching text.
10. SEMANTIC STATE ASSERTIONS: Natural-language semantic verifications (e.g., "Verify login page loads successfully" or "Verify checkout overview page loads") MUST NOT be converted to literal text assertions like getByText(/login page loads successfully/i) unless that exact text literally exists in the DOM. Instead, inspect the DOM Selector Summary and derive the assertion by verifying the presence of ACTUAL elements that represent that state (e.g., getByRole('button', {{ name: /Login/i }}) or getByPlaceholder(/Username/i) for a login page). The 'assertion' field preserves the natural-language intent, but the 'selector' MUST target a REAL DOM element. ROLE TOLERANCE: only use a role-scoped locator (getByRole('heading'|'button'|'link'|...)) when the DOM Summary for that step CONFIRMS the element has that role/tag. If the destination page's DOM is NOT in the provided summary, or the tag is unknown, use a role-agnostic locator instead - getByText(/<words>/i) (matches any element) or a stable container/attribute - so the assertion does not fail merely because e.g. a title is a <span> rather than an <h1>.
11. STRICT DOM-AWARE SELECTORS: NEVER infer an attribute like data-testid, placeholder, name, or aria-label merely because the natural-language field name sounds like one. For every interaction (fill, click, etc.) or state assertion, inspect the DOM Selector Summary for the CURRENT step. If the instruction says "Verify password field is visible", DO NOT blindly generate locator('[data-testid="password"]'). You MUST verify the exact attribute in the DOM. If the DOM shows <input data-test="password">, you MUST use locator('[data-test="password"]'). The selector must be derived EXPLICITLY from the DOM summary provided, prioritizing stable attributes (data-test, id, name). NOTE: data-test !== data-testid. Never use one if the DOM has the other.
12. ORDER AND COMPLETENESS: emit the actions in EXACTLY the order the steps are written. A "Verify ..." step is an assertion at THAT position - never postpone or merge verifications to the end of the scenario, and never drop one. If one verify step names several items ("Verify the text A and the text B are visible"), emit one assertion per item right there. A step that tells the user to click / type / select must produce a click / fill / select action - never replace it with an assertion. For "If <control> is shown, click it" emit the click (the control is expected to be present).
13. NEGATIVE CHECKS: "is not visible", "is no longer visible", "disappears", "is removed", "is not shown" -> assertNotVisible (never assertVisible).
14. AMBIGUOUS NAMES: when one control's name is contained in another's (e.g. "Save" and "Save this message", "Add" and "Add provider"), target the exact control with an anchored name: getByRole('button', {{ name: /^Save$/i }}), and never use getByText(/Save/i).nth(0) / .first() to pick one of several matches. Use the step's own hints (position, "the one next to ...", "not the ...") to choose.
15. CHOICES: "Select the <option> option under <group>" where the options are radio buttons, tabs, chips or segmented buttons -> click getByRole('radio', {{ name: /<option>/i }}) (or the matching role seen in the DOM). Use the select action only for real dropdowns (select / role=combobox).
EXACT NEGATIVE EXAMPLES:
Example 1 - Instruction: "Verify password field is visible." DOM: <input id="password" type="password"> -> INVALID: locator('[data-test="password"]') | VALID: locator('#password')
Example 2 - Instruction: "Fill First Name." DOM: <input name="firstName"> -> INVALID: getByPlaceholder(/First Name/i) or locator('[data-test="firstName"]') | VALID: locator('input[name="firstName"]')
Example 3 - Instruction: "Fill Last Name." DOM: <input data-test="lastName"> -> INVALID: getByPlaceholder(/Last Name/i) or locator('#lastName') | VALID: locator('[data-test="lastName"]')
Example 4 - Instruction: "Fill Credit card." DOM: <input id="card"> -> INVALID: locator('[data-test="card"]') or locator('#credit-card') | VALID: locator('#card')
Example 5 - Instruction: "Click the 'Add to cart' button." DOM: <a href="#" class="btn btn-success">Add to cart</a> -> INVALID: getByRole('button', {{ name: /Add to cart/i }}) | VALID: getByText(/Add to cart/i) or getByRole('link', {{ name: /Add to cart/i }})
Example 6 - Instruction: "Verify the <X> page loads" / "Verify <label> is visible", and the DOM for that page/state is NOT in the provided summary. -> INVALID: getByRole('heading', {{ name: /<label>/i }}) or getByRole('button', {{ name: /<label>/i }}) (assumes a tag/role that may not exist; if the real element is a <span>/<div> the assertion fails even though the page is fine) | VALID: getByText(/<label>/i) (tag-agnostic - matches the text in ANY element).
Example 7 - Instruction: "Go to the shopping cart" / "Click the cart link", and the cart control is an icon link with NO visible text (e.g. <a class="shopping_cart_link"><svg/></a> or <a id="cart"><span class="badge">1</span></a>). -> INVALID: getByRole('link', {{ name: /cart/i }}) or getByText(/cart/i) (there is no "cart" text to match) | VALID: a stable attribute from the DOM summary (locator('.shopping_cart_link'), locator('#cart'), locator('[data-test="shopping-cart-link"]')). If none is shown, still emit the click with getByRole('link', {{ name: /cart/i }}) so healing can repair it - never DROP the navigation.
Example 8 - Instruction: "Click Logout" inside an opened side menu whose links are <a> WITHOUT an href (e.g. <a id="logout_sidebar_link">Logout</a>). An href-less <a> has NO 'link' role. -> INVALID: getByRole('link', {{ name: /Logout/i }}) | VALID: getByText(/Logout/i) or locator('#logout_sidebar_link').
13. ACTION‑CONTROL TARGETING: A step that performs an action on an item ("Add a product to the cart", "Add <X> to cart", "Select an item", "Choose <X>", "Remove <X>") MUST target the CONTROL that performs the action - a button/link whose name or text contains the verb (e.g. getByRole('button', {{ name: /add to cart/i }}), getByText(/add to cart/i), getByRole('button', {{ name: /remove/i }})). NEVER target the item's title/name/image/thumbnail (e.g. getByText(/Sauce Labs Backpack/i)) - clicking the title navigates to a detail page and derails the flow. If the item is unspecified ("a product", "the first product"), use .first() on the action control.
12. STEP PRESERVATION & DECOMPOSITION: Every distinct executable instruction the user wrote MUST be represented in the output. A single user step that names MULTIPLE distinct interactions - joined by "and", "then", "and then", "," or "after" (e.g. "Navigate back to products AND add a product to the cart", "Go to the shopping cart AND click Checkout", "Fill in the First Name, Last Name and Postal Code") - MUST be expanded into one action PER distinct interaction, in the order written. Do NOT collapse a compound step into a single action, and do NOT silently drop the second (or later) interaction of a compound step. It is expected and correct for the total action count to EXCEED the user step count when steps are compound or when an interaction needs a preceding assertVisible/wait.
${chunkIsContinuation ? "CONTINUATION: Browser open/logged in. NO 'goto' to the root unless explicitly requested. Begin interactions." : ""}

Steps JSON (Contains step descriptions and their corresponding DOM Summary):
{stepsJson}
`);
      const chain = generateScriptPrompt.pipe(llm);
      const context = this.executionId ? { executionId: this.executionId, agentName: 'ScriptGenerationAgent', promptType: 'generateScript' } : undefined;
      let expectedBatchSize = chunkSteps.length;
      let targetSteps = [...chunkSteps];
      let collectedActions: any[] = [];
      let success = false;
      let attempt = 0;
      
      while (attempt < 2 && !success) {
          try {
            const trimmedSteps = targetSteps.map(step => typeof step === 'string' ? step.substring(0, 15000) + (step.length > 15000 ? '...[TRUNCATED]' : '') : step);
            const stepsStr = JSON.stringify(trimmedSteps, null, 2);
            const rawStepsStr = trimmedSteps.join('\n');

            const response = await invokeWithRetry(chain, {
              testName,
              stepsJson: stepsStr,
            }, 8000, ['stepsJson'], context);
            
             const generatedActions = response?.actions || [];
             const responseActionsLength = generatedActions.length;
             
             const expectedScenariosDetails = targetSteps.map(step => {
                 if (typeof step === 'string') {
                     const match = step.match(/Scenario Name:\s*(.*)/);
                     const sName = match && match[1] ? match[1].trim() : null;
                     // Match the step block regardless of the caller's label
                     // ("Steps:" from prompt/Excel paths, "Steps to Execute:" from
                     // OrchestratorAgent) and terminate at whichever section header
                     // follows (Assertions / Expected Result / DOM Summary / Test Data).
                     const stepsMatch = step.match(/Steps(?:\s+to\s+Execute)?:\s*([\s\S]*?)(?:\n\s*(?:Assertions|Expected\s+Result|DOM\s+Summary|Test\s+Data)\s*:|$)/i);
                     const stepsText = stepsMatch && stepsMatch[1] ? stepsMatch[1] : "";
                     const stepLines = stepsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                     // Prefer counting enumerated/bulleted lines; fall back to any non-empty line.
                     const enumerated = stepLines.filter(l => /^(?:\d+[.)]|[-*])\s+/.test(l));
                     const stepCount = (enumerated.length > 0 ? enumerated.length : stepLines.length) || 1;
                     return sName ? { name: sName, stepCount: stepCount } : null;
                 }
                 return null;
             }).filter(Boolean) as {name: string, stepCount: number}[];

             const expectedScenarios = expectedScenariosDetails.map(d => d.name);
             const expectedScenarioCount = expectedScenarios.length;
             const totalExpectedSteps = expectedScenariosDetails.reduce((sum, d) => sum + d.stepCount, 0);

             // Calculate cumulative proportions for positional mapping
             let currentProp = 0;
             const scenarioProportions = expectedScenariosDetails.map(d => {
                 currentProp += d.stepCount / totalExpectedSteps;
                 return { name: d.name, cumulativeProp: currentProp };
             });

             const scenarioActionCounts: Record<string, number> = {};
             const scenarioMappingSources: Record<string, Set<string>> = {};
             expectedScenarios.forEach(s => {
                 scenarioActionCounts[s] = 0;
                 scenarioMappingSources[s] = new Set<string>();
             });

             let mappedActionsCount = 0;
             let unmappedActionsCount = 0;
             let currentScenarioIndex = 0;

             const mappedActions = generatedActions.map((a: any, index: number) => {
                 let finalActionType = a.actionType;
                 if (chunkIsContinuation && finalActionType === 'goto') {
                     // A goto in a later chunk is "rogue" only if the user never asked for it. When the
                     // scenario text itself says to open that address (e.g. "Open https://site/care"), the
                     // navigation is part of the scenario and MUST be kept - stripping it left every later
                     // scenario running on whatever page the previous one ended on.
                     const chunkText = (chunkSteps as any[]).map((x: any) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n').toLowerCase();
                     const norm = (u: string) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
                     const wanted = norm(a.target);
                     const userAskedForIt = !!wanted && chunkText.replace(/https?:\/\//g, '').includes(wanted);
                     if (!userAskedForIt) {
                         console.log(`[ScriptGenerationAgent] Stripping rogue goto action in continuation chunk: ${a.target}`);
                         finalActionType = 'wait';
                     }
                 }

                 let rawSName = typeof a.scenarioName === 'string' ? a.scenarioName.trim() : "";
                 let assignedScenario = "";
                 let mappingSource = "";

                 if (expectedScenarioCount === 0) {
                     // The caller supplied no parseable "Scenario Name:" list to
                     // enforce coverage against — this is every autonomous /
                     // prompt / one-click run (OrchestratorAgent builds its
                     // planReq as "Target:/Cases:/DOM Summary:", with no scenario
                     // header). Without this branch the coverage gate below sees
                     // `expectedScenarios = []`, marks EVERY generated action
                     // "unmapped", and the whole run fails as
                     // "ScriptGenerationAgent output is malformed or empty" even
                     // though the model produced a perfectly good action list.
                     // Accept the model's actions under a synthetic scenario so
                     // the gate becomes a no-op; genuine emptiness is still
                     // caught by the `allActions.length === 0` check at the end.
                     assignedScenario = (rawSName || testName || 'Generated Scenario').trim();
                     mappingSource = "no_expected_scenarios";
                 } else if (expectedScenarioCount === 1) {
                     assignedScenario = expectedScenarios[0] || "";
                     mappingSource = "inferred_single_scenario";
                 } else {
                     if (rawSName) {
                         const exactIdx = expectedScenarios.findIndex(es => es === rawSName);
                         if (exactIdx >= 0) {
                             assignedScenario = expectedScenarios[exactIdx] || "";
                             mappingSource = "explicit_metadata_exact";
                             currentScenarioIndex = exactIdx;
                         } else {
                             const fuzzyIdx = expectedScenarios.findIndex(es => es.toLowerCase() === rawSName.toLowerCase() || es.includes(rawSName) || rawSName.includes(es));
                             if (fuzzyIdx >= 0) {
                                 assignedScenario = expectedScenarios[fuzzyIdx] || "";
                                 mappingSource = "explicit_metadata_fuzzy";
                                 currentScenarioIndex = fuzzyIdx;
                             } else {
                                 assignedScenario = expectedScenarios[currentScenarioIndex] || "";
                                 mappingSource = "positional_fallback_invalid_metadata";
                             }
                         }
                     } else {
                         // Positional mapping based on targetSteps original proportions
                         const actionProp = (index + 0.5) / responseActionsLength;
                         const inferredIdx = scenarioProportions.findIndex(sp => actionProp <= sp.cumulativeProp);
                         assignedScenario = inferredIdx >= 0 ? scenarioProportions[inferredIdx]!.name : (expectedScenarios[expectedScenarioCount - 1] || "");
                         mappingSource = "inferred_positional";
                         const finalIdx = expectedScenarios.indexOf(assignedScenario);
                         if (finalIdx >= 0) currentScenarioIndex = finalIdx;
                     }
                 }

                 if (assignedScenario && (expectedScenarioCount === 0 || expectedScenarios.includes(assignedScenario))) {
                     if (!(assignedScenario in scenarioActionCounts)) {
                         scenarioActionCounts[assignedScenario] = 0;
                         scenarioMappingSources[assignedScenario] = new Set<string>();
                     }
                     scenarioActionCounts[assignedScenario] = (scenarioActionCounts[assignedScenario] || 0) + 1;
                     scenarioMappingSources[assignedScenario]?.add(mappingSource);
                     mappedActionsCount++;
                 } else {
                     unmappedActionsCount++;
                     console.log(`[UNMAPPED_ACTION]\nindex=${index}\nactionType=${finalActionType}\nselector=${a.target}\nreason=Could not resolve scenario`);
                 }

                 const nlIntent = a.assertion === "null" ? null : a.assertion;
                 return {
                     scenarioName: assignedScenario,
                     action: finalActionType,
                     url: finalActionType === 'goto' ? a.target : null,
                     selector: finalActionType !== 'goto' ? a.target : null,
                     value: a.value === "null" ? null : a.value,
                     contains: nlIntent,
                     // ExecutionAgent reads `action.assertion` (not `contains`) as the
                     // natural-language intent for selector regeneration and self-healing.
                     // Emit it under both keys so that intent signal is not lost.
                     assertion: nlIntent,
                     state: 'domcontentloaded',
                     timeout: 10000
                 };
             });

             const normalizedActionsLength = mappedActions.length;
             const generatedScenarioCount = Object.keys(scenarioActionCounts).filter(s => (scenarioActionCounts[s] || 0) > 0).length;

             console.log(`[SCRIPT_GENERATION_RESULT]\nexpectedScenarioCount=${expectedScenarioCount}\ngeneratedScenarioCount=${generatedScenarioCount}\ntotalGeneratedActions=${normalizedActionsLength}`);
             
             const batchActionsLength = mappedActions.length;
             const executionActionsLength = mappedActions.length;
             
             console.log(`[GENERATION_ACTION_ARRAY]\nresponseActions=${responseActionsLength}\nnormalizedActions=${normalizedActionsLength}\nbatchActions=${batchActionsLength}\nexecutionActions=${executionActionsLength}`);

             console.log(`[SCENARIO_ACTION_MAPPING]\ntotalActions=${responseActionsLength}\nknownScenarios=${expectedScenarioCount}\nmappedActions=${mappedActionsCount}\nunmappedActions=${unmappedActionsCount}`);

             const stepCountByScenario: Record<string, number> = {};
             expectedScenariosDetails.forEach(d => { stepCountByScenario[d.name] = d.stepCount; });
             const underCoveredScenarios: string[] = [];
             let totalRequestedSteps = 0;
             for (const sName of expectedScenarios) {
                 const count = scenarioActionCounts[sName] || 0;
                 const srcSet = scenarioMappingSources[sName];
                 const sources = srcSet && srcSet.size > 0 ? Array.from(srcSet).join(",") : "none";
                 console.log(`[SCENARIO_ACTION_COUNT]\nscenario=${sName}\nactions=${count}\nmappingSource=${sources}`);
                 console.log(`[SCENARIO_GENERATION_RESULT]\nscenario=${sName}\nactions=${count}`);

                 // Step-coverage signal: compare user-requested step count for this
                 // scenario against how many actions were generated for it. This is a
                 // heuristic (one step can legitimately expand into several actions,
                 // e.g. "login" -> fill + fill + click), so under-coverage is a
                 // WARNING for visibility, not a hard failure — only genuinely empty
                 // scenarios (count === 0, handled below) block execution.
                 const requestedSteps = stepCountByScenario[sName] || 0;
                 totalRequestedSteps += requestedSteps;
                 console.log(`[SCENARIO_STEP_COVERAGE]\nscenario=${sName}\nrequestedSteps=${requestedSteps}\ngeneratedActions=${count}`);
                 if (count > 0 && requestedSteps > 1 && count < requestedSteps) {
                     underCoveredScenarios.push(sName);
                     console.log(`[SCENARIO_STEP_COVERAGE_WARNING]\nscenario=${sName}\nrequestedSteps=${requestedSteps}\ngeneratedActions=${count}\nnote=fewer actions than user steps - a verification or interaction step may be missing`);
                 }
             }
             console.log(`[SCRIPT_GENERATION_STEP_COVERAGE]\nrequestedSteps=${totalRequestedSteps}\ngeneratedActions=${mappedActions.length}\nunderCoveredScenarios=${underCoveredScenarios.length}`);

             if (responseActionsLength !== normalizedActionsLength || normalizedActionsLength !== batchActionsLength || batchActionsLength !== executionActionsLength) {
                 console.log(`[GENERATION_ACTION_COUNT_MISMATCH]\nresponseActions=${responseActionsLength}\nnormalizedActions=${normalizedActionsLength}\nbatchActions=${batchActionsLength}\nexecutionActions=${executionActionsLength}`);
                 throw new Error("GENERATION_ACTION_COUNT_MISMATCH: Invariant failed.");
             }

             let missingScenarios = Object.keys(scenarioActionCounts).filter(s => (scenarioActionCounts[s] || 0) === 0);

             if (missingScenarios.length > 0 || mappedActionsCount === 0) {
                 for (const sName of missingScenarios) {
                     console.log(`[SCRIPT_GENERATION_FAILED]\nscenario=${sName}\nactions=0`);
                 }
                 
                 if (attempt === 0) {
                    attempt++;
                    
                    const validScenarios = Object.keys(scenarioActionCounts).filter(s => (scenarioActionCounts[s] || 0) > 0);
                    for (const sName of validScenarios) {
                        console.log(`[SCRIPT_GENERATION_SUCCESS]\nscenario=${sName}\nactions=${scenarioActionCounts[sName]}`);
                    }
                    const validActions = mappedActions.filter((a: any) => validScenarios.includes(a.scenarioName));
                    collectedActions.push(...validActions);

                    targetSteps = chunkSteps.filter(step => {
                        if (typeof step === 'string') {
                            const match = step.match(/Scenario Name:\s*(.*)/);
                            if (match && match[1]) {
                               return missingScenarios.includes(match[1]?.trim() || "");
                            }
                        }
                        return true;
                    });
                    
                    console.log(`[ScriptGenerationAgent]\nBATCH=${Math.floor(i/CHUNK_SIZE)}\nEXPECTED_SCENARIOS=${expectedScenarioCount}\nGENERATED_SCENARIOS=${generatedScenarioCount}\nRETRYING=true`);
                    continue;
                 } else {
                    throw new Error(JSON.stringify({
                      status: "FAILED",
                      reason: "PARTIAL_SCRIPT_GENERATION_RESPONSE",
                      expected: expectedScenarioCount,
                      actual: generatedScenarioCount
                    }));
                 }
             } else {
                 for (const sName of expectedScenarios) {
                     console.log(`[SCRIPT_GENERATION_SUCCESS]\nscenario=${sName}\nactions=${scenarioActionCounts[sName]}`);
                 }
                 collectedActions.push(...mappedActions);
             }
            success = true;
            success = true;
          } catch (err: any) {
            if (err.message && (err.message.includes('400') || err.message.includes('schema') || err.message.includes('response_format'))) {
              throw new Error('DeterministicSchemaValidationError: LLM schema validation failed (400). Aborting batch generation immediately to prevent orchestration loops.');
            }
            if (err.message && err.message.includes('PARTIAL_SCRIPT_GENERATION_RESPONSE')) {
               throw new Error(err.message);
            }
            if (err.message && err.message.includes('INVALID SELECTOR')) {
               console.warn(err.message);
               // Do NOT throw it outwards, so that `attempt++` happens and it retries.
               if (attempt >= 1) {
                   throw err; // If we already retried and failed, abort to avoid infinite loop
               }
            } else {
               throw err;
            }
          }
      }

      if (collectedActions.length > 0) {
        allActions.push(...collectedActions);
      }
    }

    const authMatches = steps.map(s => {
        if (typeof s !== 'string') return null;
        // Match either quotes or stop at comma/parenthesis
        const userMatch = s.match(/Username:\s*['"]?([^'",\)\s]+)/i);
        const passMatch = s.match(/Password:\s*['"]?([^'",\)\s]+)/i);
        if (userMatch && passMatch) {
             return [null, userMatch[1], passMatch[1]];
        }
        return null;
    }).filter(Boolean);
    
    if (authMatches.length > 0 && authMatches[0]) {
        const username = authMatches[0][1] ? authMatches[0][1].trim() : '';
        const password = authMatches[0][2] ? authMatches[0][2].trim() : '';
        const hasUserFill = allActions.some((a: any) => (a.action === 'fill' || a.actionType === 'fill') && a.value === username);
        const hasPassFill = allActions.some((a: any) => (a.action === 'fill' || a.actionType === 'fill') && a.value === password);
        if (!hasUserFill || !hasPassFill) {
            throw new Error(`MISSING_REQUIRED_CREDENTIAL_ACTIONS: Generated script is missing required fill actions for username (${username}) or password (${password}). Actions found: ${JSON.stringify(allActions.filter((a: any) => a.action === 'fill'))}`);
        }
    }

    if (allActions.length === 0 && steps.length > 0) {
      throw new Error('EMPTY_SCENARIO_ACTIONS: Scenario parsed but zero actions generated.');
    }

    return JSON.stringify(allActions);
  }

  async regenerateSelector(intent: string, actionType: string, domSnapshot: string): Promise<string | null> {
    const jsonSchema = {
      type: "object",
      properties: {
        selector: { type: ["string", "null"] }
      },
      required: ["selector"],
      additionalProperties: false
    };
    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: "SelectorRegeneration", strict: true });
    
    const prompt = PromptTemplate.fromTemplate(`
You are fixing a hallucinated Playwright selector. 
The intended action is: "{intent}" (Action Type: {actionType})
Note: If the intent looks like a generated selector (e.g. locator('[data-test="name"]')), deduce the semantic field it was trying to target (e.g. "Name field").

You MUST find the REAL element for this semantic intent in the provided DOM Summary.
Return a valid, precise Playwright selector (e.g., locator('#name') or locator('input[name="phone"]')) derived EXPLICITLY from the DOM.
Do NOT invent attributes like data-testid or placeholder. If the DOM has id="name", use locator('#name').
If there is no matching element in the DOM, return null.

DOM Summary:
{domSnapshot}
`);
    const chain = prompt.pipe(llm);
    const context = this.executionId ? { executionId: this.executionId, agentName: 'ScriptGenerationAgent', promptType: 'regenerateSelector' } : undefined;
    
    try {
        const response = await invokeWithRetry(chain, {
          intent,
          actionType,
          domSnapshot: domSnapshot.substring(0, 15000)
        }, 8000, ['domSnapshot'], context);
        return response?.selector || null;
    } catch(e) {
        return null;
    }
  }
}
