import type { ReactNode } from 'react'

type ChipProps = {
  active?: boolean
  onClick?: () => void
  children: ReactNode
  className?: string
}

export function Chip({ active = false, onClick, children, className = '' }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3.5 py-1.5 font-mono text-xs whitespace-nowrap transition-colors ${
        active
          ? 'border-accent bg-accent-soft text-accent-deep'
          : 'border-line text-ink-soft hover:border-ink hover:text-ink'
      } ${className}`.trim()}
    >
      {children}
    </button>
  )
}
