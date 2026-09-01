import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';

const prompt = PromptTemplate.fromTemplate(`
You are a Lead QA Engineer. Based on the following structured requirements and Feature Capability Map, generate a list of detailed Test Cases.
Each test case must include specific steps and assertions.

CRITICAL INSTRUCTION 1 (DOM Grounding): 
DO NOT hallucinate features. You MUST respect the Capability Map. If a feature (e.g., "search" or "wishlist") is false or not present in the DOM/Capabilities, DO NOT generate a test case for it.

CRITICAL INSTRUCTION 2 (Workflow Dependency Engine):
Tests must logically follow prerequisites. You cannot assert a successful checkout if the cart was never populated. 
Specify the prerequisites for each test case.

CRITICAL INSTRUCTION 3 (Auth Logic):
Explicitly separate Positive and Negative auth flows. 
- Positive Login: Valid credentials. MUST expect to see a dashboard, user menu, or successful redirect.
- Negative Login: Invalid credentials. MUST expect to see an error banner or validation message.

CRITICAL INSTRUCTION 4 (Granularity):
You MUST generate a SEPARATE test case object for EVERY distinct scenario, validation, or flow mentioned in the requirements. Do NOT combine multiple scenarios into a single test case. If the requirements list 12 different tests, you must output an array of 12 test case objects.

Requirements JSON:
{requirements}

Capability Map:
{capabilities}

Output the result as a valid JSON array of objects. Each object must have:
- "name": Test Case Name
- "description": Test Case Description
- "prerequisites": Array of prerequisite test names or flow states (e.g., ["Login", "Add to Cart"])
- "steps": Array of strings (e.g. "Navigate to /login", "Fill out email field", "Click submit", "Assert success message")

Output ONLY valid JSON.
`);

export class TestCaseAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async generateTestCases(requirements: any, capabilityMap?: any) {
    const llm = getModel('planner');
    const chain = prompt.pipe(llm);
    const context = this.executionId ? { executionId: this.executionId, agentName: 'TestCaseAgent', promptType: 'generateTestCases' } : undefined;
    const response = await invokeWithRetry(chain, { 
      requirements: JSON.stringify(requirements),
      capabilities: JSON.stringify(capabilityMap || {})
    }, 6000, ['requirements', 'capabilities'], context);
    
    try {
      let content = response.content as string;
      if (content.startsWith('\`\`\`json')) {
        content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
      }
      return JSON.parse(content.trim());
    } catch (err) {
      console.error("Failed to parse TestCases JSON:", err);
      throw new Error("Test Case generation failed");
    }
  }
}
