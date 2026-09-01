import { Page } from 'playwright';
import { injectAxe, getAxeResults } from 'axe-playwright';

export class AccessibilityAgent {
  async runAccessibilityScan(page: Page) {
    try {
      await injectAxe(page);
      
      const results = await getAxeResults(page, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
        }
      });
      
      const violations = results.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.length
      }));
      
      return {
        success: violations.length === 0,
        violations
      };
    } catch (e: any) {
      console.error("[AccessibilityAgent] Failed to run axe-core:", e);
      return { success: false, error: e.message, violations: [] };
    }
  }
}
