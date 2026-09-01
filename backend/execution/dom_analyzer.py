from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from playwright.async_api import Page, async_playwright


DOM_ANALYSIS_SCRIPT = """
() => {
  const nodes = Array.from(document.querySelectorAll('input,button,select,textarea,a,[role],label,[aria-label],[data-testid]'));
  const results = [];
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  for (const el of nodes) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    const attrs = {
      tag,
      id: el.id || null,
      name: el.getAttribute('name'),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      'aria-label': el.getAttribute('aria-label'),
      'data-testid': el.getAttribute('data-testid'),
      text,
      href: el.getAttribute('href')
    };
    const selectors = [];
    if (attrs['data-testid']) selectors.push(`[data-testid="${attrs['data-testid']}"]`);
    if (attrs['aria-label']) selectors.push(`[aria-label="${attrs['aria-label']}"]`);
    if (attrs.id) selectors.push(`#${attrs.id}`);
    if (attrs.name && ['input','textarea','select'].includes(tag)) selectors.push(`${tag}[name="${attrs.name}"]`);
    if (attrs.placeholder) selectors.push(`${tag}[placeholder="${attrs.placeholder}"]`);
    if (attrs.role) selectors.push(`[role="${attrs.role}"]`);
    if (text && text.length <= 60) selectors.push(`text=${text}`);
    attrs.selectors = selectors;
    results.push(attrs);
    if (results.length >= 120) break;
  }
  return results;
}
"""


async def extract_dom_elements(page: Page) -> List[Dict[str, Any]]:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
    except Exception:
        pass
    try:
        return await page.evaluate(DOM_ANALYSIS_SCRIPT)
    except Exception:
        return []


async def analyze_live_dom(
    base_url: str,
    browser: str = "chromium",
    headless: bool = True,
) -> List[Dict[str, Any]]:
    pw = None
    browser_obj = None
    context = None
    try:
        pw = await async_playwright().start()
        launcher = {"chromium": pw.chromium, "firefox": pw.firefox, "webkit": pw.webkit}.get(browser, pw.chromium)
        browser_obj = await launcher.launch(headless=headless)
        context = await browser_obj.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900})
        page = await context.new_page()
        await page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        return await extract_dom_elements(page)
    except Exception:
        return []
    finally:
        if context:
            await context.close()
        if browser_obj:
            await browser_obj.close()
        if pw:
            await pw.stop()
