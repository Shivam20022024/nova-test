import type { ApiDbStepLog, ApiExecutionDetail, DbTestExecutionDetail } from '../../lib/types'

/**
 * API/DB testing's equivalent of mobileReportData.ts — deterministic,
 * telemetry-derived summary + scorecard, reused by both the on-screen report
 * page and the PDF exporter so the two never drift apart. No AI narrative
 * (neither engine generates one, same as mobile): this is the same role
 * mobileReportData.ts's functions play for the mobile report.
 */

export type ApiDbQualityScorecard = {
  stepPassRate: number
  assertionPassRate: number | null
}

function extractAssertionCounts(steps: ApiDbStepLog[]): { passed: number; failed: number } {
  // Assertion pass/fail lines are folded into a step's `details` text by both
  // engines (e.g. "PASS: status equals 200 (actual: 200)") — there's no
  // separate structured assertion array on the wire, so count occurrences.
  let passed = 0
  let failed = 0
  for (const s of steps) {
    const text = `${s.details ?? ''} ${s.value ?? ''}`
    passed += (text.match(/PASS:/g) || []).length
    failed += (text.match(/FAIL:/g) || []).length
  }
  return { passed, failed }
}

export function apiDbQualityScorecard(steps: ApiDbStepLog[]): ApiDbQualityScorecard {
  const total = steps.length
  const passed = steps.filter((s) => s.status === 'PASSED').length
  const stepPassRate = total === 0 ? 0 : Math.round((passed / total) * 100)

  const { passed: assertPassed, failed: assertFailed } = extractAssertionCounts(steps)
  const assertTotal = assertPassed + assertFailed
  const assertionPassRate = assertTotal === 0 ? null : Math.round((assertPassed / assertTotal) * 100)

  return { stepPassRate, assertionPassRate }
}

export function buildApiExecutiveSummary(execution: ApiExecutionDetail): string {
  const steps = execution.stepLogs ?? []
  const passed = execution.status === 'PASSED'
  const failedStep = steps.find((s) => s.status === 'FAILED')
  const requestSteps = execution.steps.length

  const parts: string[] = []
  parts.push(
    `This API test ("${execution.name}") executed ${requestSteps} request${requestSteps === 1 ? '' : 's'}, completing in ${
      execution.durationMs != null ? `${(execution.durationMs / 1000).toFixed(1)}s` : 'an unrecorded duration'
    }.`,
  )

  if (passed) {
    parts.push('Every assertion across every request passed with no unresolved failures.')
  } else if (failedStep) {
    parts.push(`The run failed while executing "${failedStep.action}"${failedStep.details ? `: ${failedStep.details}` : '.'}`)
  } else if (execution.error) {
    parts.push(`The run ended with an error before completing: ${execution.error}`)
  } else {
    parts.push(`The run ended with status ${execution.status} before completing all recorded steps.`)
  }

  return parts.join(' ')
}

export function buildDbExecutiveSummary(execution: DbTestExecutionDetail): string {
  const steps = execution.stepLogs ?? []
  const passed = execution.status === 'PASSED'
  const failedStep = steps.find((s) => s.status === 'FAILED')
  const queryCount = execution.steps.length
  const anyCommit = execution.steps.some((s) => s.commit)

  const parts: string[] = []
  parts.push(
    `This database test ("${execution.name}") ran ${queryCount} quer${queryCount === 1 ? 'y' : 'ies'}/operation${queryCount === 1 ? '' : 's'}, completing in ${
      execution.durationMs != null ? `${(execution.durationMs / 1000).toFixed(1)}s` : 'an unrecorded duration'
    }.`,
  )

  if (passed) {
    parts.push('Every assertion across every query passed with no unresolved failures.')
  } else if (failedStep) {
    parts.push(`The run failed while executing "${failedStep.action}"${failedStep.details ? `: ${failedStep.details}` : '.'}`)
  } else if (execution.error) {
    parts.push(`The run ended with an error before completing: ${execution.error}`)
  } else {
    parts.push(`The run ended with status ${execution.status} before completing all recorded steps.`)
  }

  parts.push(
    anyCommit
      ? 'At least one step explicitly committed its changes; the rest rolled back automatically.'
      : 'No step committed — every query ran inside a transaction that was rolled back automatically, so this run made no lasting changes to the database.',
  )

  return parts.join(' ')
}
