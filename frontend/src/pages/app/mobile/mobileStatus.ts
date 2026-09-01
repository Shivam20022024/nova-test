import type { Status } from '../../../components/ui/StatusBadge'
import type { MobileExecutionStatus } from '../../../lib/types'

/**
 * Maps the engine's 18 execution statuses onto the product's six semantic
 * states. The status vocabulary is fixed platform-wide (DESIGN.md) — mobile
 * runs must read the same as web and API runs, so nothing here invents a
 * seventh colour for an Android-only state.
 */
const STATUS_MAP: Record<MobileExecutionStatus, Status> = {
  PASSED: 'pass',

  FAILED: 'fail',
  TIMEOUT: 'fail',
  INFRA_FAILURE: 'fail',

  // Everything on the way to running reads as running: a user watching a queue
  // does not care whether the engine is allocating a device or starting Appium,
  // only that it has not stalled.
  CREATED: 'running',
  QUEUED: 'running',
  ALLOCATING_DEVICE: 'running',
  STARTING_APPIUM: 'running',
  STARTING_SESSION: 'running',
  RUNNING: 'running',
  RETRYING: 'running',
  CLEANUP: 'running',

  HEALING: 'healing',

  // Not failures. These ran into something outside the test's control, or were
  // deliberately not run — colouring them red would overstate the damage and
  // train people to ignore real failures.
  BLOCKED: 'blocked',
  CANCELLED: 'blocked',
  SKIPPED: 'blocked',
  REQUIRES_REVIEW: 'blocked',
  WAITING_APPROVAL: 'blocked',
}

export function toStatus(status: MobileExecutionStatus | string | null | undefined): Status {
  if (!status) return 'blocked'
  return STATUS_MAP[status as MobileExecutionStatus] ?? 'blocked'
}

/** The engine's own word, kept verbatim — "INFRA_FAILURE" tells an engineer far
 *  more than the generic "Failed" the badge would otherwise show. */
export function statusLabel(status: MobileExecutionStatus | string | null | undefined): string {
  if (!status) return 'Unknown'
  return String(status)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Upload-time warning for APKs whose UI toolkit the automation driver cannot
 * see into. Severity is real and differs per framework — Flutter is a hard
 * stop, the others are cautions — so it is not flattened into one banner tone.
 */
export function frameworkSeverity(hint: string | null | undefined): 'blocking' | 'caution' | null {
  if (hint === 'FLUTTER') return 'blocking'
  if (hint === 'REACT_NATIVE' || hint === 'COMPOSE') return 'caution'
  return null
}
