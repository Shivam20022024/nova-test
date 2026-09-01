export type Status = 'pass' | 'fail' | 'running' | 'flaky' | 'healing' | 'blocked'

type StatusBadgeProps = {
  status: Status
  label?: string
}

const defaultLabel: Record<Status, string> = {
  pass: 'Passed',
  fail: 'Failed',
  running: 'Running',
  flaky: 'Flaky',
  healing: 'Healing',
  blocked: 'Blocked',
}

const colorVar: Record<Status, string> = {
  pass: 'var(--color-pass)',
  fail: 'var(--color-fail)',
  running: 'var(--color-running)',
  flaky: 'var(--color-flaky)',
  healing: 'var(--color-healing)',
  blocked: 'var(--color-blocked)',
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const color = colorVar[status]

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs font-medium whitespace-nowrap"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, white)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label ?? defaultLabel[status]}
    </span>
  )
}
