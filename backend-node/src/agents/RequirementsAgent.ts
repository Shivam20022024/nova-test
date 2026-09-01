import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';

const prompt = PromptTemplate.fromTemplate(`
You are a QA automation expert. Parse the following unstructured requirement into a structured JSON format for test creation.
The JSON must contain:
- "title": A short, descriptive title.
- "description": Summary of the requirement.
- "targetUrl": The main URL if specified.
- "keyFeatures": Array of strings outlining EVERY specific scenario, test case, or validation point mentioned in the requirements. Do NOT summarize or group them. Preserve all distinct test points.

Requirement:
{rawText}

Output ONLY valid JSON.
`);

export class RequirementsAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async parseRequirements(rawText: string) {
    const llm = getModel('planner');
    const chain = prompt.pipe(llm);
    const context = this.executionId ? { executionId: this.executionId, agentName: 'RequirementsAgent', promptType: 'parseRequirements' } : undefined;
    const response = await invokeWithRetry(chain, { rawText }, 4000, ['rawText'], context);
    
    try {
      let content = response.content as string;
      if (content.startsWith('\`\`\`json')) {
        content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
      }
      return JSON.parse(content.trim());
    } catch (err) {
      console.error("Failed to parse Requirements JSON:", err);
      throw new Error("Requirements parsing failed");
    }
  }
}
