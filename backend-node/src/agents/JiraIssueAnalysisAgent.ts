import { z } from 'zod';
import { getModel, invokeWithRetry } from './llm';

/**
 * Jira Intake — the accuracy core.
 *
 * Takes the fully-assembled context of a Jira bug (summary, description, every
 * custom field, comments, and every linked user story with its acceptance
 * criteria — see src/services/jiraIntakeService.ts::assembleIssueContext) and
 * turns it into a precise, reproducible TestIntent that the existing autonomous
 * pipeline (/api/v1/autonomous/run -> ScenarioParserAgent -> ExecutionAgent) can
 * run.
 *
 * The agent is deliberately conservative: it never invents selectors or URLs,
 * it separates "reproduce the reported problem" from "verify the story's
 * expected behaviour", and it downgrades its own confidence (which the caller
 * uses to decide whether to run at all) whenever the bug is missing repro
 * steps, an expected result, or a URL.
 *
 * Same construction pattern as ScenarioParserAgent / DbTestSuiteGeneratorAgent:
 * getModel('planner').withStructuredOutput(zodSchema) + invokeWithRetry.
 */

export const testIntentSchema = z.object({
  understood: z
    .string()
    .describe('2-4 plain sentences restating what is reported broken AND what the correct behaviour should be. No jargon.'),
  targetUrl: z
    .string()
    .nullable()
    .describe('A concrete http(s) URL of the affected page, ONLY if one literally appears in the issue or a linked story. Otherwise null.'),
  targetUrlSource: z.enum(['issue', 'none']).describe("'issue' if targetUrl was taken from the text, 'none' if you could not find one."),
  needsAuth: z.boolean().describe('True if the affected flow is behind a login.'),
  scenarios: z
    .array(
      z.object({
        name: z.string().describe('Short imperative title, e.g. "Add item to cart and verify the badge count".'),
        steps: z
          .array(z.string())
          .min(1)
          .describe('Ordered, imperative UI actions — ONE action per string, e.g. "Click the \\"Add to cart\\" button". Start from opening the target URL. Never reference CSS selectors or element ids.'),
        expectedResult: z
          .string()
          .describe('The single, checkable outcome that proves correct behaviour — drawn from the linked story / acceptance criteria where possible, not from the (broken) current behaviour.'),
        reproducesReportedBug: z
          .boolean()
          .describe('True if this scenario walks the exact path the reporter described; false if it is an additional check derived from the story.'),
      }),
    )
    .min(1)
    .max(8),
  focusAreas: z.array(z.string()).describe('The specific UI areas / features this run should scrutinise.'),
  outOfScope: z.array(z.string()).describe('Things explicitly NOT to test on this run (unrelated features, backend-only concerns).'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe("'low' if the issue lacks reproduction steps OR a clear expected result OR any URL. 'high' only if all three are present and unambiguous."),
  missingInfo: z
    .array(z.string())
    .describe('Every assumption you had to make and every piece of information the issue should have contained but did not.'),
});

export type TestIntent = z.infer<typeof testIntentSchema>;

const SYSTEM_PROMPT = `You are a senior QA engineer at NovaTest AI. A teammate on a client's team has raised a bug in Jira. Your job is to design an automated UI test that (1) reproduces the exact problem they reported, and (2) verifies what the application SHOULD do, using the linked user story / acceptance criteria as the source of truth for correct behaviour.

Rules — follow them exactly:
- Work ONLY from the information given below. Do not invent facts, URLs, credentials, element ids, or CSS selectors.
- Steps are plain-English UI actions a person would take, one action per step, in order. Begin every scenario from opening the affected page.
- "expectedResult" must describe correct behaviour (from the story / acceptance criteria), NOT the broken behaviour the reporter is seeing.
- Put at least one scenario with reproducesReportedBug = true that follows the reporter's path precisely. Add extra scenarios only if the linked story clearly implies more checks.
- Set confidence = "low" if ANY of these is missing or vague: reproduction steps, the expected result, a page URL. Set "high" only when all three are explicit and unambiguous. Otherwise "medium".
- List EVERY assumption you made and EVERY missing detail in missingInfo, even small ones.
- If no URL appears anywhere in the text, set targetUrl = null and targetUrlSource = "none". Do not guess a URL from the product name.
- Keep the number of scenarios small and focused (usually 1-3). Never exceed 8.`;

export class JiraIssueAnalysisAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }

  async analyze(assembledContext: string): Promise<TestIntent> {
    const model = getModel('planner');
    const structured = model.withStructuredOutput(testIntentSchema, { name: 'JiraIssueTestIntent' });

    const prompt = `${SYSTEM_PROMPT}

===== JIRA ISSUE CONTEXT =====
${assembledContext}
===== END CONTEXT =====

Produce the TestIntent now.`;

    const context = this.executionId
      ? { executionId: this.executionId, agentName: 'JiraIssueAnalysisAgent', promptType: 'analyze' }
      : undefined;

    // 12k-token budget: a bug plus 2-3 linked stories with acceptance criteria
    // comfortably fits; invokeWithRetry halves and retries if a huge issue blows past it.
    const result = (await invokeWithRetry(structured, prompt, 12000, [], context)) as TestIntent;

    // Defensive normalisation — withStructuredOutput already enforces the shape,
    // but keep the caller's branching (confidence / targetUrl) on solid ground.
    return {
      ...result,
      targetUrl: result.targetUrl && /^https?:\/\//i.test(result.targetUrl) ? result.targetUrl : null,
      targetUrlSource: result.targetUrl && /^https?:\/\//i.test(result.targetUrl) ? 'issue' : 'none',
      scenarios: (result.scenarios || []).slice(0, 8),
      missingInfo: result.missingInfo || [],
      focusAreas: result.focusAreas || [],
      outOfScope: result.outOfScope || [],
    };
  }

  /**
   * Render a TestIntent's scenarios as the numbered text the backend
   * ScenarioParserAgent handles best (EXACT_NUMBERED mode — see
   * ScenarioParserAgent.ts). This becomes the `rawScenario` passed to
   * /api/v1/autonomous/run.
   */
  static toRawScenario(intent: TestIntent): string {
    return intent.scenarios
      .map((s, i) => {
        const lines = [`${i + 1}. ${s.name}`, 'Steps:'];
        for (const step of s.steps) lines.push(`- ${step}`);
        lines.push(`Expected: ${s.expectedResult}`);
        return lines.join('\n');
      })
      .join('\n\n');
  }
}
