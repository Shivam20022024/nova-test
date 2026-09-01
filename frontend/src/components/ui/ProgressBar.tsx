export type ProgressTone = 'accent' | 'pass' | 'fail' | 'flaky'

type ProgressBarProps = {
  value: number
  tone?: ProgressTone
  className?: string
}

const toneClass: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  pass: 'bg-pass',
  fail: 'bg-fail',
  flaky: 'bg-flaky',
}

export function ProgressBar({ value, tone = 'accent', className = '' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value))

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-line ${className}`.trim()}
    >
      <div
        className={`h-full rounded-full ${toneClass[tone]} transition-[width] duration-300`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
