import { Pencil, Trash2 } from 'lucide-react'
import { Card } from '../../../../components/ui/Card'
import type { TestCase } from '../../../../lib/types'

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
      <h2 className="mt-1 font-sans text-base font-semibold break-words text-ink">{test.name}</h2>

      {test.intent && <p className="mt-2 text-sm text-ink-soft">{test.intent}</p>}

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
    </Card>
  )
}
