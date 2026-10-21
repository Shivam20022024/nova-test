/**
 * Tells a real bot-challenge INTERSTITIAL (the page IS the challenge) apart from an
 * ordinary page that merely EMBEDS a Turnstile/CAPTCHA widget (e.g. a login form).
 * Substring-matching the HTML for "turnstile" / "captcha" flagged every such login
 * page as blocked. The widget markers (.cf-turnstile, challenges.cloudflare.com
 * iframes, cf-chl-widget-* ids) are deliberately NOT treated as a block here.
 *   - light: JS challenge that usually self-resolves ("Just a moment...")
 *   - hard:  interactive challenge that needs a human or a solver
 */
export async function detectAntiBotInterstitial(page: any): Promise<{ light: boolean; hard: boolean }> {
  try {
    const url: string = page.url();
    const title: string = String((await page.title().catch(() => '')) || '').toLowerCase();
    const probe = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      return {
        challengeDom: !!document.querySelector('#challenge-running, #challenge-stage, #cf-challenge-running, form#challenge-form'),
        verifyHumanText: bodyText.includes('verify you are human') || bodyText.includes('performing security verification'),
        formControls: document.querySelectorAll('input, textarea, select').length,
      };
    }).catch(() => ({ challengeDom: false, verifyHumanText: false, formControls: 0 }));

    const light = url.includes('challenges.cloudflare.com')
      || /^(just a moment|checking your browser)/.test(title)
      || probe.challengeDom;
    // A "verify you are human" line on a page that has real form inputs is a form
    // with a widget, not a wall; only treat it as hard when nothing else is there.
    const hard = /^attention required/.test(title)
      || (probe.verifyHumanText && probe.formControls === 0);
    return { light, hard };
  } catch {
    return { light: false, hard: false };
  }
}
