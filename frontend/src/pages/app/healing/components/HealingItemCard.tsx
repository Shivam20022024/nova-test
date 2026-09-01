import { ArrowRight, CircleCheck, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { HealingEvent } from '../../../../lib/types'

type HealingItemCardProps = {
  item: HealingEvent
  busy: boolean
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

export function HealingItemCard({ item, busy, onApprove, onReject }: HealingItemCardProps) {
  const isPending = item.status === 'PENDING'
  const project = item.executionLog?.suite?.project?.name
  const suite = item.executionLog?.suite?.name

  return (
    <Card className={`p-4 ${item.status === 'REJECTED' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-sans text-sm font-semibold text-ink">
            {item.testName || 'Unnamed test'}
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted">
            {[project, suite].filter(Boolean).join(' · ') || 'Unattributed run'}
            {item.stepIndex != null && ` · step ${item.stepIndex}`}
          </p>
        </div>
        <StatusBadge
          status={
            item.status === 'APPROVED' ? 'pass' : item.status === 'REJECTED' ? 'fail' : 'healing'
          }
          label={item.status === 'PENDING' ? 'Needs review' : item.status.toLowerCase()}
        />
      </div>

      <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
        <code className="max-w-full overflow-x-auto rounded-md border border-fail/30 bg-fail/5 px-2.5 py-1.5 font-mono text-xs break-all text-fail">
          {item.originalSelector || '—'}
        </code>
        <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <code className="max-w-full overflow-x-auto rounded-md border border-pass/30 bg-pass/5 px-2.5 py-1.5 font-mono text-xs break-all text-pass">
          {item.healedSelector || '—'}
        </code>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-xs text-muted">
        {item.success && (
          <span className="flex items-center gap-1 text-pass">
            <CircleCheck size={12} aria-hidden="true" />
            Replacement passed at run time
          </span>
        )}
        <span>{new Date(item.createdAt).toLocaleString()}</span>
        <Link
          to={`/app/execution/${item.executionLogId}/report`}
          className="flex items-center gap-1 text-ink-soft hover:text-accent-deep hover:underline"
        >
          View run
          <ExternalLink size={11} aria-hidden="true" />
        </Link>
      </div>

      {isPending && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
          {/* Approving is a write: the backend rewrites the healed selector into
              the stored test steps, so future runs use it. */}
          <p className="mr-auto text-xs text-muted">
            Approving updates the saved test steps.
          </p>
          <Button
            variant="outline"
            marker={false}
            disabled={busy}
            onClick={() => onReject(item.id)}
          >
            Reject
          </Button>
          <Button marker={false} disabled={busy} onClick={() => onApprove(item.id)}>
            {busy ? 'Saving…' : 'Approve'}
          </Button>
        </div>
      )}
    </Card>
  )
}
