import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';
import { z } from 'zod';

const positiveTestPrompt = PromptTemplate.fromTemplate(`
You are an expert QA Test Designer.
Based on the provided capabilities and DOM summary, generate exhaustive POSITIVE (happy-path) test cases.

Capabilities:
{capabilities}

DOM Summary:
{domSummary}

Output MUST be a valid JSON array of test case objects. Each object must have:
- description: A clear description of the happy-path test.
- type: "positive"
- priority: "P0", "P1", or "P2" (P0 for critical like auth/checkout/CRUD, P1 for forms/search/navigation, P2 for edge cases/polish)
- capability: The related capability name (e.g., "auth", "checkout")

Do NOT include negative tests (e.g., invalid inputs, missing fields).
Do NOT include markdown formatting outside the JSON array.
`);

export class PositiveTestGeneratorAgent {
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
    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: "PositiveTestGeneration", strict: true });
    const chain = positiveTestPrompt.pipe(llm);
    
    const context = this.executionId ? { executionId: this.executionId, agentName: 'PositiveTestGeneratorAgent', promptType: 'generate_positive' } : undefined;
    const response = await invokeWithRetry(chain, {
      capabilities: JSON.stringify(capabilities),
      domSummary: domSummary.substring(0, 12000)
    }, 4000, ['domSummary'], context);

    return response.tests as any[];
  }
}
