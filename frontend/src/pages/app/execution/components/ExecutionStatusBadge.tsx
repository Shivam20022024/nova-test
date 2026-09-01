import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { Status } from '../../../../components/ui/StatusBadge'
import type { ExecutionStatus } from '../../../../lib/types'

/**
 * Maps backend execution states onto the shared status colours.
 *
 * Both PASSED and COMPLETED mean success — COMPLETED is what the worker writes
 * for autonomous runs, PASSED comes from older rows. BLOCKED is a real terminal
 * state written when a run is stopped by anti-bot protection.
 */
const statusMap: Record<string, { status: Status; label: string }> = {
  PENDING: { status: 'blocked', label: 'Pending' },
  QUEUED: { status: 'blocked', label: 'Queued' },
  RUNNING: { status: 'running', label: 'Running' },
  GENERATING_SCRIPT: { status: 'running', label: 'Generating' },
  HEALING: { status: 'healing', label: 'Healing' },
  PASSED: { status: 'pass', label: 'Passed' },
  COMPLETED: { status: 'pass', label: 'Completed' },
  FAILED: { status: 'fail', label: 'Failed' },
  BLOCKED: { status: 'fail', label: 'Blocked' },
  CANCELLED: { status: 'blocked', label: 'Cancelled' },
  'Completed With Warnings': { status: 'flaky', label: 'Completed with warnings' },
}

export function ExecutionStatusBadge({ status }: { status: ExecutionStatus | string }) {
  const mapped = statusMap[status] ?? { status: 'blocked' as Status, label: String(status) }
  return <StatusBadge status={mapped.status} label={mapped.label} />
}
