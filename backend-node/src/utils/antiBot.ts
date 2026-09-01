import * as crypto from 'crypto';

/**
 * Anti-bot configuration for authorized testing of a customer's own site.
 *
 * Philosophy (in order of preference; each execution falls through the ladder):
 *   allowlist / bypass header  ->  real-browser hygiene (stealth + fingerprint)
 *   ->  residential proxy  ->  human-like behaviour  ->  CAPTCHA solver
 *   ->  managed stealth browser  ->  honest BLOCKED
 *
 * Nothing here is enabled by default: `mode` defaults to 'basic', which is the
 * pre-existing behaviour (headless + navigator.webdriver shim only).
 *
 * Precedence: per-execution `job.data.antiBot` overrides environment defaults.
 */
export type AntiBotMode = 'off' | 'basic' | 'stealth' | 'managed';

export interface AntiBotProxy {
  server: string;
  username?: string;
  password?: string;
  /** ISO country hint for providers that take it in the username (e.g. "us"). */
  geo?: string;
  /** Keep the same exit IP for the whole execution (recommended). */
  sticky?: boolean;
}

export interface AntiBotSolver {
  /** 2captcha-compatible HTTP API: 2captcha | capsolver | capmonster | anticaptcha */
  provider: string;
  apiKey: string;
  /** Custom base URL if self-hosting / using a compatible gateway. */
  baseUrl?: string;
}

export interface AntiBotConfig {
  mode: AntiBotMode;
  /** 1a - secret header the customer's WAF/CDN is configured to let past bot management. */
  bypassHeader?: { name: string; value: string } | undefined;
  /** 1b - persist + reuse challenge-clearance cookies for this target. */
  reuseClearance: boolean;
  /** 2a - run a headful browser (needs a display / Xvfb on Linux). Implied by mode 'stealth'. */
  headful: boolean;
  /** 2b/2c - inject stealth patches + a coherent browser fingerprint. Implied by mode 'stealth'. */
  stealth: boolean;
  /** 4 - human-like mouse paths, typing cadence, warm-up. Implied by mode 'stealth'. */
  humanize: boolean;
  /** 3 - residential/ISP proxy. */
  proxy?: AntiBotProxy | undefined;
  /** 5 - CAPTCHA / challenge solver, tried only when a hard block is detected. */
  solver?: AntiBotSolver | undefined;
  /** 6 - CDP endpoint of a managed stealth browser (Browserbase / Steel / Browserless / ...). Required for mode 'managed'. */
  managedWsEndpoint?: string | undefined;
}

const VALID_MODES: AntiBotMode[] = ['off', 'basic', 'stealth', 'managed'];

function bool(v: any, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

function pickHeader(raw: any): { name: string; value: string } | undefined {
  const h = raw && typeof raw === 'object' ? raw
    : (process.env.ANTIBOT_BYPASS_HEADER_NAME && process.env.ANTIBOT_BYPASS_HEADER_VALUE
        ? { name: process.env.ANTIBOT_BYPASS_HEADER_NAME, value: process.env.ANTIBOT_BYPASS_HEADER_VALUE }
        : undefined);
  if (!h || !h.name || !h.value) return undefined;
  return { name: String(h.name), value: String(h.value) };
}

function pickProxy(raw: any): AntiBotProxy | undefined {
  const p = raw && typeof raw === 'object' ? raw
    : (process.env.ANTIBOT_PROXY_SERVER
        ? {
            server: process.env.ANTIBOT_PROXY_SERVER,
            username: process.env.ANTIBOT_PROXY_USERNAME,
            password: process.env.ANTIBOT_PROXY_PASSWORD,
            geo: process.env.ANTIBOT_PROXY_GEO,
            sticky: process.env.ANTIBOT_PROXY_STICKY,
          }
        : undefined);
  if (!p || !p.server) return undefined;
  const proxy: AntiBotProxy = { server: String(p.server) };
  if (p.username) proxy.username = String(p.username);
  if (p.password) proxy.password = String(p.password);
  if (p.geo) proxy.geo = String(p.geo).toLowerCase();
  proxy.sticky = bool(p.sticky, true);
  return proxy;
}

function pickSolver(raw: any): AntiBotSolver | undefined {
  const s = raw && typeof raw === 'object' ? raw
    : (process.env.ANTIBOT_SOLVER_PROVIDER && process.env.ANTIBOT_SOLVER_API_KEY
        ? { provider: process.env.ANTIBOT_SOLVER_PROVIDER, apiKey: process.env.ANTIBOT_SOLVER_API_KEY, baseUrl: process.env.ANTIBOT_SOLVER_BASE_URL }
        : undefined);
  if (!s || !s.provider || !s.apiKey) return undefined;
  const solver: AntiBotSolver = { provider: String(s.provider).toLowerCase(), apiKey: String(s.apiKey) };
  if (s.baseUrl) solver.baseUrl = String(s.baseUrl);
  return solver;
}

export function resolveAntiBotConfig(raw: any): AntiBotConfig {
  const j = raw && typeof raw === 'object' ? raw : {};
  const requested = String(j.mode || process.env.ANTIBOT_MODE || 'basic').toLowerCase();
  const mode: AntiBotMode = (VALID_MODES as string[]).includes(requested) ? (requested as AntiBotMode) : 'basic';

  const isStealthy = mode === 'stealth' || mode === 'managed';

  const managedWs = j.managedWsEndpoint || process.env.ANTIBOT_MANAGED_WS_ENDPOINT || undefined;

  return {
    mode,
    bypassHeader: pickHeader(j.bypassHeader),
    reuseClearance: mode !== 'off' && bool(j.reuseClearance, true),
    headful: bool(j.headful, isStealthy || bool(process.env.ANTIBOT_HEADFUL, false)),
    stealth: bool(j.stealth, isStealthy || bool(process.env.ANTIBOT_STEALTH, false)),
    humanize: bool(j.humanize, isStealthy || bool(process.env.ANTIBOT_HUMANIZE, false)),
    proxy: pickProxy(j.proxy),
    solver: pickSolver(j.solver),
    managedWsEndpoint: managedWs ? String(managedWs) : undefined,
  };
}

/**
 * Cache key for a target's persisted challenge-clearance session. Scoped by
 * suite (tenant) + origin so a cleared session is not shared across unrelated
 * projects. Returns null when the target URL is unusable.
 */
export function clearanceCacheKey(scopeId: string | undefined | null, targetUrl: string): string | null {
  try {
    const origin = new URL(targetUrl).origin;
    const h = crypto.createHash('md5').update(`${scopeId || 'global'}:${origin}`).digest('hex');
    return `antibot_clearance:${h}`;
  } catch {
    return null;
  }
}

/**
 * Residential-proxy providers encode "give me a sticky session" and "give me an
 * exit IP in country X" inside the *username*, with provider-specific tokens.
 * We can't know every provider, so we use the two most common conventions
 * (Bright Data / Oxylabs / IPRoyal / SOAX style) and make it a no-op when the
 * username already looks templated.
 */
export function buildProxyForExecution(proxy: AntiBotProxy | undefined, executionId: string): { server: string; username?: string; password?: string } | undefined {
  if (!proxy) return undefined;
  const out: { server: string; username?: string; password?: string } = { server: proxy.server };
  if (proxy.password) out.password = proxy.password;
  if (!proxy.username) return out;

  let user = proxy.username;
  const alreadyTemplated = /(session|sessid|sid)[-_]/i.test(user) || user.includes('{');
  if (!alreadyTemplated) {
    const sess = executionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || Date.now().toString(36);
    if (proxy.geo) user += `-country-${proxy.geo}`;
    if (proxy.sticky) user += `-session-${sess}`;
  }
  out.username = user;
  return out;
}
