/**
 * Type surface for `reportMetrics.js`, which is carried over verbatim from the
 * previous frontend. The runtime file is deliberately untouched JavaScript —
 * this declaration only describes its boundary so TypeScript callers are typed.
 */

/** Milliseconds -> a short human string, e.g. `"1m 12s"`. */
export function formatDuration(ms: number | null | undefined): string;

/** ISO string or Date-like -> localised date + time. */
export function formatTimestamp(isoOrDateStr: string | Date | null | undefined): string;

/** ISO string or Date-like -> time of day only. */
export function formatTimeOnly(isoOrDateStr: string | Date | null | undefined): string;

export type FailureCategory =
  | 'APPLICATION_ERROR'
  | 'SELECTOR_ERROR'
  | 'SELECTOR_DRIFT'
  | 'PAGE_STATE_ERROR'
  | 'TIMING_ERROR'
  | 'NAVIGATION_ERROR'
  | 'TEST_SCRIPT_ERROR'
  | 'INFRASTRUCTURE_ERROR'
  | 'ANTI_BOT_BLOCK'
  | 'UNKNOWN'

export const FAILURE_CATEGORIES: readonly FailureCategory[];

export type FailureClassification = {
  code: FailureCategory
  severity: string
  isApplicationDefect: boolean
  likelyCause: string
  developerAction: string
  expected: string | null
  actual: string | null
  /** Legacy field retained for older consumers. */
  type: string
  [key: string]: unknown
}

/** Classifies a step failure from its error text, selector and surrounding context. */
export function classifyFailure(
  errorText: string | null | undefined,
  selector?: string | null,
  context?: Record<string, unknown>,
): FailureClassification;

/** Thin alias of {@link classifyFailure}, kept for call-site compatibility. */
export function classifyIssue(
  err: string | null | undefined,
  tgt?: string | null,
  context?: Record<string, unknown>,
): FailureClassification;

/** Maps a scenario name onto a plain-language business-impact sentence. */
export function getBusinessImpact(scenarioName: string | null | undefined): string;
