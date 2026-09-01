import type { AntiBotSolver } from '../utils/antiBot';

/**
 * Phase 5 - CAPTCHA / interstitial handling for AUTHORIZED testing only.
 *
 * Tried only when ExecutionAgent has already detected a hard block. Uses the
 * common createTask / getTaskResult JSON API (2captcha, Anti-Captcha, CapMonster,
 * CapSolver). No third-party npm dependency - plain fetch.
 *
 * If no solver is configured, `maybeSolve` is a no-op and the run proceeds to the
 * honest BLOCKED outcome.
 */

type Emit = (type: string, message: string) => void;

export type ChallengeType =
  | 'turnstile'
  | 'recaptcha_v2'
  | 'hcaptcha'
  | 'datadome'
  | 'cloudflare_interstitial'
  | 'none';

export interface DetectedChallenge {
  type: ChallengeType;
  sitekey?: string;
  pageUrl: string;
  action?: string;
  data?: string;
}

const PROVIDER_BASE: Record<string, string> = {
  '2captcha': 'https://api.2captcha.com',
  twocaptcha: 'https://api.2captcha.com',
  anticaptcha: 'https://api.anti-captcha.com',
  'anti-captcha': 'https://api.anti-captcha.com',
  capmonster: 'https://api.capmonster.cloud',
  capsolver: 'https://api.capsolver.com',
};

export class ChallengeSolverAgent {
  private emit: Emit;
  constructor(emit?: Emit) {
    this.emit = emit || (() => {});
  }

  /** Inspect the page for a known challenge. Runs entirely in-page, no network. */
  async detect(page: any): Promise<DetectedChallenge> {
    const pageUrl = page.url();
    try {
      const found: Omit<DetectedChallenge, 'pageUrl'> = await page.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement | null;
        const attr = (el: HTMLElement | null, a: string) => (el ? el.getAttribute(a) || undefined : undefined);

        const ts = q('.cf-turnstile[data-sitekey]') || q('[data-sitekey][data-callback]') || q('div#cf-turnstile');
        if (ts || (window as any).turnstile) {
          const el = ts || q('[data-sitekey]');
          return { type: 'turnstile', sitekey: attr(el, 'data-sitekey'), action: attr(el, 'data-action'), data: attr(el, 'data-cdata') };
        }

        const gr = q('.g-recaptcha[data-sitekey]') || q('[data-sitekey].g-recaptcha') || q('#g-recaptcha');
        const grIframe = document.querySelector('iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha/api2"]');
        if (gr || grIframe) {
          let sk = attr(gr, 'data-sitekey');
          if (!sk && grIframe) {
            const m = (grIframe.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
            sk = m ? m[1] : undefined;
          }
          return { type: 'recaptcha_v2', sitekey: sk };
        }

        const hc = q('.h-captcha[data-sitekey]') || q('[data-sitekey].h-captcha');
        const hcIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
        if (hc || hcIframe) return { type: 'hcaptcha', sitekey: attr(hc, 'data-sitekey') };

        if (document.querySelector('iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha-delivery.com"]')) {
          return { type: 'datadome' };
        }

        const bodyTxt = (document.body?.innerText || '').toLowerCase();
        if (
          document.title.toLowerCase().includes('just a moment') ||
          bodyTxt.includes('checking if the site connection is secure') ||
          bodyTxt.includes('verifying you are human') ||
          document.querySelector('#challenge-running, #cf-challenge-running')
        ) {
          return { type: 'cloudflare_interstitial' };
        }

        return { type: 'none' };
      });
      return { ...found, pageUrl } as DetectedChallenge;
    } catch {
      return { type: 'none', pageUrl };
    }
  }

  /**
   * Detect -> solve -> inject -> wait for the page to progress.
   * Returns true if the challenge appears cleared.
   */
  async maybeSolve(page: any, solver?: AntiBotSolver): Promise<boolean> {
    const challenge = await this.detect(page);
    if (challenge.type === 'none') return false;

    this.emit('agent_log', `[ChallengeSolver] Detected challenge: ${challenge.type}${challenge.sitekey ? ` (sitekey ${challenge.sitekey.slice(0, 12)}...)` : ''}`);

    if (challenge.type === 'cloudflare_interstitial') {
      // A managed challenge with no checkbox usually clears itself in a real
      // browser - just wait it out; a token solver cannot help here.
      this.emit('agent_log', '[ChallengeSolver] Waiting out Cloudflare managed interstitial...');
      const cleared = await this.waitForClear(page, 25000);
      this.emit('agent_log', `[ChallengeSolver] Interstitial ${cleared ? 'cleared' : 'still present'}.`);
      return cleared;
    }

    if (!solver) {
      this.emit('agent_log', '[ChallengeSolver] No solver configured - not attempting to solve. Execution will report BLOCKED.');
      return false;
    }
    if (challenge.type === 'datadome') {
      this.emit('agent_log', '[ChallengeSolver] DataDome slider challenges require a provider that supports them (e.g. CapSolver DataDomeSliderTask); skipping.');
      return false;
    }
    if (!challenge.sitekey) {
      this.emit('agent_log', '[ChallengeSolver] Could not extract sitekey; skipping solve.');
      return false;
    }

    let token: string | null = null;
    try {
      token = await this.solveToken(solver, challenge);
    } catch (e: any) {
      this.emit('agent_log', `[ChallengeSolver] Solver error: ${e?.message || e}`);
      return false;
    }
    if (!token) {
      this.emit('agent_log', '[ChallengeSolver] Solver returned no token.');
      return false;
    }
    this.emit('agent_log', '[ChallengeSolver] Received token; injecting into page.');

    await this.injectToken(page, challenge.type, token);
    const cleared = await this.waitForClear(page, 15000);
    this.emit('agent_log', `[ChallengeSolver] Post-injection: challenge ${cleared ? 'cleared' : 'still present'}.`);
    return cleared;
  }

  // ---- provider API (createTask / getTaskResult) ----

  private base(solver: AntiBotSolver): string {
    return solver.baseUrl || PROVIDER_BASE[solver.provider] || PROVIDER_BASE['2captcha']!;
  }

  private taskType(provider: string, challengeType: ChallengeType): string {
    const capsolver = provider === 'capsolver';
    switch (challengeType) {
      case 'turnstile':
        return capsolver ? 'AntiTurnstileTaskProxyLess' : 'TurnstileTaskProxyless';
      case 'recaptcha_v2':
        return capsolver ? 'ReCaptchaV2TaskProxyLess' : 'RecaptchaV2TaskProxyless';
      case 'hcaptcha':
        return capsolver ? 'HCaptchaTaskProxyLess' : 'HCaptchaTaskProxyless';
      default:
        return 'NoCaptchaTaskProxyless';
    }
  }

  private async solveToken(solver: AntiBotSolver, challenge: DetectedChallenge): Promise<string | null> {
    const base = this.base(solver);
    const type = this.taskType(solver.provider, challenge.type);

    const task: any = { type, websiteURL: challenge.pageUrl, websiteKey: challenge.sitekey };
    if (challenge.type === 'turnstile') {
      if (challenge.action) task.action = challenge.action;
      if (challenge.data) task.cData = challenge.data;
    }

    const createBody =
      solver.provider === 'capsolver'
        ? { clientKey: solver.apiKey, task }
        : { clientKey: solver.apiKey, task, softId: 0 };

    const createRes = await fetch(`${base}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    const created: any = await createRes.json();
    if (created.errorId) throw new Error(`createTask: ${created.errorCode || created.errorDescription || 'unknown'}`);
    const taskId = created.taskId;
    if (!taskId) throw new Error('createTask returned no taskId');

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`${base}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: solver.apiKey, taskId }),
      });
      const poll: any = await pollRes.json();
      if (poll.errorId) throw new Error(`getTaskResult: ${poll.errorCode || poll.errorDescription || 'unknown'}`);
      if (poll.status === 'ready') {
        const s = poll.solution || {};
        return s.token || s.gRecaptchaResponse || s.text || s.answer || null;
      }
    }
    throw new Error('solver timed out after 120s');
  }

  // ---- token injection ----

  private async injectToken(page: any, type: ChallengeType, token: string): Promise<void> {
    try {
      await page.evaluate(
        ({ type, token }: { type: ChallengeType; token: string }) => {
          const setVal = (sel: string) => {
            document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(sel).forEach((el) => {
              el.value = token;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
          };
          if (type === 'recaptcha_v2' || type === 'hcaptcha') {
            setVal('[name="g-recaptcha-response"]');
            setVal('#g-recaptcha-response');
          }
          if (type === 'hcaptcha') setVal('[name="h-captcha-response"]');
          if (type === 'turnstile') {
            setVal('[name="cf-turnstile-response"]');
            setVal('#cf-turnstile-response');
            setVal('input[name="cf-turnstile-response"]');
          }
          // Fire any registered client callback.
          try {
            const cfg = (window as any).___grecaptcha_cfg;
            if (cfg && cfg.clients) {
              Object.values(cfg.clients).forEach((client: any) => {
                const walk = (o: any, depth = 0) => {
                  if (!o || depth > 5) return;
                  Object.values(o).forEach((v: any) => {
                    if (v && typeof v.callback === 'function') { try { v.callback(token); } catch (e) {} }
                    else if (v && typeof v === 'object') walk(v, depth + 1);
                  });
                };
                walk(client);
              });
            }
          } catch (e) {}
          // Turnstile: some sites read the value on form submit.
          try {
            const form = document.querySelector('form');
            if (type === 'turnstile' && form && (form as HTMLFormElement).requestSubmit) {
              (form as HTMLFormElement).requestSubmit();
            }
          } catch (e) {}
        },
        { type, token },
      );
    } catch (e: any) {
      this.emit('agent_log', `[ChallengeSolver] Token injection failed: ${e?.message || e}`);
    }
  }

  private async waitForClear(page: any, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const c = await this.detect(page);
      if (c.type === 'none') return true;
    }
    return (await this.detect(page)).type === 'none';
  }
}
