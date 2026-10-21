/**
 * Automatically dismisses INFORMATIONAL blocking dialogs (welcome tours, "what's new", cookie /
 * notice banners) that would otherwise intercept the click or typing of the next step.
 *
 * Deliberately conservative so it can never hijack a real flow:
 *   - only acts when the step's target is NOT inside the dialog (a step that targets the dialog
 *     itself, e.g. "click Got it", is left alone);
 *   - never touches a dialog that contains a form control (input / textarea / select) - those are
 *     real flows such as "Add appointment";
 *   - only clicks buttons whose label is a plain dismissal ("Got it", "OK", "Close", "Dismiss",
 *     "Skip", "No thanks", "Maybe later", "Not now") - never "Accept", "Continue", "Delete", ...
 */
const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]';
const DISMISS_LABEL = /^(got it|ok|okay|close|dismiss|skip|skip tour|no,? thanks|maybe later|not now|×|x)$/i;

export async function dismissBlockingOverlay(page: any, targetLoc: any, log: (msg: string) => void): Promise<boolean> {
  try {
    const targetInDialog: boolean = await targetLoc
      .evaluate((n: Element, sel: string) => !!n.closest(sel), DIALOG_SELECTOR)
      .catch(() => false);
    if (targetInDialog) return false;

    const dialogs = page.locator(DIALOG_SELECTOR);
    const count = await dialogs.count();
    for (let i = 0; i < count; i++) {
      const dlg = dialogs.nth(i);
      if (!(await dlg.isVisible().catch(() => false))) continue;
      const hasFormControl = (await dlg.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0)) > 0;
      if (hasFormControl) continue;

      const buttons = dlg.locator('button, [role="button"]');
      const n = await buttons.count();
      for (let b = 0; b < n; b++) {
        const btn = buttons.nth(b);
        const label = ((await btn.getAttribute('aria-label').catch(() => '')) || (await btn.innerText().catch(() => '')) || '').trim();
        if (DISMISS_LABEL.test(label) && (await btn.isVisible().catch(() => false))) {
          log(`[AutoDismiss] A blocking dialog was in the way of the next step; clicked "${label}".`);
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
          return true;
        }
      }
    }
  } catch {
    /* never let overlay handling break a step */
  }
  return false;
}

/**
 * Step-level variant, run at the START of a step - before the target is located.
 *
 * Why it must run first: while a modal is open, many apps mark everything behind it aria-hidden / inert,
 * and role-based lookups (getByRole) deliberately ignore hidden elements. So with a welcome tour on top,
 * even `getByRole('button', { name: /Save/ })` finds nothing - the target can't be located, and the
 * locator-based variant above never gets the chance to run.
 *
 * Safety: it does nothing when the step is evidently ABOUT the dialog. It compares the salient text of the
 * step (quoted phrases, names inside regex locators) with the dialog's own text; any overlap means the
 * step targets the dialog and the dialog is left alone.
 */
export async function dismissBlockingOverlayForStep(
  page: any,
  stepText: string,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const dialogs = page.locator(DIALOG_SELECTOR);
    const count = await dialogs.count();
    if (count === 0) return false;

    const tokens = new Set<string>();
    for (const m of stepText.matchAll(/["“”]([^"“”]{3,80})["“”]/g)) tokens.add((m[1] ?? '').toLowerCase().trim());
    for (const m of stepText.matchAll(/\/([^/\n]{3,60})\/[a-z]*/g)) tokens.add((m[1] ?? '').replace(/\\/g, '').toLowerCase().trim());
    for (const m of stepText.matchAll(/name\s*:\s*['"]([^'"]{3,60})['"]/g)) tokens.add((m[1] ?? '').toLowerCase().trim());

    for (let i = 0; i < count; i++) {
      const dlg = dialogs.nth(i);
      if (!(await dlg.isVisible().catch(() => false))) continue;
      if ((await dlg.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0)) > 0) continue;

      const dialogText = ((await dlg.innerText().catch(() => '')) || '').toLowerCase().replace(/\s+/g, ' ');
      const aboutTheDialog = Array.from(tokens).some((t) => t.length >= 3 && dialogText.includes(t.replace(/\s+/g, ' ')));
      if (aboutTheDialog) return false;

      const buttons = dlg.locator('button, [role="button"]');
      const n = await buttons.count();
      for (let b = 0; b < n; b++) {
        const btn = buttons.nth(b);
        const label = ((await btn.getAttribute('aria-label').catch(() => '')) || (await btn.innerText().catch(() => '')) || '').trim();
        if (DISMISS_LABEL.test(label) && (await btn.isVisible().catch(() => false))) {
          log(`[AutoDismiss] A blocking dialog was covering the page; clicked "${label}" before running the step.`);
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(600);
          return true;
        }
      }
    }
  } catch {
    /* never let overlay handling break a step */
  }
  return false;
}
