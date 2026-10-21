/**
 * Safety guard: controls whose label says they are irreversible / account-destroying are
 * never clicked unless the run explicitly allows it. This protects real customer accounts from
 * vague prompts such as "test the settings page" or "click everything".
 *
 * Generic by design - nothing here is specific to one website:
 *   - a built-in list of universally destructive wording (delete account, reset data, ...);
 *   - extra patterns per deployment via env  PROTECTED_ACTION_PATTERNS  (comma or newline separated
 *     regular-expression sources, case-insensitive), e.g. "end this cycle,purchase .*,send my story";
 *   - extra patterns per run via  job.data.protectedActions  (string[]);
 *   - opt-out for tests that intentionally exercise destructive flows on a throw-away account:
 *     job.data.allowProtectedActions === true  or env  ALLOW_PROTECTED_ACTIONS=1.
 */

const BUILT_IN: RegExp[] = [
  /\b(delete|close|deactivate|terminate|remove)\s+(my\s+|your\s+|the\s+)?(account|profile)\b/i,
  /\b(reset|erase|wipe|purge|delete)\s+(all\s+)?(my\s+|your\s+|the\s+)?(data|history|everything|workspace)\b/i,
  /\bdelete\s+(all|everything)\b/i,
  /\b(sign|log)\s*out\s+(everywhere|of all|all (other )?(devices|sessions))\b/i,
  /\b(sign|log)\s*out\s+all\b/i,
];

function parseList(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(src => {
      try { return new RegExp(src, 'i'); } catch { return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    });
}

export interface ProtectedActionOptions {
  protectedActions?: string[];
  allowProtectedActions?: boolean;
}

/** Returns the human-readable reason if `label` is protected, else null. */
export function checkProtectedAction(label: string, opts: ProtectedActionOptions = {}): string | null {
  if (!label) return null;
  if (opts.allowProtectedActions === true || process.env.ALLOW_PROTECTED_ACTIONS === '1') return null;
  const perRun = (opts.protectedActions || []).flatMap(p => parseList(p));
  const all = [...BUILT_IN, ...parseList(process.env.PROTECTED_ACTION_PATTERNS), ...perRun];
  const hit = all.find(re => re.test(label));
  return hit ? `matches protected pattern ${hit}` : null;
}
