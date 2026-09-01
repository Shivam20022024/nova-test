import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

const capabilityPrompt = PromptTemplate.fromTemplate(`
You are an expert Test Intelligence Agent.
Analyze the following HTML/DOM summary and infer the capabilities of the application.
Only infer capabilities from the discovered evidence. Do NOT hallucinate.

Typical capabilities include:
- login
- signup
- forgot_password
- search
- checkout
- cart
- wishlist
- forms
- crud
- admin
- profile
- api_endpoints
- navigation

Output a valid JSON object mapping capability names to booleans.

DOM Summary:
{domSummary}
`);

export class CapabilityAnalyzerAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async analyze(domSummary: string): Promise<Record<string, boolean>> {
    const capabilitySchema = {
      type: "json_schema",
      json_schema: {
        name: "CapabilityAnalysis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            login: { type: "boolean" },
            signup: { type: "boolean" },
            search: { type: "boolean" },
            checkout: { type: "boolean" },
            cart: { type: "boolean" },
            crud: { type: "boolean" },
            profile: { type: "boolean" },
            navigation: { type: "boolean" }
          },
          required: [
            "login",
            "signup",
            "search",
            "checkout",
            "cart",
            "crud",
            "profile",
            "navigation"
          ]
        }
      }
    };
    
    console.log("[DEBUG] CapabilityAnalyzer Schema to OpenAI:", JSON.stringify(capabilitySchema, null, 2));
    
    // Completely bypass Langchain's schema generator and use native OpenAI JSON Schema mode
    const llm = new ChatOpenAI({
      modelName: process.env.OPENAI_MODEL || 'gpt-4o',
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY || 'mock-key',
      modelKwargs: { response_format: capabilitySchema },
      timeout: 30000,
      maxRetries: 1
    });
    const chain = capabilityPrompt.pipe(llm);
    
    const context = this.executionId ? { executionId: this.executionId, agentName: 'CapabilityAnalyzerAgent', promptType: 'analyze' } : undefined;
    const response = await invokeWithRetry(chain, {
      domSummary: domSummary.substring(0, 12000)
    }, 4000, ['domSummary'], context);

    // Parse the raw JSON string returned by the LLM
    let content = typeof response === 'string' ? response : (response.content as string);
    if (content.startsWith('```json')) content = content.replace(/^```json\n/, '').replace(/\n```$/, '');
    else if (content.startsWith('```')) content = content.replace(/^```\n/, '').replace(/\n```$/, '');

    return JSON.parse(content) as Record<string, boolean>;
  }
}
