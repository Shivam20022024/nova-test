import { X } from 'lucide-react'
import type { ReactNode } from 'react'

type FilterBarProps = {
  children: ReactNode
  onClear?: () => void
  className?: string
}

export function FilterBar({ children, onClear, className = '' }: FilterBarProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      {children}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 px-1.5 py-1 text-xs text-muted transition-colors hover:text-ink"
        >
          <X aria-hidden="true" size={12} />
          Clear filters
        </button>
      )}
    </div>
  )
}

type FilterSelectProps = {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  ariaLabel: string
}

export function FilterSelect({ value, onChange, options, ariaLabel }: FilterSelectProps) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="appearance-none rounded-md border border-line bg-paper-alt py-1.5 pr-7 pl-2.5 text-xs font-medium text-ink-soft focus:border-accent focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
