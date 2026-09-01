import { PromptTemplate } from '@langchain/core/prompts';
import { getModel, invokeWithRetry } from './llm';

export class RawCodeGenerationAgent {
  async generateCode(instructions: string, url: string, framework: string): Promise<string> {
    // We use a regular prompt returning a string, not structured output, because we want raw code
    const llm = getModel('planner');
    
    let frameworkContext = "";
    if (framework.toLowerCase() === 'playwright') {
        frameworkContext = "Playwright (TypeScript) using @playwright/test. Provide a fully runnable test file with `import { test, expect } from '@playwright/test';`";
    } else if (framework.toLowerCase() === 'cypress') {
        frameworkContext = "Cypress (JavaScript). Provide a fully runnable test file with `describe(...)` and `it(...)`.";
    } else if (framework.toLowerCase() === 'selenium') {
        frameworkContext = "Selenium WebDriver (Python) using pytest. Provide a fully runnable test file with `from selenium import webdriver` and a test function.";
    } else {
        frameworkContext = `${framework} testing framework code.`;
    }

    const generateCodePrompt = PromptTemplate.fromTemplate(`
You are an expert Test Automation Engineer.
Your task is to write a complete, executable, production-ready E2E test script based strictly on the user's natural language instructions.

Target Framework: {frameworkContext}
Target URL: {url}

User Instructions:
{instructions}

RULES:
1. ONLY return the raw, unformatted code. DO NOT wrap the code in markdown code blocks (no \`\`\`). DO NOT include any explanations or conversational text.
2. The code must be immediately runnable by the respective test runner.
3. Start the test by navigating to the Target URL if applicable.
4. Use best practices for the target framework (e.g., proper locators, wait conditions, assertions).

Generated Code:`);

    const chain = generateCodePrompt.pipe(llm);
    
    const response: any = await invokeWithRetry(chain, {
      frameworkContext,
      url,
      instructions
    }, 4000);
    
    let code = response.content || response.text || response;
    
    // Fallback: Strip markdown code blocks if the LLM hallucinated them despite instructions
    if (typeof code === 'string') {
        code = code.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '').trim();
    }
    
    return code;
  }
}
