import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';
import { z } from 'zod';

const negativeTestPrompt = PromptTemplate.fromTemplate(`
You are an expert QA Test Designer.
Based on the provided capabilities and DOM summary, generate exhaustive NEGATIVE test cases (e.g., invalid inputs, empty fields, basic security injections like XSS or SQLi, missing required fields).

Capabilities:
{capabilities}

DOM Summary:
{domSummary}

Output MUST be a valid JSON array of test case objects. Each object must have:
- description: A clear description of the negative test.
- type: "negative"
- priority: "P0", "P1", or "P2" (P0 for critical paths, P1 for forms/search, P2 for edge cases)
- capability: The related capability name (e.g., "auth", "forms", "security")

Do NOT include positive tests.
Do NOT include markdown formatting outside the JSON array.
`);

export class NegativeTestGeneratorAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async generate(capabilities: Record<string, boolean>, domSummary: string): Promise<any[]> {
    const jsonSchema = {
      type: "object",
      properties: {
        tests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              type: { type: "string" },
              priority: { type: "string" },
              capability: { type: "string" }
            },
            required: ["description", "type", "priority", "capability"],
            additionalProperties: false
          }
        }
      },
      required: ["tests"],
      additionalProperties: false
    };
    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: "NegativeTestGeneration", strict: true });
    const chain = negativeTestPrompt.pipe(llm);
    
    const context = this.executionId ? { executionId: this.executionId, agentName: 'NegativeTestGeneratorAgent', promptType: 'generate_negative' } : undefined;
    const response = await invokeWithRetry(chain, {
      capabilities: JSON.stringify(capabilities),
      domSummary: domSummary.substring(0, 12000)
    }, 4000, ['domSummary'], context);

    return response.tests as any[];
  }
}
