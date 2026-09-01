import { chromium } from 'playwright';
import { getModel, invokeWithRetry } from './llm';
import { z } from 'zod';

const flowSchema = z.object({
  flows: z.array(z.object({
    name: z.string(),
    description: z.string(),
    flow_type: z.string(),
    generated_steps: z.array(z.object({
      action: z.enum(['goto', 'fill', 'click', 'assertVisible', 'assertText', 'wait']),
      url: z.string().describe("Target URL, or empty string if not applicable"),
      selector: z.string().describe("DOM selector, or empty string if not applicable"),
      value: z.string().describe("Value to fill, or empty string if not applicable"),
      contains: z.string().describe("Text to assert or click, or empty string if not applicable"),
    }))
  }))
});

export async function extractCompactDom(page: any) {
  return await page.evaluate(() => {
    const result: { [key: string]: string[], forms: string[], buttons: string[], inputs: string[], links: string[], navigation: string[], products: string[], headings: string[], labels: string[], cart: string[], checkout: string[] } = {
      forms: [], buttons: [], inputs: [], links: [], headings: [], labels: [], navigation: [], products: [], cart: [], checkout: []
    };
    
    const rawSize = document.body.innerHTML.length;

    const extractNode = (el: HTMLElement) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const text = el.innerText?.trim()?.substring(0, 40).replace(/\n/g, ' ') || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || '';
      const typeAttr = el.getAttribute('type') ? ` type="${el.getAttribute('type')}"` : '';
      const nameAttr = el.getAttribute('name') ? ` name="${el.getAttribute('name')}"` : '';
      
      let hrefAttr = '';
      const href = el.getAttribute('href');
      if (href && !href.includes('javascript:') && !href.startsWith('#')) {
         hrefAttr = ` href="${href.substring(0, 40)}"`;
      }
      
      const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      const dataTest = dataTestId ? ` data-testid="${dataTestId}"` : '';
      const ariaLabel = el.getAttribute('aria-label') ? ` aria-label="${el.getAttribute('aria-label')}"` : '';
      
      return `<${tag}${id}${typeAttr}${nameAttr}${hrefAttr}${dataTest}${ariaLabel}>${text}</${tag}>`;
    };

    const badSelectors = 'script, style, noscript, svg, iframe, footer, .tracking, .analytics, [hidden], [style*="display: none"], [style*="display:none"], link[rel="preload"], meta';
    document.querySelectorAll(badSelectors).forEach(node => {
       try { node.remove(); } catch (e) {}
    });
    
    const iterator = document.createNodeIterator(document, NodeFilter.SHOW_COMMENT, null);
    let currentNode;
    while (currentNode = iterator.nextNode()) {
        try { currentNode.parentNode?.removeChild(currentNode); } catch(e) {}
    }

    document.querySelectorAll('form').forEach(el => result.forms.push(extractNode(el as HTMLElement)));
    document.querySelectorAll('button, [role="button"]').forEach(el => result.buttons.push(extractNode(el as HTMLElement)));
    document.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.getAttribute('type') !== 'hidden') result.inputs.push(extractNode(el as HTMLElement));
    });
    document.querySelectorAll('a').forEach(el => {
       const nodeStr = extractNode(el as HTMLElement);
       if (result.links.length < 20) result.links.push(nodeStr);
    });
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]').forEach(el => result.headings.push(extractNode(el as HTMLElement)));
    document.querySelectorAll('label').forEach(el => result.labels.push(extractNode(el as HTMLElement)));
    document.querySelectorAll('nav, .menu, [role="navigation"]').forEach(el => result.navigation.push(extractNode(el as HTMLElement)));
    
    const products = document.querySelectorAll('.product-card, .product, [data-testid*="product"]');
    products.forEach((el, index) => {
      if (index < 5) result.products.push(extractNode(el as HTMLElement));
    });

    document.querySelectorAll('.cart, [data-testid*="cart"], [aria-label*="cart"]').forEach(el => result.cart.push(extractNode(el as HTMLElement)));
    document.querySelectorAll('.checkout, [data-testid*="checkout"], [aria-label*="checkout"]').forEach(el => result.checkout.push(extractNode(el as HTMLElement)));
    
    for (const key of Object.keys(result)) {
       result[key] = Array.from(new Set(result[key] || []));
    }
    
    return { semanticSummary: result, rawSize };
  });
}

/**
 * Read-only snapshot of the page's CURRENT state - unlike extractCompactDom it
 * does NOT mutate the DOM, so it is safe to call on the live shared execution
 * page mid-run (e.g. between strict-scenario batches, to feed later scenarios a
 * post-authentication DOM instead of the stale pre-login crawl).
 */
export async function snapshotLiveDom(page: any, maxChars = 4200): Promise<string> {
  try {
    const data = await page.evaluate(() => {
      const visible = (el: Element) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null;
      };
      const nodeStr = (el: Element) => {
        const e = el as HTMLElement;
        const tag = e.tagName.toLowerCase();
        const id = e.id ? `#${e.id}` : '';
        const dt = e.getAttribute('data-test') || e.getAttribute('data-testid');
        const dtStr = dt ? ` data-test="${dt}"` : '';
        const nm = e.getAttribute('name') ? ` name="${e.getAttribute('name')}"` : '';
        const ty = e.getAttribute('type') ? ` type="${e.getAttribute('type')}"` : '';
        const ph = (e as HTMLInputElement).placeholder ? ` placeholder="${(e as HTMLInputElement).placeholder}"` : '';
        const href = e.getAttribute('href');
        const hrefStr = href && !href.startsWith('javascript:') && !href.startsWith('#') ? ` href="${href.slice(0, 50)}"` : '';
        const role = e.getAttribute('role') ? ` role="${e.getAttribute('role')}"` : '';
        const txt = ((e as HTMLElement).innerText || (e as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        return `<${tag}${id}${dtStr}${nm}${ty}${ph}${role}${hrefStr}>${txt}</${tag}>`;
      };
      const pick = (sel: string, limit: number) =>
        Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, limit).map(nodeStr);
      return {
        url: location.href,
        title: document.title,
        headings: pick('h1,h2,h3,h4,[role="heading"],.title,[class*="header"]', 15),
        buttons: pick('button,[role="button"],input[type="submit"],a[class*="btn"],[class*="button"]', 40),
        inputs: pick('input:not([type="hidden"]),select,textarea', 40),
        links: pick('a[href]', 30),
        labels: pick('label', 20),
        text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      };
    });
    const parts = [
      `CURRENT PAGE (live snapshot): ${data.url}  title="${data.title}"`,
      data.headings.length ? `Headings:\n${data.headings.join('\n')}` : '',
      data.buttons.length ? `Buttons:\n${data.buttons.join('\n')}` : '',
      data.inputs.length ? `Inputs:\n${data.inputs.join('\n')}` : '',
      data.links.length ? `Links:\n${data.links.join('\n')}` : '',
      data.labels.length ? `Labels:\n${data.labels.join('\n')}` : '',
      `Visible text (excerpt): ${data.text}`,
    ].filter(Boolean);
    return parts.join('\n\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

export class DiscoveryAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  async discoverFlows(targetUrl: string, maxPages: number = 3, options: { sharedPage?: any, discoveryPath?: string } = {}) {
    const discoveryPath = options.discoveryPath || 'primary_discovery';
    let browser: any;
    let context: any;
    
    if (!options.sharedPage) {
      console.log(`[DiscoveryAgent] Launching Playwright to crawl starting at ${targetUrl}...`);
      browser = await chromium.launch({ 
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--disable-web-security']
      });
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280 + Math.floor(Math.random() * 100), height: 720 + Math.floor(Math.random() * 100) }
      });
      
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    } else {
      context = options.sharedPage.context();
      const pageId = (options.sharedPage as any)._guid || 'unknown-page';
      console.log(`[DiscoveryAgent] Using shared Playwright context for crawling. DISCOVERY_PAGE_ID: ${pageId}`);
    }
    
    let combinedDomSummary = '';
    const globalSemanticSummary: Record<string, string[]> = {
      forms: [], buttons: [], inputs: [], links: [], navigation: [], products: [], text_hints: []
    };
    let rawDomSizeAccumulator = 0;
    const visited = new Set<string>();
    const queue = [targetUrl];
    let targetOrigin = '';
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch (e) {
      targetOrigin = targetUrl;
    }
    
    try {
      while (queue.length > 0 && visited.size < maxPages) {
        const currentUrl = queue.shift()!;
        if (visited.has(currentUrl)) continue;
        
        visited.add(currentUrl);
        console.log(`[DiscoveryAgent] Crawling ${currentUrl} (${visited.size}/${maxPages})`);
        
        const page = (options.sharedPage && visited.size === 1) ? options.sharedPage : await context.newPage();
        let loaded = false;
        
        try {
          const strategies: any[] = [
            { waitUntil: "domcontentloaded", timeout: 15000 },
          ];

          for (const strategy of strategies) {
            try {
              console.log("[DiscoveryAgent] Trying navigation strategy:", strategy.waitUntil);
              await page.goto(currentUrl, strategy);
              loaded = true;
              break;
            } catch (err) {
              console.warn("[DiscoveryAgent] Navigation strategy failed:", strategy.waitUntil);
            }
          }

          if (!loaded) {
            console.warn(`[DiscoveryAgent] Unable to load URL: ${currentUrl}`);
            if (page !== options.sharedPage) await page.close();
            continue;
          }

          const currentUrlAfterLoad = page.url();
          const pageContent = await page.content();
          const pageContentLower = pageContent.toLowerCase();
          if (currentUrlAfterLoad.includes('challenges.cloudflare.com') || 
              pageContentLower.includes('verify you are human') || 
              pageContentLower.includes('captcha') ||
              pageContentLower.includes('__challenge') ||
              pageContentLower.includes('access denied') ||
              pageContentLower.includes('bot telemetry')) {
            throw new Error("BOT_PROTECTED_SITE");
          }

          // SPA Detection
          const isSPA = await page.evaluate(() => {
            return !!(
              document.querySelector("#root") ||
              document.querySelector("#app") ||
              (window as any).__NEXT_DATA__ ||
              document.querySelector("[ng-version]")
            );
          });

          if (isSPA) {
            console.log("[DiscoveryAgent] SPA detected, waiting for hydration...");
            await page.waitForTimeout(3000);
          }

          try {
            await page.waitForFunction(() => {
              const body = document.body;
              return body && body.innerText.length > 100;
            }, { timeout: 5000 });
            await page.waitForTimeout(1000);
          } catch (err) {}

          // Ecommerce Handling popup closer
          const popupSelectors = [
            "button.accept", "button.close", ".cookie-accept", ".newsletter-close", "[aria-label='Close']", ".modal-close"
          ];
          for (const selector of popupSelectors) {
            try {
              if (await page.isVisible(selector)) {
                await page.click(selector, { timeout: 2000 });
                await page.waitForTimeout(500);
              }
            } catch (err) {}
          }

          // Expose hidden menus
          try {
            const menuHandles = await page.$$('.menu-toggle, .header-menu > ul > li > a, nav a, .dropdown-toggle, [aria-haspopup="true"]');
            for (const handle of menuHandles.slice(0, 5)) {
              await handle.hover({ timeout: 1000 }).catch(() => {});
              await page.waitForTimeout(200);
            }
          } catch (e) {}

          // Extract structured Semantic DOM
          const pageResult = await extractCompactDom(page);
          
          rawDomSizeAccumulator += pageResult.rawSize;
          
          // Merge page results into global
          for (const key of Object.keys(globalSemanticSummary)) {
              const currentArr = globalSemanticSummary[key] || [];
              if (pageResult.semanticSummary[key]) {
                  currentArr.push(...pageResult.semanticSummary[key]);
              }
              globalSemanticSummary[key] = Array.from(new Set(currentArr)); // global dedupe
          }
          
          // Find links for BFS
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href);
          });
          
          for (const link of links) {
            try {
              const urlObj = new URL(link, currentUrl);
              if (urlObj.origin === targetOrigin && !visited.has(urlObj.href) && !queue.includes(urlObj.href)) {
                if (!urlObj.href.match(/\.(pdf|jpg|png|gif|svg)$/i) && !urlObj.href.includes('#')) {
                  queue.push(urlObj.href);
                }
              }
            } catch (e) {}
          }
          
        } catch (err: any) {
          console.error(`[DiscoveryAgent] Error processing ${currentUrl}:`, err);
        } finally {
          if (page !== options.sharedPage) await page.close();
        }
      }
    } catch (err: any) {
      console.error(`[DiscoveryAgent] Failed to crawl:`, err);
    } finally {
      if (!options.sharedPage) {
        await context.close();
        await browser.close();
      }
    }

    let serializedSemantic = JSON.stringify(globalSemanticSummary, null, 2);
    const MAX_DISCOVERY_CHARS = 25000;
    
    console.log(`[DiscoveryAgent] DISCOVERY_PATH=${discoveryPath}`);
    console.log(`[DiscoveryAgent] RAW_DOM_SIZE=${rawDomSizeAccumulator}`);
    console.log(`[DiscoveryAgent] COMPACT_DOM_SIZE=${serializedSemantic.length}`);
    console.log(`[DiscoveryAgent] DISCOVERY_MODE=COMPACT`);
    console.log(`[DiscoveryAgent] TOKEN_ESTIMATE=${Math.floor(serializedSemantic.length / 4)}`);

    if (serializedSemantic.length > MAX_DISCOVERY_CHARS) {
       console.log(`[DiscoveryAgent] Truncating serialized semantic DOM from ${serializedSemantic.length} to ${MAX_DISCOVERY_CHARS}`);
       serializedSemantic = serializedSemantic.substring(0, MAX_DISCOVERY_CHARS) + '\n...[TRUNCATED]';
    }

    combinedDomSummary = serializedSemantic;

    if (discoveryPath === 'cache_validation') {
      console.log(`[DiscoveryAgent] Skipping flow generation for cache validation path.`);
      return { flows: [], domSummary: combinedDomSummary };
    }

    const buildPrompt = (dom: string) => `You are an AI Test Flow Discovery Engine. Based on the following structured interactive elements extracted from multiple crawled pages:
${dom}

CRITICAL: Generate REAL, deep End-to-End (E2E) business workflows, NOT superficial smoke tests. 
For eCommerce sites, you MUST output flows like:
1. Search product -> Open detail -> Add to cart
2. Login -> Update profile
3. Register new account
4. Wishlist -> Move to cart

Analyze the elements and generate an array of realistic test flows.

Each flow must be an object with the following properties:
- "name": A concise name for the flow (e.g. "Valid Login")
- "description": What this flow tests
- "flow_type": E.g. "AUTHENTICATION", "NAVIGATION", "FORM_SUBMISSION", "ECOMMERCE", etc.
- "generated_steps": An array of executable steps.

Each step in "generated_steps" must have:
- "action": Must be one of 'goto', 'fill', 'click', 'assertVisible', 'assertText', 'wait'
- "url": (string) Only provided if action is 'goto'
- "selector": (string) Valid CSS selector based on the extracted DOM. Required for fill, click, assertVisible, assertText.
- "value": (string) Required for 'fill' or 'wait'. Provide realistic test data.
- "contains": (string) Required for 'assertText'. Provide expected text.

IMPORTANT RULES:
1. Base your selectors strictly on the extracted DOM. NEVER invent attributes not present in the DOM.
   Selector priority MUST be:
   - getByRole()
   - getByLabel()
   - #id
   - [data-testid=]
   - [data-test=]
   - visible text
2. Add 'wait' steps after critical actions like submitting forms if needed.`;

    console.log(`[DiscoveryAgent] Sending extracted DOM to LLM for flow generation...`);
    const model = getModel('planner');
    const structuredModel = model.withStructuredOutput(flowSchema, { name: "test_flows" });
    
    let response: any;
    let currentPayloadSize = MAX_DISCOVERY_CHARS;
    let payload = combinedDomSummary;
    let attempt = 0;
    
    while (attempt < 3) {
      attempt++;
      try {
        const context = this.executionId ? { executionId: this.executionId, agentName: 'DiscoveryAgent', promptType: 'discoverFlows' } : undefined;
        response = await invokeWithRetry(structuredModel, buildPrompt(payload), 6000, [], context);
        break;
      } catch (e: any) {
        if (attempt === 3) throw e;
        if (e.message && (e.message.toLowerCase().includes('token') || e.message.toLowerCase().includes('context') || e.message.toLowerCase().includes('limit'))) {
          console.warn(`[DiscoveryAgent] Token overflow detected! Retrying with smaller payload...`);
          currentPayloadSize = Math.floor(currentPayloadSize / 2);
          payload = combinedDomSummary.substring(0, currentPayloadSize) + '\n...[TRUNCATED DUE TO OVERFLOW]';
        } else {
          throw e;
        }
      }
    }
    
    try {
      if (!response || !response.flows) {
        throw new Error("Invalid structured output response from LLM");
      }
      
      const flows = response.flows.map((flow: any, index: number) => ({
        id: `flow_${Date.now()}_${index}`,
        ...flow
      }));
      return { flows, domSummary: combinedDomSummary };
      
    } catch (e: any) {
      console.error("[DiscoveryAgent] Failed to parse LLM response:", e);
      return {
        flows: [
          {
            id: `flow_${Date.now()}_fallback`,
            name: "Generic Smoke Test",
            description: "Basic smoke test navigating to target URL",
            flow_type: "NAVIGATION",
            generated_steps: [
              { action: "goto", url: targetUrl, selector: "", value: "", contains: "" }
            ]
          }
        ],
        domSummary: combinedDomSummary
      };
    }
  }

  async detectCapabilities(domSummary: string): Promise<Record<string, boolean>> {
    const buildPrompt = (dom: string) => `Analyze the following structured semantic DOM and identify if the core capabilities are present.
Return ONLY valid JSON with boolean values. Do not use markdown blocks.

Required schema:
{
  "login": boolean,
  "signup": boolean,
  "search": boolean,
  "checkout": boolean,
  "cart": boolean,
  "crud": boolean,
  "profile": boolean,
  "navigation": boolean
}

DOM:
${dom}`;
    
    const model = getModel('planner');
    let response: any;
    let currentPayloadSize = 25000;
    let payload = domSummary.substring(0, currentPayloadSize);
    let attempt = 0;
    
    while (attempt < 3) {
      attempt++;
      try {
        const context = this.executionId ? { executionId: this.executionId, agentName: 'DiscoveryAgent', promptType: 'detectCapabilities' } : undefined;
        response = await invokeWithRetry(model, buildPrompt(payload), 6000, [], context);
        break;
      } catch (e: any) {
        if (attempt === 3) throw e;
        if (e.message && (e.message.toLowerCase().includes('token') || e.message.toLowerCase().includes('context') || e.message.toLowerCase().includes('limit'))) {
          console.warn(`[DiscoveryAgent] Token overflow detected in capabilities analysis! Retrying with smaller payload...`);
          currentPayloadSize = Math.floor(currentPayloadSize / 2);
          payload = domSummary.substring(0, currentPayloadSize) + '\n...[TRUNCATED DUE TO OVERFLOW]';
        } else {
          throw e;
        }
      }
    }
    try {
      let content = response.content as string;
      const startIndex = content.indexOf('{');
      const endIndex = content.lastIndexOf('}') + 1;
      if (startIndex !== -1 && endIndex > 0) {
        content = content.substring(startIndex, endIndex);
      }
      return JSON.parse(content);
    } catch (e) {
      console.error("[DiscoveryAgent] Failed to detect capabilities:", e);
      return { login: true, search: false, cart: false, checkout: false }; // fallback
    }
  }
}
