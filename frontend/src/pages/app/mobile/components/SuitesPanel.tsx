import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Layers, Play } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { api } from '../../../../lib/api'
import { useToast } from '../../../../contexts/ToastContext'
import type { MobileSuite } from '../../../../lib/types'
import { formatDuration, formatWhen, statusLabel, toStatus } from '../mobileStatus'

type Props = {
  suites: MobileSuite[]
  loading: boolean
  onWatch: (executionId: number) => void
}

export function SuitesPanel({ suites, loading, onWatch }: Props) {
  const navigate = useNavigate()
  const { triggerToast } = useToast()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [running, setRunning] = useState<number | null>(null)

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function run(suite: MobileSuite) {
    setRunning(suite.id)
    try {
      await api.mobile.runSuite(suite.id)
      triggerToast(`Re-running ${suite.name}.`)
      navigate(`/app/mobile/executions/${suite.id}`)
    } catch (error) {
      triggerToast(`Could not start the suite: ${(error as Error).message}`, true)
    } finally {
      setRunning(null)
    }
  }

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-6 w-40" />
        <div className="mt-5 flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Card>
    )
  }

  if (suites.length === 0) {
    return (
      <Card className="p-6">
        <EmptyState
          icon={Layers}
          title="No suites yet"
          description="A suite is created whenever you import or generate a batch of tests. Use the Author tab to bring in a test sheet or describe a scenario."
        />
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {suites.map((suite) => {
        const isOpen = expanded.has(suite.id)
        const total = suite.test_count || 1
        return (
          <Card key={suite.id} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-4 p-5">
              <button
                type="button"
                onClick={() => toggle(suite.id)}
                aria-expanded={isOpen}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {isOpen ? (
                  <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-muted" />
                ) : (
                  <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{suite.name}</span>
                  <span className="mt-1 block font-mono text-xs text-muted">
                    {suite.application_name ?? 'no app'} · {suite.source.toLowerCase().replace('_', ' ')} ·{' '}
                    {formatWhen(suite.created_at)}
                  </span>
                </span>
              </button>

              {/* Proportional bar, not a chart: the ratio is the point, and it
                  stays readable at a glance in a list of many suites. */}
              <div className="flex items-center gap-3">
                <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-line" role="img"
                  aria-label={`${suite.passed_count} passed, ${suite.failed_count} failed, ${suite.skipped_count} skipped`}>
                  <span style={{ width: `${(suite.passed_count / total) * 100}%`, backgroundColor: 'var(--color-pass)' }} />
                  <span style={{ width: `${(suite.failed_count / total) * 100}%`, backgroundColor: 'var(--color-fail)' }} />
                  <span style={{ width: `${(suite.skipped_count / total) * 100}%`, backgroundColor: 'var(--color-blocked)' }} />
                </div>
                <span className="font-mono text-xs text-ink-soft">
                  {suite.passed_count}/{suite.test_count}
                </span>
              </div>

              <Button
                variant="outline"
                marker={false}
                disabled={running === suite.id || suite.status === 'RUNNING'}
                onClick={() => void run(suite)}
                title={suite.status === 'RUNNING' ? 'This suite is already running' : undefined}
              >
                <Play size={14} aria-hidden="true" />
                {running === suite.id ? 'Starting…' : suite.status === 'RUNNING' ? 'Running' : 'Re-run'}
              </Button>
            </div>

            {isOpen && (
              <div className="border-t border-line">
                {suite.tests.length === 0 ? (
                  <p className="p-5 text-sm text-muted">This suite has no tests.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {suite.tests.map((row) => {
                      const skipped = !!row.not_automatable_reason
                      return (
                        <li key={row.test_id} className="p-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-ink">
                                {row.test_case_id && (
                                  <span className="mr-2 font-mono text-xs text-muted">{row.test_case_id}</span>
                                )}
                                {row.name}
                              </p>
                              {row.module && <p className="mt-1 font-mono text-xs text-muted">{row.module}</p>}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-xs text-muted">{formatDuration(row.duration_ms)}</span>
                              <StatusBadge status={toStatus(row.status)} label={statusLabel(row.status)} />
                              {row.execution_id && (
                                <Button variant="outline" marker={false} onClick={() => onWatch(row.execution_id!)}>
                                  Open
                                </Button>
                              )}
                            </div>
                          </div>

                          {skipped ? (
                            /* Not a failure — the row describes something a UI
                               driver cannot do at all. Saying so plainly stops
                               people chasing it as a bug. */
                            <p className="mt-3 border-l border-blocked pl-3 text-sm text-ink-soft">
                              <span className="font-medium text-ink">Not automatable.</span>{' '}
                              {row.not_automatable_reason}
                            </p>
                          ) : (
                            (row.expected_result || row.actual_result) && (
                              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                                {row.expected_result && (
                                  <div>
                                    <dt className="font-mono text-xs uppercase tracking-wider text-muted">Expected</dt>
                                    <dd className="mt-1 text-sm text-ink-soft">{row.expected_result}</dd>
                                  </div>
                                )}
                                {row.actual_result && (
                                  <div>
                                    <dt className="font-mono text-xs uppercase tracking-wider text-muted">Actual</dt>
                                    <dd
                                      className="mt-1 text-sm"
                                      style={{
                                        color:
                                          toStatus(row.status) === 'fail' ? 'var(--color-fail)' : 'var(--color-ink-soft)',
                                      }}
                                    >
                                      {row.actual_result}
                                    </dd>
                                  </div>
                                )}
                              </dl>
                            )
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
