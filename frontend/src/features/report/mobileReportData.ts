import type {
  MobileApplication,
  MobileDevice,
  MobileEvidenceItem,
  MobileExecution,
  MobileHealingRecord,
  MobileStepResult,
  MobileTest,
} from '../../lib/types'

/** Healing statuses that count as "the fix worked" for the recovery-rate
 *  metric — mirrors the bucket the AutoHeal page collapses onto (see
 *  frontend/src/pages/app/healing/HealingPage.tsx's mobileBucket). */
const HEALING_SUCCESS_STATUSES = new Set(['APPROVED', 'VALIDATED', 'APPLIED'])

export type MobileQualityScorecard = {
  stepPassRate: number
  /** null when no healing was attempted — there's nothing to score. */
  healingRecoveryRate: number | null
  evidenceCoverage: number
}

/**
 * Three honest, telemetry-derived metrics — the mobile equivalent of the web
 * report's four-part quality scorecard (Functional/Accessibility/Security/
 * Stability). Mobile genuinely has no accessibility/security checks, so this
 * reports three real numbers instead of padding to four with something
 * invented.
 */
export function mobileQualityScorecard({
  steps,
  healing,
  evidence,
}: {
  steps: MobileStepResult[]
  healing: MobileHealingRecord[]
  evidence: MobileEvidenceItem[]
}): MobileQualityScorecard {
  const total = steps.length
  const passed = steps.filter((s) => s.status === 'PASSED' || s.status === 'HEALED').length
  const stepPassRate = total === 0 ? 0 : Math.round((passed / total) * 100)

  const healingRecoveryRate =
    healing.length === 0
      ? null
      : Math.round((healing.filter((h) => HEALING_SUCCESS_STATUSES.has(h.status)).length / healing.length) * 100)

  const stepsWithScreenshot = new Set(
    evidence.filter((e) => e.artifact_type === 'SCREENSHOT' && e.step_index != null).map((e) => e.step_index),
  )
  const evidenceCoverage = total === 0 ? 0 : Math.round((stepsWithScreenshot.size / total) * 100)

  return { stepPassRate, healingRecoveryRate, evidenceCoverage }
}

/**
 * Deterministic executive summary — no LLM call, built entirely from
 * telemetry the engine already recorded. Same role as reportTransform.js's
 * buildDeterministicSummary fallback for web: a report must never show up
 * with an empty "what happened" section just because there's no AI-written
 * narrative for this run.
 */
export function buildMobileExecutiveSummary({
  execution,
  test,
  application,
  device,
  steps,
  healing,
}: {
  execution: MobileExecution
  test: MobileTest | null
  application?: MobileApplication | null
  device?: MobileDevice | null
  steps: MobileStepResult[]
  healing: MobileHealingRecord[]
}): string {
  const testName = test?.name ?? `Execution #${execution.id}`
  const appLabel = application?.package_name ?? 'the target application'
  const deviceLabel = device ? `${device.model ?? device.serial}${device.android_version ? ` (Android ${device.android_version})` : ''}` : 'an unidentified device'
  const passed = execution.status === 'PASSED'
  const failedStep = steps.find((s) => s.status === 'FAILED' || s.status === 'BLOCKED')

  const parts: string[] = []

  parts.push(
    `This mobile test ("${testName}") executed ${steps.length} step${steps.length === 1 ? '' : 's'} against ${appLabel} on ${deviceLabel}, completing in ${
      execution.duration_ms != null ? `${(execution.duration_ms / 1000).toFixed(1)}s` : 'an unrecorded duration'
    }.`,
  )

  if (passed) {
    parts.push('All steps completed successfully with no unresolved failures.')
  } else if (failedStep) {
    const locator = failedStep.resolved_locator?.value ?? failedStep.locator?.value
    parts.push(
      `The run failed at step ${failedStep.step_index} while executing "${failedStep.action}"${
        locator ? ` on locator "${locator}"` : ''
      }${failedStep.actual ? `: ${failedStep.actual}` : '.'}`,
    )
  } else {
    parts.push(`The run ended with status ${execution.status} before completing all recorded steps.`)
  }

  if (healing.length > 0) {
    const recovered = healing.filter((h) => HEALING_SUCCESS_STATUSES.has(h.status)).length
    parts.push(
      `${healing.length} locator${healing.length === 1 ? '' : 's'} required self-healing during this run, of which ${recovered} ${recovered === 1 ? 'was' : 'were'} successfully applied.`,
    )
  } else {
    parts.push('No locators required self-healing during this run.')
  }

  return parts.join(' ')
}
