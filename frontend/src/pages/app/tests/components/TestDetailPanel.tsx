import { useState } from 'react'
import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { Pencil, Trash2 } from 'lucide-react'
import { Card } from '../../../../components/ui/Card'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { ExecutionStatusBadge } from '../../execution/components/ExecutionStatusBadge'
import { AssignmentSourceBadge } from '../../releases/statusBadges'
import { api } from '../../../../lib/api'
import type { TestCase, TestCaseTraceability } from '../../../../lib/types'

/**
 * Steps are stored as free-form JSON on the backend (`TestRun.steps`) and
 * differ by suite type — Playwright actions for web, request definitions for
 * API. Rather than guess at a schema the server does not enforce, common
 * fields are surfaced when present and the raw step is always shown.
 */
type StepLike = {
  action?: string
  method?: string
  selector?: string
  url?: string
  value?: string
  [key: string]: unknown
}

function stepSummary(step: StepLike): string | null {
  const verb = step.action ?? step.method
  const target = step.selector ?? step.url
  if (!verb && !target) return null
  return [verb, target].filter(Boolean).join(' · ')
}

type TestDetailPanelProps = {
  test: TestCase
  onEdit: () => void
  onDelete: () => void
  deleting?: boolean
}

export function TestDetailPanel({ test, onEdit, onDelete, deleting }: TestDetailPanelProps) {
  const steps = Array.isArray(test.steps) ? (test.steps as StepLike[]) : []
  const [tab, setTab] = useState<'definition' | 'history'>('definition')

  // History is loaded lazily the first time the tab is opened.
  const history = useSWR<TestCaseTraceability>(
    tab === 'history' ? ['testcase-traceability', test.id] : null,
    () => api.getTestCaseTraceability(test.id),
  )

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-xs tracking-wide text-muted uppercase">Test case</p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${test.name}`}
            title="Edit"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={`Delete ${test.name}`}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-fail/10 hover:text-fail disabled:opacity-40"
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <h2 className="mt-1 font-sans text-base font-semibold break-words text-ink">
        {test.code && <span className="mr-2 font-mono text-xs text-muted">{test.code}</span>}
        {test.name}
      </h2>

      {test.intent && <p className="mt-2 text-sm text-ink-soft">{test.intent}</p>}

      <div className="mt-4 flex gap-1 border-b border-line">
        {(['definition', 'history'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 font-mono text-xs uppercase transition-colors ${
              tab === t ? 'border-accent text-accent-deep' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'history' ? (
        <div className="mt-4">
          {history.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : history.error ? (
            <p className="text-sm text-fail">Could not load history: {(history.error as Error).message}</p>
          ) : (
            <>
              <p className="font-mono text-xs tracking-wide text-muted uppercase">Assignment history</p>
              {(history.data?.assignmentHistory.length ?? 0) === 0 ? (
                <p className="mt-1 text-sm text-muted">Not assigned to any sprint yet.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {history.data?.assignmentHistory.map((a) => (
                    <li key={a.sprintId} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-ink">{a.releaseName} / {a.sprintName}</span>
                      <AssignmentSourceBadge source={a.assignmentSource} />
                      {a.carriedFrom && (
                        <span className="font-mono text-xs text-muted">from {a.carriedFrom.sprintName}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 font-mono text-xs tracking-wide text-muted uppercase">Execution history</p>
              {(history.data?.executionHistory.length ?? 0) === 0 ? (
                <p className="mt-1 text-sm text-muted">No executions linked to this test case.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {history.data?.executionHistory
                    .slice()
                    .reverse()
                    .map((e) => (
                      <li key={e.executionId} className="flex flex-wrap items-center gap-2 text-sm">
                        <ExecutionStatusBadge status={e.status} />
                        <span className="text-ink">
                          {e.releaseName ? `${e.releaseName} / ${e.sprintName ?? '—'}` : 'No sprint'}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {e.browser} · {new Date(e.createdAt).toLocaleDateString()}
                        </span>
                        <Link to={e.reportPath} className="font-mono text-xs text-accent hover:underline">
                          Report
                        </Link>
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : (
      <>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
        <div>
          <dt className="font-mono text-xs text-muted uppercase">Steps</dt>
          <dd className="mt-0.5 text-ink">{steps.length}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs text-muted uppercase">Created</dt>
          <dd className="mt-0.5 text-ink">{new Date(test.createdAt).toLocaleDateString()}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-line pt-4">
        <p className="font-mono text-xs tracking-wide text-muted uppercase">Steps</p>
        {steps.length === 0 ? (
          <p className="mt-2 text-sm text-muted">This test case has no steps recorded.</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2">
            {steps.map((step, index) => {
              const summary = stepSummary(step)
              return (
                <li key={index} className="rounded-md border border-line bg-paper p-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1 font-mono text-xs break-words text-ink">
                      {summary ?? 'Step'}
                    </span>
                  </div>
                  {step.value != null && String(step.value).length > 0 && (
                    <p className="mt-1 pl-6 font-mono text-xs break-words text-ink-soft">
                      value: {String(step.value)}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
      </>
      )}
    </Card>
  )
}
