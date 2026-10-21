/**
 * Deterministic selector fallbacks, tried BEFORE asking the LLM to regenerate a selector.
 *
 * Why: scripts are generated from scenario text without seeing the page, so the model often
 * guesses attributes that don't exist (e.g. `input[name="email"]` on a field that only has
 * type="email"). The LLM repair step then fails some of the time, which made whole batches
 * flaky. Here we derive the intent (email / password / a button label ...) from the failed
 * selector and probe the LIVE page for obvious real matches. A candidate is only accepted if
 * it resolves to at least one VISIBLE element - nothing is invented.
 */

type Resolver = (page: any, sel: string, all?: boolean) => any;

const GENERIC_WORDS = new Set([
  'input', 'button', 'text', 'textbox', 'field', 'form', 'the', 'a', 'an', 'submit', 'link', 'tab', 'role',
]);

const ATTRIBUTE_VALUE_RE = /(?:name|id|placeholder|aria-label|data-testid|autocomplete|type)\s*[*^$~|]?=\s*["']([^"']+)["']/gi;
const HASH_ID_RE = /#([A-Za-z][\w-]*)/g;
const REGEX_LITERAL_RE = /\/([^\/]{2,40})\/[a-z]*/g;
const NAME_PROP_RE = /name:\s*['"]([^'"]+)['"]/gi;

function intentWords(failedSel: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const w = raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    if (w && !GENERIC_WORDS.has(w)) found.push(w);
  };
  for (const m of failedSel.matchAll(ATTRIBUTE_VALUE_RE)) push(m[1] ?? '');
  for (const m of failedSel.matchAll(HASH_ID_RE)) push(m[1] ?? '');
  for (const m of failedSel.matchAll(NAME_PROP_RE)) push(m[1] ?? '');
  for (const m of failedSel.matchAll(REGEX_LITERAL_RE)) push((m[1] ?? '').replace(/\\/g, ''));
  return Array.from(new Set(found));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fieldCandidates(word: string): string[] {
  const re = `/${escapeRe(word)}/i`;
  const out: string[] = [];
  if (/e-?mail/.test(word)) out.push('input[type="email"]');
  if (/pass(word|code)?/.test(word)) out.push('input[type="password"]');
  if (/search/.test(word)) out.push('input[type="search"]');
  if (/(phone|tel|mobile)/.test(word)) out.push('input[type="tel"]');
  out.push(
    `getByLabel(${re})`,
    `getByPlaceholder(${re})`,
    `getByRole('textbox', { name: ${re} })`,
    `input[autocomplete*="${word}" i]`,
    `input[id*="${word}" i]`,
    `input[name*="${word}" i]`,
  );
  return out;
}

function clickCandidates(word: string): string[] {
  const re = `/${escapeRe(word)}/i`;
  return [
    `getByRole('button', { name: ${re} })`,
    `getByRole('link', { name: ${re} })`,
    `getByRole('tab', { name: ${re} })`,
    `getByRole('menuitem', { name: ${re} })`,
    `getByText(${re})`,
  ];
}

/**
 * Returns a selector that really matches a visible element on the current page, or null if
 * none of the deterministic candidates do (the caller then falls back to the LLM repair).
 */
export async function findDeterministicFallback(
  page: any,
  failedSel: string,
  actionType: string,
  resolve: Resolver,
): Promise<string | null> {
  const isField = ['fill', 'select', 'check'].includes(actionType);
  const isClick = actionType === 'click' || actionType === 'hover';
  if (!isField && !isClick) return null;

  const tryCandidates = async (candidates: string[]): Promise<string | null> => {
    for (const cand of candidates) {
      try {
        const matches = resolve(page, cand, true);
        if (!matches) continue;
        if ((await matches.count()) < 1) continue;
        if (await matches.first().isVisible().catch(() => false)) return cand;
      } catch {
        /* bad candidate - try the next one */
      }
    }
    return null;
  };

  for (const word of intentWords(failedSel)) {
    const hit = await tryCandidates(isField ? fieldCandidates(word) : clickCandidates(word));
    if (hit) return hit;
  }

  // A dropdown is often described by its VISIBLE value (e.g. "—", "Select...", "9"), which is not its
  // accessible name, so a name-based selector misses it. If the step is a "select", fall back to the
  // custom dropdown that is actually on screen - preferring one inside an open dialog.
  if (actionType === 'select') {
    return await tryCandidates([
      '[role="dialog"] [role="combobox"]',
      '[aria-modal="true"] [role="combobox"]',
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
    ]);
  }
  return null;
}
