import { Page } from 'playwright';
import { getModel } from './llm';

export class ValidationAgent {
  async semanticValidate(page: Page, expectedCondition: string) {
    const domSummary = await page.evaluate(() => document.body.innerText.substring(0, 4000));
    
    const prompt = `You are a Semantic Validation Engine. 
The user expected this condition to be true on the page: "${expectedCondition}"
Based on the following extracted visible text from the page, determine if the condition is met.

Visible Text:
${domSummary}

Return a strict JSON object:
{
  "isValid": boolean,
  "reason": "Explanation of why it is valid or invalid based on the text."
}`;

    const model = getModel();
    const response = await model.invoke(prompt);
    
    try {
      const content = response.content as string;
      const startIndex = content.indexOf('{');
      const endIndex = content.lastIndexOf('}') + 1;
      const jsonStr = content.substring(startIndex, endIndex);
      const parsed = JSON.parse(jsonStr);
      return parsed;
    } catch (e) {
      console.error("[ValidationAgent] Failed to parse semantic validation:", e);
      return { isValid: false, reason: "Semantic validation failed to parse." };
    }
  }
}
