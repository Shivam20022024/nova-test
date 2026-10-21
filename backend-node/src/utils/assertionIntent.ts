/**
 * Fast, deterministic checks for assertions whose natural-language intent QUOTES the text to look for,
 * e.g.  Verify the heading "My Journey" is visible.
 *
 * Why: when the guessed selector for such a check doesn't bind, the runner used to retry 3 times with
 * growing timeouts and then ask the LLM to regenerate a selector - 30-60 seconds per check, and the
 * outcome was "skipped" (i.e. unverified). The quoted text itself is the ground truth: look for it
 * directly in what the user can see.
 *   - all quoted text present  -> the check is satisfied (no AI call, no long retries)
 *   - quoted text still absent after a short grace period -> a real, immediate failure with a precise reason
 */

/**
 * Quoted phrases in the intent. Address-bar paths and URLs are skipped (they are not page text), and a phrase
 * with a placeholder such as "Day <number> · Natural cycle" is kept: it is matched as a pattern.
 */
export function extractIntentPhrases(intent: string): string[] {
  if (!intent) return [];
  const out: string[] = [];
  for (const m of intent.matchAll(/["“”]([^"“”]{3,90})["“”]/g)) {
    const p = (m[1] ?? '').trim();
    if (p.length < 3) continue;
    if (p.startsWith('/') || /^https?:\/\//i.test(p)) continue;
    out.push(p);
  }
  return Array.from(new Set(out));
}

/** "... are no longer visible", "... is not shown", "... disappears" - the quoted text must be ABSENT. */
export function isNegatedIntent(intent: string): boolean {
  // Judge the wording AROUND the quoted text only (a quoted phrase such as "This is not ..." is page content).
  const wording = (intent || '').replace(/["“”][^"“”]*["“”]/g, ' ');
  return /\b(no longer|not (be )?(visible|shown|displayed|present|listed|available)|isn't|aren't|is not|are not|disappear|is gone|are gone|removed|hidden|absent)\b/i.test(wording);
}

/** Turns "Day <number> · Natural cycle" into a regular expression; plain text is matched literally. */
function phraseToRegex(phrase: string): RegExp | null {
  if (!/<[^>]+>/.test(phrase)) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = phrase.split(/<[^>]+>/).map(esc);
  const holes = phrase.match(/<[^>]+>/g) || [];
  let src = '';
  parts.forEach((part, i) => {
    src += part.replace(/\s+/g, '\\s+');
    if (i < holes.length) src += /number|count|day|days|n\b|digits?/i.test(holes[i] ?? '') ? '\\d+' : '.+?';
  });
  try { return new RegExp(src, 'i'); } catch { return null; }
}

/** "If a Cloudflare box is shown..., wait until it says 'Success!'" - may legitimately not apply. */
export function isConditionalIntent(intent: string): boolean {
  return /^\s*(if|when|whenever|where|optionally)\b/i.test(intent || '');
}

export interface PhraseCheck {
  found: string[];
  missing: string[];
}

/** For negated intents: waits (briefly) until none of the phrases is on the page any more. */
export async function checkPhrasesAbsent(page: any, phrases: string[], graceMs = 4000): Promise<PhraseCheck> {
  const deadline = Date.now() + graceMs;
  let res: PhraseCheck = { found: [], missing: phrases };
  do {
    // checkIntentPhrases polls only until all phrases are FOUND; a single pass (graceMs=0) tells us what is present now.
    res = await checkIntentPhrases(page, phrases, 0);
    if (res.found.length === 0) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return res;
}

/** Polls the live page's VISIBLE text (plus placeholders / aria-labels) for each phrase. */
export async function checkIntentPhrases(page: any, phrases: string[], graceMs = 3500): Promise<PhraseCheck> {
  const deadline = Date.now() + graceMs;
  let last: boolean[] = phrases.map(() => false);
  do {
    last = await page
      .evaluate((ps: string[]) => {
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
        const parts: string[] = [norm(document.body?.innerText || '')];
        document.querySelectorAll('[placeholder],[aria-label],[title],[alt]').forEach((el) => {
          for (const a of ['placeholder', 'aria-label', 'title', 'alt']) {
            const v = el.getAttribute(a);
            if (v) parts.push(norm(v));
          }
        });
        const hay = parts.join(' | ');
        return ps.map((p) => {
          const m = p.match(/^__RE__(.*)__FLAGS__(.*)$/s);
          if (m) { try { return new RegExp(m[1] as string, m[2] as string).test(hay); } catch { return false; } }
          return hay.includes(norm(p));
        });
      }, phrases.map((p) => { const r = phraseToRegex(p); return r ? `__RE__${r.source}__FLAGS__${r.flags}` : p; }))
      .catch(() => phrases.map(() => false));
    if (last.every(Boolean)) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return {
    found: phrases.filter((_, i) => last[i]),
    missing: phrases.filter((_, i) => !last[i]),
  };
}
