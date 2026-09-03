import { StatusBadge } from '../../../components/ui/StatusBadge'
import type { Status } from '../../../components/ui/StatusBadge'
import type { AggregatedStatus, ReleaseStatus, SprintStatus } from '../../../lib/types'

/**
 * Maps traceability lifecycle + rollup states onto the shared status-colour
 * system (pass / fail / running / flaky / healing / blocked). No new palette.
 */

const aggMap: Record<AggregatedStatus, { status: Status; label: string }> = {
  PASSED: { status: 'pass', label: 'Passed' },
  FAILED: { status: 'fail', label: 'Failed' },
  PARTIAL: { status: 'flaky', label: 'Partial' },
  RUNNING: { status: 'running', label: 'Running' },
  SKIPPED: { status: 'blocked', label: 'Skipped' },
  NOT_RUN: { status: 'blocked', label: 'Not run' },
}

export function AggregatedStatusBadge({ status }: { status: AggregatedStatus }) {
  const m = aggMap[status] ?? { status: 'blocked' as Status, label: String(status) }
  return <StatusBadge status={m.status} label={m.label} />
}

const releaseMap: Record<ReleaseStatus, { status: Status; label: string }> = {
  PLANNED: { status: 'blocked', label: 'Planned' },
  ACTIVE: { status: 'running', label: 'Active' },
  RELEASED: { status: 'pass', label: 'Released' },
  ARCHIVED: { status: 'blocked', label: 'Archived' },
}

export function ReleaseStatusBadge({ status }: { status: ReleaseStatus | null | undefined }) {
  const m = releaseMap[status ?? 'PLANNED'] ?? releaseMap.PLANNED
  return <StatusBadge status={m.status} label={m.label} />
}

const sprintMap: Record<SprintStatus, { status: Status; label: string }> = {
  PLANNED: { status: 'blocked', label: 'Planned' },
  ACTIVE: { status: 'running', label: 'Active' },
  CLOSED: { status: 'pass', label: 'Closed' },
}

export function SprintStatusBadge({ status }: { status: SprintStatus }) {
  const m = sprintMap[status] ?? sprintMap.PLANNED
  return <StatusBadge status={m.status} label={m.label} />
}

const sourceLabel: Record<string, { text: string; className: string }> = {
  NEW: { text: 'New', className: 'bg-accent-soft text-accent-deep' },
  CARRIED_FORWARD: { text: 'Carried forward', className: 'bg-sand text-ink-soft' },
  MANUAL: { text: 'Manual', className: 'bg-sand text-ink-soft' },
}

export function AssignmentSourceBadge({ source }: { source: string }) {
  const m = sourceLabel[source] ?? sourceLabel.MANUAL
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase ${m.className}`}>
      {m.text}
    </span>
  )
}
