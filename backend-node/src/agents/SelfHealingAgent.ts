import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';
import { validateSelector } from './selectorValidator';

const prompt = PromptTemplate.fromTemplate(`
You are a Self-Healing QA Agent. 
A test execution just failed because of an invalid selector or changed DOM structure.
Analyze the provided error message, the target element description, and the current DOM snapshot.
Propose a new robust Playwright selector that will fix the test.

Use the following prioritized fallback strategies:
1. Playwright Text Locators (getByText, text=)
2. Playwright Role/Label Locators (getByRole, getByLabel)
3. Data attributes ([data-testid=])
4. ID attributes (#login-button)
5. Visible Semantic CSS

CRITICAL RULE 1: The candidate must represent the EXACT SAME intended element/action as described in the Target Element Description. If the intended element is genuinely missing from the DOM (e.g. the product was not added, or the assertion text is truly not there), you MUST return an empty array [] to preserve the test failure. DO NOT select unrelated elements just to force a pass!
CRITICAL RULE 2: Candidates MUST be valid Playwright Locator APIs. Do NOT use native DOM element methods like .closest(), .querySelector(), etc. If the original selector was invalid (e.g., getByText(/1/i).closest('span')), the healed selector MUST target the intended element (e.g., the cart badge) using a valid Playwright API (like locator('.shopping_cart_badge') or locator('..').filter(...)).
EXAMPLE 1 of INVALID healing:
Original Action: click(getByRole('link', {{ name: /SauceDemo/i }}))
Intent: "Open SauceDemo" (navigation/start-page behavior)
Candidate: [data-test='login-button']
Decision: REJECTED (return []) because the intent was navigation, not clicking a login button. A navigation instruction must not be transformed into a click on an arbitrary element!
EXAMPLE 2 of INVALID healing:
Original Action: getByText(/login page loads successfully/i)
Intent: "Verify login page loads successfully"
Candidate: [data-test='login-button']
Decision: REJECTED (return []) because the intent was a page-load state assertion, which the generated literal text selector failed to capture properly. Healing must not arbitrarily select a button to represent an entire page state assertion if the semantic intent isn't a 1-to-1 match.
EXAMPLE 3 of INVALID healing:
Original Action: fill(getByPlaceholder(/Last Name/i))
Intent: "Fill Last Name"
Candidate: [data-test='firstName']
Decision: REJECTED (return []) because the semantic intent is to fill the LAST name, not the first name. Do NOT randomly substitute an unrelated input field just to pass. Valid healing candidates would be [data-test='lastName'], input[name='lastName'], etc.
EXAMPLE 4 of INVALID healing:
Original Action: click(getByRole('button', {{ name: /Finish/i }}))
Intent: "Click Finish on the checkout overview page"
Candidate: getByRole('button', {{ name: /Continue/i }})
Decision: REJECTED (return []) because the semantic intent is to click "Finish". You MUST NOT randomly heal to "Continue" or "Cancel" or an unrelated button if the browser is simply not on the correct page. Preserve the real failure if the Finish button is genuinely missing.

Error Message: {errorMessage}
Target Element Description: {elementDesc}
Current DOM Snapshot:
{domSnapshot}

Output ONLY a valid JSON array of up to 3 objects. Do not include markdown codeblocks.
Each object must have:
- "selector": string (the proposed Playwright selector)
- "confidence": number (between 0.0 and 1.0, representing your confidence that this selector is exactly the same semantic element as the original)

Example: [{{"selector": "#login-button", "confidence": 0.95}}, {{"selector": "button[type=submit]", "confidence": 0.70}}]
`);

export class SelfHealingAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async healSelector(errorMessage: string, elementDesc: string, domSnapshot: string): Promise<any[]> {
    const llm = getModel('cheap');
    const chain = prompt.pipe(llm);
    const context = this.executionId ? { executionId: this.executionId, agentName: 'SelfHealingAgent', promptType: 'healSelector' } : undefined;
    const response = await invokeWithRetry(chain, { errorMessage, elementDesc, domSnapshot: domSnapshot.substring(0, 12000) }, 4000, ['domSnapshot'], context);
    let content = response.content as string;
    if (content.startsWith('```json')) content = content.replace(/^```json\n/, '').replace(/\n```$/, '');
    else if (content.startsWith('```')) content = content.replace(/^```\n/, '').replace(/\n```$/, '');
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
        const validCandidates = parsed.filter(c => {
           const validation = validateSelector(c.selector, domSnapshot);
           if (!validation.valid) {
               console.log(`[SELF_HEALING_CANDIDATE_VALIDATION]\ncandidate=${c.selector}\nvalid=false\nreason=${validation.reason}`);
               return false;
           }
           console.log(`[SELF_HEALING_CANDIDATE_VALIDATION]\ncandidate=${c.selector}\nvalid=true\nreason=DOM match`);
           return true;
        });
        return validCandidates;
      }
      return parsed.map((sel: string) => ({ selector: sel, confidence: 0.5 }));
    } catch (e) {
      return [{ selector: content, confidence: 0.5 }];
    }
  }
}
