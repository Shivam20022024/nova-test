import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';

const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7,
  modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
});

const prompt = PromptTemplate.fromTemplate(`
You are a QA Data Generator. Given the following test case and a summary of the page's visible text/DOM, generate plausible test data needed to execute the steps.

Test Case:
{testCase}

Page Content/Hints:
{domSummary}

CRITICAL: 
1. If you see demo credentials (like "Username: Admin", "Password: admin123") in the Page Content, you MUST use them for positive login scenarios. Do NOT hallucinate random credentials for demo apps.
2. For negative auth flows, deliberately generate incorrect/invalid credentials.

Output ONLY a valid JSON object representing key-value pairs of the required data (e.g. {{"email": "Admin", "password": "admin123"}}).
`);

export class TestDataAgent {
  async generateData(testCase: any, domSummary: string = "") {
    const chain = prompt.pipe(llm);
    const response = await chain.invoke({ testCase: JSON.stringify(testCase), domSummary: domSummary.substring(0, 12000) });
    
    try {
      let content = response.content as string;
      if (content.startsWith('\`\`\`json')) {
        content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
      }
      return JSON.parse(content.trim());
    } catch (err) {
      console.error("Failed to parse TestData JSON:", err);
      return {}; // Fallback to empty data
    }
  }
}
