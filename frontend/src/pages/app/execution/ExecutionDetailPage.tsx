import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import useSWR from 'swr'
import { FileText, Radio, Square } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { DetailLayout } from '../../../components/ui/DetailLayout'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Skeleton } from '../../../components/ui/Skeleton'
import { api } from '../../../lib/api'
import type { ExecutionDetail, ExecutionPlan, ExecutionTrace } from '../../../lib/types'
import { useExecutionSocket } from '../../../hooks/useExecutionSocket'
import { useToast } from '../../../contexts/ToastContext'
import { ExecutionStatusBadge } from './components/ExecutionStatusBadge'
import { ExecutionSteps } from './components/ExecutionSteps'
import type { StepLog } from './components/ExecutionSteps'

/**
 * Tabs cover only artefacts the backend actually produces. The original design
 * also had DOM Snapshot, Network and Console tabs; the worker records none of
 * those, so they are not shown.
 */
const tabs = [
  { id: 'steps', label: 'Steps' },
  { id: 'live', label: 'Live' },
  { id: 'logs', label: 'Logs' },
  { id: 'screenshots', label: 'Screenshots' },
  { id: 'video', label: 'Video' },
  { id: 'trace', label: 'Trace & Plan' },
]

const IN_FLIGHT = new Set(['QUEUED', 'RUNNING', 'PENDING', 'GENERATING_SCRIPT', 'HEALING'])

function parseLogs(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : [raw]
  } catch {
    // Older rows store the log buffer as plain text rather than a JSON array.
    return raw.split('\n')
  }
}

export default function ExecutionDetailPage() {
  const { id = '' } = useParams()
  const { triggerToast } = useToast()
  const [activeTab, setActiveTab] = useState('steps')
  const [cancelling, setCancelling] = useState(false)

  const { data, error, isLoading, mutate } = useSWR<ExecutionDetail>(
    id ? ['execution', id] : null,
    () => api.getRunDetails(id),
  )

  const isRunning = data ? IN_FLIGHT.has(data.status) : false

  // The socket only carries a run that is still in flight; a finished run
  // renders entirely from the persisted row.
  const live = useExecutionSocket(isRunning ? [id] : [])

  // Once the socket reports the run finished, the persisted row now carries the
  // final status, duration and video URL - refetch so the page stops polling.
  const liveSettled = live.runs.some((run) => !IN_FLIGHT.has(run.status))
  useEffect(() => {
    if (liveSettled) void mutate()
  }, [liveSettled, mutate])

  const steps = useMemo<StepLog[]>(
    () => (Array.isArray(data?.stepLogs) ? (data.stepLogs as StepLog[]) : []),
    [data],
  )
  const logs = useMemo(() => parseLogs(data?.logs ?? null), [data])
  const frame = live.frames[id]

  // Fetched only once the Trace & Plan tab is actually opened — both payloads
  // can be large and are irrelevant to every other tab.
  const trace = useSWR<ExecutionTrace>(
    activeTab === 'trace' && id ? ['execution-trace', id] : null,
    () => api.getExecutionTrace(id),
  )
  const plan = useSWR<ExecutionPlan>(
    activeTab === 'trace' && id ? ['execution-plan', id] : null,
    () => api.getExecutionPlan(id),
  )

  async function cancel() {
    setCancelling(true)
    try {
      await api.cancelExecution(id)
      await mutate()
      triggerToast('Execution cancelled.')
    } catch (err) {
      triggerToast(`Could not cancel: ${(err as Error).message}`, true)
    } finally {
      setCancelling(false)
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load this execution"
        description={(error as Error).message}
        action={
          <Button marker={false} onClick={() => void mutate()}>
            Try again
          </Button>
        }
      />
    )
  }

  if (isLoading || !data) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    )
  }

  return (
    <DetailLayout
      eyebrow="Execution"
      title={data.testName || 'Untitled run'}
      meta={
        <>
          <span className="font-mono text-xs">{data.id.slice(0, 8)}</span>
          <span className="text-line">·</span>
          <span>{data.executionType}</span>
          <span className="text-line">·</span>
          <span className="capitalize">{data.browser}</span>
          {data.targetUrl && (
            <>
              <span className="text-line">·</span>
              <span className="truncate">{data.targetUrl}</span>
            </>
          )}
          {data.durationMs != null && (
            <>
              <span className="text-line">·</span>
              <span>{(data.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
        </>
      }
      badges={<ExecutionStatusBadge status={data.status} />}
      actions={
        <>
          {isRunning && (
            <Button
              variant="outline"
              marker={false}
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              <Square size={14} aria-hidden="true" />
              {cancelling ? 'Stopping…' : 'Stop run'}
            </Button>
          )}
          <Button href={`/app/execution/${data.id}/report`} variant="outline" marker={false}>
            <FileText size={15} aria-hidden="true" />
            Open report
          </Button>
        </>
      }
      banner={
        isRunning ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-running/30 bg-running/5 px-4 py-3">
            <Radio size={16} aria-hidden="true" className="shrink-0 animate-pulse text-running" />
            <p className="flex-1 text-sm text-ink">
              This run is in progress. Live telemetry is {live.connectionStatus}.
            </p>
          </div>
        ) : undefined
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {activeTab === 'steps' && <ExecutionSteps steps={steps} />}

      {activeTab === 'live' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="overflow-hidden p-0">
            <div className="flex aspect-video items-center justify-center bg-ink">
              {frame ? (
                frame.startsWith('data:') ? (
                  <img src={frame} alt="Live browser view" className="h-full w-full object-contain" />
                ) : (
                  <video src={frame} controls className="h-full w-full object-contain" />
                )
              ) : (
                <p className="px-6 text-center text-sm text-paper/70">
                  {isRunning
                    ? 'Waiting for the first frame from the browser…'
                    : 'Live view is only available while a run is in progress.'}
                </p>
              )}
            </div>
          </Card>

          <Card className="flex max-h-[28rem] flex-col p-0">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="font-sans text-sm font-semibold text-ink">Event feed</h2>
              <span className="font-mono text-xs text-muted">{live.events.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {live.events.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted">
                  No live events. Telemetry appears here while a run is executing.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {live.events.map((event) => (
                    <li key={event.id} className="px-4 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-xs tracking-wide text-accent-deep uppercase">
                          {event.type}
                        </span>
                        <time className="shrink-0 font-mono text-xs text-muted">
                          {event.time.toLocaleTimeString()}
                        </time>
                      </div>
                      <p className="mt-0.5 text-xs break-words text-ink-soft">{event.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'logs' && (
        <Card className="p-0">
          {logs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No logs recorded.</p>
          ) : (
            <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
              {logs.join('\n')}
            </pre>
          )}
        </Card>
      )}

      {activeTab === 'screenshots' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.screenshots.length === 0 ? (
            <p className="col-span-full rounded-md border border-line bg-paper-alt px-4 py-8 text-center text-sm text-muted">
              No screenshots were captured. The agent takes one when a step fails.
            </p>
          ) : (
            data.screenshots.map((shot) => (
              <a
                key={shot.id}
                href={shot.url}
                target="_blank"
                rel="noopener noreferrer"
                className="overflow-hidden rounded-md border border-line hover:border-accent"
              >
                <img src={shot.url} alt="Execution screenshot" className="w-full" />
              </a>
            ))
          )}
        </div>
      )}

      {activeTab === 'video' && (
        <Card className="overflow-hidden p-0">
          {data.videos.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No video artefact for this run.
            </p>
          ) : (
            <video src={data.videos[0].url} controls className="w-full bg-ink" />
          )}
        </Card>
      )}

      {activeTab === 'trace' && (
        <div className="flex flex-col gap-4">
          <Card className="p-0">
            <div className="border-b border-line px-4 py-2.5">
              <h2 className="font-sans text-sm font-semibold text-ink">Execution plan</h2>
              <p className="text-xs text-muted">
                The action plan the agent generated for this run, before execution.
              </p>
            </div>
            {plan.error ? (
              <p className="px-4 py-8 text-center text-sm text-fail">
                Could not load the plan: {(plan.error as Error).message}
              </p>
            ) : plan.isLoading ? (
              <Skeleton className="m-4 h-32 rounded-md" />
            ) : plan.data && Object.keys(plan.data.plan ?? {}).length > 0 ? (
              <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
                {JSON.stringify(plan.data.plan, null, 2)}
              </pre>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted">
                No plan was recorded for this run.
              </p>
            )}
          </Card>

          <Card className="p-0">
            <div className="border-b border-line px-4 py-2.5">
              <h2 className="font-sans text-sm font-semibold text-ink">Raw trace</h2>
              <p className="text-xs text-muted">
                The unprocessed event trace behind the Steps tab above.
              </p>
            </div>
            {trace.error ? (
              <p className="px-4 py-8 text-center text-sm text-fail">
                Could not load the trace: {(trace.error as Error).message}
              </p>
            ) : trace.isLoading ? (
              <Skeleton className="m-4 h-32 rounded-md" />
            ) : trace.data && trace.data.traceEvents.length > 0 ? (
              <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
                {JSON.stringify(trace.data.traceEvents, null, 2)}
              </pre>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted">
                No trace events were recorded for this run.
              </p>
            )}
          </Card>
        </div>
      )}
    </DetailLayout>
  )
}
