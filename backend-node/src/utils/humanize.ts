/**
 * Phase 4 - human-like input. All best-effort: any failure falls back to the
 * plain Playwright action so a run is never blocked by humanisation itself.
 */

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

export const humanDelay = (min = 350, max = 1400) =>
  new Promise<void>((r) => setTimeout(r, randInt(min, max)));

/** Quadratic Bézier between two points, sampled into `steps` points. */
function bezier(p0: [number, number], p1: [number, number], p2: [number, number], steps: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

let lastPos: [number, number] | null = null;

/** Move the real mouse along a curved path to the centre of `locator`, then settle. */
export async function humanMoveToLocator(page: any, locator: any): Promise<void> {
  try {
    const box = await locator.boundingBox({ timeout: 3000 });
    if (!box) return;
    const target: [number, number] = [
      box.x + box.width * rand(0.3, 0.7),
      box.y + box.height * rand(0.3, 0.7),
    ];
    const start: [number, number] = lastPos || [rand(0, 300), rand(0, 300)];
    const ctrl: [number, number] = [
      (start[0] + target[0]) / 2 + rand(-120, 120),
      (start[1] + target[1]) / 2 + rand(-120, 120),
    ];
    const steps = randInt(18, 34);
    for (const [x, y] of bezier(start, ctrl, target, steps)) {
      await page.mouse.move(x, y);
      await new Promise((r) => setTimeout(r, rand(4, 14)));
    }
    lastPos = target;
    await new Promise((r) => setTimeout(r, rand(40, 160)));
  } catch { /* best-effort */ }
}

/** Type char-by-char with variable cadence and the occasional correction. */
export async function humanType(locator: any, text: string): Promise<void> {
  await locator.click({ timeout: 5000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, rand(120, 350)));
  for (const ch of String(text)) {
    if (Math.random() < 0.04) {
      const wrong = 'abcdefghijklmnopqrstuvwxyz'[randInt(0, 25)];
      await locator.type(wrong, { delay: rand(40, 110) }).catch(() => {});
      await new Promise((r) => setTimeout(r, rand(90, 240)));
      await locator.press('Backspace').catch(() => {});
      await new Promise((r) => setTimeout(r, rand(60, 160)));
    }
    await locator.type(ch, { delay: rand(45, 150) }).catch(() => {});
  }
}

/** Session warm-up: settle, dismiss common cookie/consent banners, small scroll. */
export async function warmUp(page: any, emitLog?: (t: string, m: string) => void): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, rand(600, 1600)));

    const consentText = /accept all|accept cookies|allow all|agree|got it|i understand|continue/i;
    const buttons = page.locator('button, [role="button"], a');
    const count = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < count; i++) {
      const b = buttons.nth(i);
      const t = (await b.innerText({ timeout: 500 }).catch(() => '') || '').trim();
      if (t && consentText.test(t) && t.length < 40) {
        await b.click({ timeout: 2000 }).catch(() => {});
        emitLog?.('agent_log', `[Humanize] Dismissed consent banner: "${t}"`);
        await new Promise((r) => setTimeout(r, rand(400, 900)));
        break;
      }
    }

    await page.mouse.wheel(0, rand(200, 600)).catch(() => {});
    await new Promise((r) => setTimeout(r, rand(400, 1100)));
    await page.mouse.wheel(0, -rand(100, 300)).catch(() => {});
  } catch { /* best-effort */ }
}
