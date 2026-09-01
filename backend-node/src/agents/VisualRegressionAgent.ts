import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

export const visualRegressionSchema = z.object({
  hasVisualBugs: z.boolean(),
  issues: z.array(z.string())
});

export class VisualRegressionAgent {
  constructor(private executionId?: string) {}

  async analyzeScreenshot(base64Image: string): Promise<{ hasVisualBugs: boolean, issues: string[] }> {
    const model = new ChatOpenAI({
      modelName: 'gpt-4o',
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY || 'mock-key',
    });
    
    const structuredModel = model.withStructuredOutput(visualRegressionSchema, { name: "VisualRegression" });

    const prompt = `You are an expert QA automation engineer specializing in visual regression testing.
Please analyze the provided screenshot of a web application and identify any obvious visual bugs.
Look for:
- Overlapping text or buttons
- Broken CSS (unrendered styles, massive unstyled lists)
- Severe color contrast issues (e.g., white text on white background)
- Elements clipping off the screen
- Popups or overlays that incorrectly block the main UI

Return hasVisualBugs=true if any issues are found, and list them in the 'issues' array.`;

    const message = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    };

    console.log(`[VisualRegressionAgent] Analyzing screenshot for visual bugs...`);
    
    try {
      const response = await structuredModel.invoke([message as any]);
      return response as { hasVisualBugs: boolean, issues: string[] };
    } catch (err) {
      console.error(`[VisualRegressionAgent] Failed to analyze image:`, err);
      return { hasVisualBugs: false, issues: ['AI Analysis Failed'] };
    }
  }
}
