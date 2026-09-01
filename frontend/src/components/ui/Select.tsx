import { useId } from 'react'
import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

type SelectProps = {
  label?: string
  error?: string
  helperText?: string
  children: React.ReactNode
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>

export function Select({ label, error, helperText, id, children, ...rest }: SelectProps) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const helperId = `${selectId}-helper`

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={Boolean(error)}
          aria-describedby={error || helperText ? helperId : undefined}
          className={`w-full appearance-none rounded-md border bg-paper-alt px-3 py-2.5 pr-9 text-sm text-ink focus:outline-none ${
            error ? 'border-fail focus:border-fail' : 'border-line focus:border-accent'
          }`}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          size={14}
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
        />
      </div>
      {(error || helperText) && (
        <p id={helperId} className={`text-xs ${error ? 'text-fail' : 'text-muted'}`}>
          {error ?? helperText}
        </p>
      )}
    </div>
  )
}
