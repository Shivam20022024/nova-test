/**
 * Support for custom (non-<select>) dropdowns - the dominant pattern in modern web apps:
 * a button/div with role="combobox" (or aria-haspopup) that opens a popup list of options.
 * Playwright's selectOption only works on native <select>, so we open the control and click the
 * option whose text matches. Generic: relies only on ARIA roles / visible text.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True if the element looks like a custom dropdown trigger rather than a plain button/input. */
export async function isCustomDropdown(loc: any): Promise<boolean> {
  return await loc
    .evaluate((el: Element) => {
      const role = (el.getAttribute('role') || '').toLowerCase();
      const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      return role === 'combobox' || role === 'listbox' || (popup !== '' && popup !== 'false') || el.hasAttribute('aria-expanded');
    })
    .catch(() => false);
}

/** Opens the dropdown and clicks the option matching `want`. Returns the option text, or throws. */
export async function chooseCustomOption(page: any, trigger: any, want: string, timeoutMs: number): Promise<string> {
  const text = String(want ?? '').trim();
  if (!text) throw new Error('Custom dropdown selection needs a value (the option text).');
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: timeoutMs });

  const exact = new RegExp(`^\\s*${escapeRe(text)}\\s*$`, 'i');
  const partial = new RegExp(escapeRe(text), 'i');
  const candidates = [
    page.getByRole('option', { name: exact }),
    page.getByRole('option', { name: partial }),
    page.getByRole('menuitem', { name: exact }),
    page.getByRole('menuitem', { name: partial }),
    page.locator('[role="listbox"] *, [role="menu"] *, [data-radix-popper-content-wrapper] *').filter({ hasText: exact }),
    page.locator('[role="listbox"] *, [role="menu"] *, [data-radix-popper-content-wrapper] *').filter({ hasText: partial }),
  ];

  const deadline = Date.now() + Math.min(timeoutMs, 8000);
  while (Date.now() < deadline) {
    for (const cand of candidates) {
      try {
        const opt = cand.last();
        if (await opt.isVisible().catch(() => false)) {
          const label = (await opt.innerText().catch(() => '')).trim() || text;
          await opt.click({ timeout: 3000 });
          return label;
        }
      } catch {
        /* try next candidate */
      }
    }
    await page.waitForTimeout(250);
  }
  // Leave the page tidy: close the popup we opened.
  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`Custom dropdown option "${text}" was not found after opening the control.`);
}
