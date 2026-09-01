import { Page } from 'playwright';

export class SecuritySanityAgent {
  async runSecurityChecks(page: Page) {
    const checks = {
      mixedContent: false,
      missingHeaders: [] as string[],
      insecureForms: false,
    };
    
    try {
      // 1. Check for mixed content (HTTP forms/resources on HTTPS page)
      const currentUrl = page.url();
      if (currentUrl.startsWith('https://')) {
        const insecureResources = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('link[href^="http://"], script[src^="http://"], img[src^="http://"]'));
          return links.length;
        });
        if (insecureResources > 0) {
          checks.mixedContent = true;
        }

        const insecureForms = await page.evaluate(() => {
          const forms = Array.from(document.querySelectorAll('form[action^="http://"]'));
          return forms.length > 0;
        });
        checks.insecureForms = insecureForms;
      }
      
      // 2. We can optionally inspect headers from network requests, but since Playwright page is already loaded,
      // it's best done via a network interception during the run.
      // For this sanity agent, we'll return the DOM-level checks.

      return {
        success: !checks.mixedContent && !checks.insecureForms,
        issues: checks
      };
    } catch (e: any) {
      console.error("[SecuritySanityAgent] Error running security checks:", e);
      return { success: false, issues: checks, error: e.message };
    }
  }
}
