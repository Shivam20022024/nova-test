/**
 * Execution options the backend actually honours.
 *
 * Browser ids are passed straight through to the worker, which maps them onto
 * Playwright engines (chromium/firefox/webkit, plus the msedge channel).
 * Devices go into the run payload's `devices` array.
 */
export const BROWSERS = [
  { id: 'chromium', label: 'Chromium' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'webkit', label: 'Safari (WebKit)' },
  { id: 'edge', label: 'Edge' },
] as const

export const DEVICES = [
  { id: 'Desktop', label: 'Desktop' },
  { id: 'iPhone 13', label: 'iOS' },
  { id: 'Pixel 5', label: 'Android' },
] as const

/** Depth values accepted by the autonomous pipeline. */
export const TEST_DEPTHS = ['Smoke Test (Fast)', 'Regression Test', 'Full Autonomous'] as const

/**
 * Agent capabilities the autonomous runner can toggle. These are sent as the
 * `features` object and read by the worker and execution agent.
 */
export const AUTONOMOUS_FEATURES = [
  { key: 'aiEyes', label: 'AI Eyes (vision)', description: 'Screenshot analysis for visual defects' },
  { key: 'video', label: 'Video capture', description: 'Record the full run for replay' },
  { key: 'healing', label: 'Self-healing', description: 'Repair broken selectors mid-run' },
  { key: 'accessibility', label: 'Accessibility audit', description: 'Run WCAG checks via axe' },
  { key: 'responsive', label: 'Responsive check', description: 'Exercise mobile and tablet layouts' },
  { key: 'api', label: 'Network capture', description: 'Intercept and validate API traffic' },
  { key: 'security', label: 'Security sanity', description: 'Mixed-content and insecure-form checks' },
] as const
