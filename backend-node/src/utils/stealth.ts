import * as crypto from 'crypto';

/**
 * Phase 2b / 2c - real-browser hygiene without a third-party dependency.
 *
 * `pickFingerprint()` returns a set of values that all agree with each other
 * (UA <-> Client Hints <-> platform <-> WebGL <-> screen <-> locale/timezone).
 * Anti-bot systems score *inconsistency*, so a coherent profile beats a
 * partially-spoofed one. The pool is small and rotated by a stable seed so a
 * given target keeps the same identity within its clearance window.
 *
 * `buildStealthInitScript()` returns a single init script (runs before any page
 * script) that patches the well-known automation tells. This is a hand-rolled
 * subset of what puppeteer-extra-plugin-stealth does; swap in that library or
 * `patchright` later for the deeper CDP-leak fixes.
 */

export interface Fingerprint {
  userAgent: string;
  platform: 'Win32' | 'MacIntel' | 'Linux x86_64';
  uaFullVersionList: { brand: string; version: string }[];
  uaPlatform: 'Windows' | 'macOS' | 'Linux';
  uaPlatformVersion: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  screen: { width: number; height: number };
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  languages: string[];
}

// Keep versions current-ish; the exact Chrome build the runner ships may differ,
// but a coherent recent desktop profile passes heuristic checks. Update yearly.
const CHROME_MAJOR = '124';
const CHROME_FULL = '124.0.6367.119';

const POOL: Fingerprint[] = [
  {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    uaFullVersionList: [
      { brand: 'Chromium', version: CHROME_FULL },
      { brand: 'Google Chrome', version: CHROME_FULL },
      { brand: 'Not-A.Brand', version: '99.0.0.0' },
    ],
    uaPlatform: 'Windows',
    uaPlatformVersion: '15.0.0',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1536, height: 864 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    languages: ['en-US', 'en'],
  },
  {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    uaFullVersionList: [
      { brand: 'Chromium', version: CHROME_FULL },
      { brand: 'Google Chrome', version: CHROME_FULL },
      { brand: 'Not-A.Brand', version: '99.0.0.0' },
    ],
    uaPlatform: 'Windows',
    uaPlatformVersion: '10.0.0',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    screen: { width: 1366, height: 768 },
    viewport: { width: 1366, height: 657 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    languages: ['en-US', 'en'],
  },
  {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    platform: 'MacIntel',
    uaFullVersionList: [
      { brand: 'Chromium', version: CHROME_FULL },
      { brand: 'Google Chrome', version: CHROME_FULL },
      { brand: 'Not-A.Brand', version: '99.0.0.0' },
    ],
    uaPlatform: 'macOS',
    uaPlatformVersion: '14.4.1',
    hardwareConcurrency: 10,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)',
    screen: { width: 1728, height: 1117 },
    viewport: { width: 1728, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    languages: ['en-US', 'en'],
  },
];

/** Deterministic pick so a target keeps a stable identity across retries/reuse. */
export function pickFingerprint(seed?: string): Fingerprint {
  if (!seed) return POOL[Math.floor(Math.random() * POOL.length)]!;
  const n = parseInt(crypto.createHash('md5').update(seed).digest('hex').slice(0, 8), 16);
  return POOL[n % POOL.length]!;
}

/** Optionally align the fingerprint's timezone/locale with the proxy country. */
export function alignFingerprintToGeo(fp: Fingerprint, geo?: string): Fingerprint {
  if (!geo) return fp;
  const g = geo.toLowerCase();
  const map: Record<string, { tz: string; locale: string; langs: string[] }> = {
    us: { tz: 'America/New_York', locale: 'en-US', langs: ['en-US', 'en'] },
    gb: { tz: 'Europe/London', locale: 'en-GB', langs: ['en-GB', 'en'] },
    uk: { tz: 'Europe/London', locale: 'en-GB', langs: ['en-GB', 'en'] },
    de: { tz: 'Europe/Berlin', locale: 'de-DE', langs: ['de-DE', 'de', 'en'] },
    fr: { tz: 'Europe/Paris', locale: 'fr-FR', langs: ['fr-FR', 'fr', 'en'] },
    in: { tz: 'Asia/Kolkata', locale: 'en-IN', langs: ['en-IN', 'en'] },
    au: { tz: 'Australia/Sydney', locale: 'en-AU', langs: ['en-AU', 'en'] },
    ca: { tz: 'America/Toronto', locale: 'en-CA', langs: ['en-CA', 'en', 'fr'] },
    br: { tz: 'America/Sao_Paulo', locale: 'pt-BR', langs: ['pt-BR', 'pt', 'en'] },
    sg: { tz: 'Asia/Singapore', locale: 'en-SG', langs: ['en-SG', 'en'] },
  };
  const m = map[g];
  if (!m) return fp;
  return { ...fp, timezoneId: m.tz, locale: m.locale, languages: m.langs };
}

/**
 * Playwright newContext() options fragment for a fingerprint.
 * (WebGL / hardware / screen are applied via the init script below, because
 * Playwright's context options don't cover them.)
 */
export function fingerprintContextOptions(fp: Fingerprint) {
  return {
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    viewport: fp.viewport,
    screen: fp.screen,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    // Client Hints high-entropy values, kept consistent with the UA string.
    extraHTTPHeaders: {
      'Accept-Language': fp.languages.map((l, i) => (i === 0 ? l : `${l};q=${(0.9 - i * 0.1).toFixed(1)}`)).join(','),
    },
  };
}

/** Single init script: automation-tell patches + fingerprint coherence. */
export function buildStealthInitScript(fp: Fingerprint): string {
  // Build the in-page constant object first, then serialise once.
  const FP = {
    platform: fp.platform,
    uaPlatform: fp.uaPlatform,
    uaPlatformVersion: fp.uaPlatformVersion,
    uaFullVersionList: fp.uaFullVersionList,
    chromeMajor: CHROME_MAJOR,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    languages: fp.languages,
    screen: fp.screen,
  };
  return `(() => {
  const FP = ${JSON.stringify(FP)};
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
  };

  // 1. webdriver
  def(Navigator.prototype, 'webdriver', () => false);

  // 2. languages / hardware / platform / memory
  def(Navigator.prototype, 'languages', () => FP.languages);
  def(Navigator.prototype, 'hardwareConcurrency', () => FP.hardwareConcurrency);
  def(Navigator.prototype, 'deviceMemory', () => FP.deviceMemory);
  def(Navigator.prototype, 'platform', () => FP.platform);

  // 3. userAgentData (Client Hints)
  try {
    const uad = {
      brands: FP.uaFullVersionList.filter(b => !/Not.?A.?Brand/i.test(b.brand)).map(b => ({ brand: b.brand, version: FP.chromeMajor })),
      mobile: false,
      platform: FP.uaPlatform,
      getHighEntropyValues: (hints) => Promise.resolve(Object.assign({
        architecture: 'x86', bitness: '64', model: '',
        platform: FP.uaPlatform, platformVersion: FP.uaPlatformVersion,
        uaFullVersion: FP.uaFullVersionList.find(b => /Chrome/i.test(b.brand))?.version || (FP.chromeMajor + '.0.0.0'),
        fullVersionList: FP.uaFullVersionList,
      }, {})),
      toJSON: function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
    };
    def(Navigator.prototype, 'userAgentData', () => uad);
  } catch (e) {}

  // 4. chrome runtime object (present in real Chrome, absent in headless)
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
    window.chrome.csi = window.chrome.csi || function () { return { onloadT: Date.now(), startE: Date.now(), tran: 15 }; };
    window.chrome.loadTimes = window.chrome.loadTimes || function () { return {}; };
  } catch (e) {}

  // 5. permissions.query - headless returns 'denied' for notifications while Notification.permission is 'default'
  try {
    const orig = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : orig(params);
  } catch (e) {}

  // 6. plugins / mimeTypes - non-empty like a real Chrome
  try {
    const mkPlugin = (name, filename, desc) => {
      const p = Object.create(Plugin.prototype);
      def(p, 'name', () => name); def(p, 'filename', () => filename); def(p, 'description', () => desc); def(p, 'length', () => 1);
      return p;
    };
    const plugins = [
      mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mkPlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mkPlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const arr = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => { arr[i] = p; });
    def(arr, 'length', () => plugins.length);
    def(Navigator.prototype, 'plugins', () => arr);
  } catch (e) {}

  // 7. WebGL vendor / renderer
  try {
    const patch = (proto) => {
      const gp = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return FP.webglVendor;   // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return FP.webglRenderer;  // UNMASKED_RENDERER_WEBGL
        return gp.call(this, p);
      };
    };
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 8. screen coherence
  try {
    def(window.screen, 'width', () => FP.screen.width);
    def(window.screen, 'height', () => FP.screen.height);
    def(window.screen, 'availWidth', () => FP.screen.width);
    def(window.screen, 'availHeight', () => FP.screen.height - 40);
    def(window, 'devicePixelRatio', () => 1);
  } catch (e) {}

  // 9. iframe.contentWindow.self / outerdimensions
  try {
    if (window.outerWidth === 0) window.outerWidth = window.innerWidth;
    if (window.outerHeight === 0) window.outerHeight = window.innerHeight + 85;
  } catch (e) {}

  // 10. Function.prototype.toString - hide our own patched natives
  try {
    const nativeToString = Function.prototype.toString;
    const patched = new WeakSet();
    [Navigator.prototype.permissions && window.navigator.permissions.query].forEach(f => { if (f) patched.add(f); });
    Function.prototype.toString = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        if (patched.has(thisArg)) return 'function () { [native code] }';
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch (e) {}
})();`;
}
