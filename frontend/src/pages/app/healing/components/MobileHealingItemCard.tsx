import { useState } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { Input } from '../../../../components/ui/Input'
import { Select } from '../../../../components/ui/Select'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { MobileHealingRecord, MobileLocator } from '../../../../lib/types'

// The only state that still needs a person: AutoHeal found ZERO candidate
// locators to try on its own — a genuine dead end, not a fix waiting for
// sign-off. Everything else (VALIDATED, VALIDATION_FAILED, etc.) is
// AutoHeal's own automatic outcome and renders with no action below.
const DEAD_END_STATUSES = new Set(['REQUIRES_REVIEW', 'PENDING_APPROVAL'])
const DISMISSED_STATUSES = new Set(['REJECTED', 'VALIDATION_FAILED', 'ROLLED_BACK'])

const LOCATOR_STRATEGIES: Array<{ value: MobileLocator['strategy']; label: string }> = [
  { value: 'resource_id', label: 'Resource ID' },
  { value: 'accessibility_id', label: 'Accessibility ID' },
  { value: 'text', label: 'Text' },
  { value: 'xpath', label: 'XPath' },
  { value: 'class_name', label: 'Class name' },
  { value: 'semantic', label: 'Semantic (describe it)' },
]

type Props = {
  item: MobileHealingRecord
  busy: boolean
  onRetryWithLocator: (id: number, locator: MobileLocator) => void
  onDismiss: (id: number) => void
}

/**
 * Mobile counterpart to HealingItemCard. Most records render as a plain,
 * no-action log entry — AutoHeal already found and applied a fix on its
 * own. Only a genuine dead end (no candidate locator found at all) gets an
 * inline form: type in a locator to retry the step with, or dismiss it.
 * This is deliberately NOT framed as approving AutoHeal — there is no fix
 * to approve in this state, only one to supply.
 */
export function MobileHealingItemCard({ item, busy, onRetryWithLocator, onDismiss }: Props) {
  const isDeadEnd = DEAD_END_STATUSES.has(item.status)
  const isDismissed = DISMISSED_STATUSES.has(item.status)
  const replacement = item.replacement_locator?.value ?? item.candidate_locators?.[0]?.locator?.value

  const [strategy, setStrategy] = useState<MobileLocator['strategy']>('resource_id')
  const [value, setValue] = useState('')

  return (
    <Card className={`p-4 ${isDismissed ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-sans text-sm font-semibold text-ink">Mobile execution #{item.execution_id}</p>
          <p className="mt-0.5 font-mono text-xs text-muted">step {item.step_index}</p>
        </div>
        <StatusBadge
          status={isDeadEnd ? 'blocked' : isDismissed ? 'fail' : 'pass'}
          label={isDeadEnd ? 'No automatic fix found' : isDismissed ? 'Dismissed' : 'Applied automatically'}
        />
      </div>

      <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
        <code className="max-w-full overflow-x-auto rounded-md border border-fail/30 bg-fail/5 px-2.5 py-1.5 font-mono text-xs break-all text-fail">
          {item.original_locator?.value ?? '—'}
        </code>
        <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <code className="max-w-full overflow-x-auto rounded-md border border-pass/30 bg-pass/5 px-2.5 py-1.5 font-mono text-xs break-all text-pass">
          {replacement ?? (isDeadEnd ? 'no candidate found' : '—')}
        </code>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-xs text-muted">
        {item.confidence != null && !isDeadEnd && <span>{Math.round(item.confidence)}% confidence</span>}
        <Link
          to={`/app/mobile/executions/${item.execution_id}/report`}
          className="flex items-center gap-1 text-ink-soft hover:text-accent-deep hover:underline"
        >
          View run
          <ExternalLink size={11} aria-hidden="true" />
        </Link>
      </div>

      {isDeadEnd && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-xs text-muted">
            AutoHeal could not find any candidate replacement for this locator on its own. Supply one below to
            retry the step — this is a manual fix, not an AutoHeal approval.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="sm:w-48">
              <Select
                label="Strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as MobileLocator['strategy'])}
              >
                {LOCATOR_STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1">
              <Input
                label="Locator value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. com.app:id/submit_button"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" marker={false} disabled={busy} onClick={() => onDismiss(item.id)}>
              Dismiss
            </Button>
            <Button
              marker={false}
              disabled={busy || !value.trim()}
              onClick={() => onRetryWithLocator(item.id, { strategy, value: value.trim() })}
            >
              {busy ? 'Retrying…' : 'Retry with this locator'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
