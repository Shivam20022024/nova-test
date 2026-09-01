/**
 * Type surface for `reportTransform.js`, carried over verbatim from the
 * previous frontend. It folds a raw ExecutionLog (from
 * `GET /api/v1/executions/:id`) together with the AI report JSON fetched from
 * storage into the single shape every report view renders from.
 *
 * The nested sections are intentionally permissive: the runtime file builds
 * them from loosely-shaped execution telemetry, and over-tightening them here
 * would mean lying about what the backend actually guarantees.
 */
import type { ExecutionDetail } from '../../lib/types'

export type ReportSection = Record<string, any>

export type NormalizedReport = {
  /** Run identity, target, browser, timings, Jira linkage. */
  metadata: ReportSection
  /** Counts and pass/fail rollups across scenarios and steps. */
  summary: ReportSection
  /** Scorecard-style derived quality figures (functionalScore, a11yScore, secScore, stabilityScore). */
  quality: ReportSection
  /** One row per scenario: name, status, risk, healed, steps, events. Feeds the scenarios table. */
  tests: ReportSection[]
  /** Ordered execution events for the timeline view. */
  timeline: ReportSection[]
  /** Agent/pipeline milestones, distinct from the step timeline. */
  aiTimeline: ReportSection[]
  /** One row per failed scenario: root cause, category, evidence, suggested fix. */
  failures: ReportSection[]
  /** One row per self-healing attempt (success and failure both included). */
  healing: ReportSection[]
  /** Release recommendation and its supporting reasoning. */
  releaseDecision: ReportSection
  accessibility: ReportSection
  security: ReportSection
  /** Screenshots, videos, visual-regression output and captured requests. */
  evidence: ReportSection
  /** LLM-authored narrative, observations and recommendations. */
  ai: ReportSection
  /** Raw logs, step logs, trace and plan data, plus the untouched execution. */
  technical: ReportSection
}

/**
 * Returns `null` when `execution` is missing, so callers must null-check.
 * `aiReport` is the parsed report JSON; pass `null` when it could not be
 * fetched and the transform will fall back to execution telemetry alone.
 */
export function normalizeExecutionReport(
  execution: ExecutionDetail | null | undefined,
  aiReport?: Record<string, any> | null,
): NormalizedReport | null;
