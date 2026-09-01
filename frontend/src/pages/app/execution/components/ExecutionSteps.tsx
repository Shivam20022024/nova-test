import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { Status } from '../../../../components/ui/StatusBadge'

/**
 * Step rows as the execution agent records them into `ExecutionLog.stepLogs`.
 * Everything here is optional because the shape varies by action type and by
 * whether the step completed, healed, or failed.
 */
export type StepLog = {
  action?: string
  status?: string
  time?: string
  durationMs?: number
  details?: string
  value?: string
  rawSelector?: string
}

const statusMap: Record<string, Status> = {
  PASSED: 'pass',
  FAILED: 'fail',
  SKIPPED: 'blocked',
  TRIGGERED: 'healing',
}

function formatDuration(ms?: number): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ExecutionSteps({ steps }: { steps: StepLog[] }) {
  if (steps.length === 0) {
    return (
      <p className="rounded-md border border-line bg-paper-alt px-4 py-8 text-center text-sm text-muted">
        No step telemetry was recorded for this run.
      </p>
    )
  }

  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((step, index) => {
        const status = statusMap[step.status ?? ''] ?? 'blocked'
        const isFailure = status === 'fail'

        return (
          <li
            key={index}
            className={`rounded-md border px-3 py-2.5 ${
              isFailure ? 'border-fail/30 bg-fail/5' : 'border-line bg-paper-alt'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted">{String(index + 1).padStart(2, '0')}</span>
              <span className="font-mono text-sm text-ink">{step.action ?? 'step'}</span>
              <StatusBadge status={status} label={step.status ?? 'unknown'} />
              {step.durationMs != null && (
                <span className="font-mono text-xs text-muted">{formatDuration(step.durationMs)}</span>
              )}
              {step.time && (
                <span className="ml-auto font-mono text-xs text-muted">
                  {new Date(step.time).toLocaleTimeString()}
                </span>
              )}
            </div>

            {step.details && (
              <p
                className={`mt-1 pl-8 text-xs break-words ${isFailure ? 'text-fail' : 'text-ink-soft'}`}
              >
                {step.details}
              </p>
            )}
            {step.rawSelector && (
              <p className="mt-0.5 pl-8 font-mono text-xs break-all text-muted">
                {step.rawSelector}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
