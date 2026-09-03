import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { ExternalLink, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Skeleton } from '../../../components/ui/Skeleton'
import { api } from '../../../lib/api'
import type { ExecutionDetail } from '../../../lib/types'
import { useExecutionSocket } from '../../../hooks/useExecutionSocket'
import { ExecutionStatusBadge } from '../execution/components/ExecutionStatusBadge'
import { ExecutionSteps } from '../execution/components/ExecutionSteps'
import type { StepLog } from '../execution/components/ExecutionSteps'

const IN_FLIGHT = new Set(['PENDING', 'QUEUED', 'RUNNING', 'GENERATING_SCRIPT', 'HEALING'])

/**
 * Inline "execution started" panel shown on Author Tests right after a run is
 * queued. Reuses the existing execution-detail endpoint (poll), the live
 * Socket.IO feed, the shared status badge and step component, and the existing
 * execution + report pages — it introduces no new execution mechanism.
 *
 * `fallback` carries what this page already knows (name / browser / URL) so
 * they show immediately, since GET /executions/:id returns a reduced payload
 * while a run is still QUEUED/RUNNING.
 */
export function RunStartedCard({
  executionId,
  extraCount = 0,
  fallback,
  onDismiss,
}: {
  executionId: string
  extraCount?: number
  fallback?: { testName?: string; browser?: string; targetUrl?: string }
  onDismiss: () => void
}) {
  const { data, error } = useSWR<ExecutionDetail>(
    ['exec', executionId],
    () => api.getRunDetails(executionId),
    { refreshInterval: (d) => (d && IN_FLIGHT.has(d.status) ? 2500 : 0) },
  )

  const running = data ? IN_FLIGHT.has(data.status) : true
  const live = useExecutionSocket(running ? [executionId] : [])

  const steps = (Array.isArray(data?.stepLogs) ? data.stepLogs : []) as StepLog[]
  const testName = data?.testName || fallback?.testName || 'Untitled run'
  const browser = data?.browser || fallback?.browser || '—'
  const targetUrl = data?.targetUrl || fallback?.targetUrl || '—'
  const recentEvents = live.events.slice(-5)

  return (
    <Card className="mt-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-sans text-base font-semibold text-ink">
            {running ? 'Running test…' : 'Execution complete'}
          </h2>
          {data && <ExecutionStatusBadge status={data.status} />}
          {extraCount > 0 && <span className="font-mono text-xs text-muted">+{extraCount} more queued</span>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-fail">Could not load execution status: {(error as Error).message}</p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Test case</dt>
              <dd className="mt-0.5 truncate text-ink">{testName}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Browser</dt>
              <dd className="mt-0.5 capitalize text-ink">{browser}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Duration</dt>
              <dd className="mt-0.5 text-ink">
                {data?.durationMs != null ? `${(data.durationMs / 1000).toFixed(1)}s` : running ? '…' : '—'}
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="font-mono text-xs text-muted uppercase">Target URL</dt>
              <dd className="mt-0.5 truncate font-mono text-xs text-ink">{targetUrl}</dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="font-mono text-xs text-muted uppercase">Execution ID</dt>
              <dd className="mt-0.5 font-mono text-xs text-ink">{executionId}</dd>
            </div>
          </dl>

          {!data ? (
            <Skeleton className="mt-4 h-16 w-full" />
          ) : steps.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 font-mono text-xs tracking-wide text-muted uppercase">Step results</p>
              <ExecutionSteps steps={steps} />
            </div>
          ) : running ? (
            <div className="mt-4 rounded-md border border-line bg-paper-alt p-3">
              <p className="font-mono text-xs tracking-wide text-muted uppercase">Live telemetry</p>
              {recentEvents.length === 0 ? (
                <p className="mt-1.5 text-sm text-muted">Waiting for the first agent event…</p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {recentEvents.map((e) => (
                    <li key={e.id} className="truncate font-mono text-xs text-ink-soft">
                      {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button href={`/app/execution/${executionId}`} marker={false}>
              <ExternalLink size={14} aria-hidden="true" /> View full execution
            </Button>
            <Button href={`/app/execution/${executionId}/report`} variant="outline" marker={false}>
              Open report
            </Button>
            <Link to="/app/execution" className="self-center font-mono text-xs text-accent hover:underline">
              All executions →
            </Link>
          </div>
        </>
      )}
    </Card>
  )
}
