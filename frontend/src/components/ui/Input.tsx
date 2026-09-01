import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

type InputProps = {
  label: string
  error?: string
  helperText?: string
  icon?: ReactNode
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, helperText, icon, id, ...rest },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const helperId = `${inputId}-helper`

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        {icon && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 ${
              error ? 'text-fail' : 'text-muted'
            }`}
          >
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={error || helperText ? helperId : undefined}
          className={`w-full rounded-md border bg-paper-alt py-2.5 text-sm text-ink placeholder:text-muted focus:outline-none ${
            icon ? 'pl-9 pr-3' : 'px-3'
          } ${error ? 'border-fail focus:border-fail' : 'border-line focus:border-accent'}`}
          {...rest}
        />
      </div>
      {(error || helperText) && (
        <p id={helperId} className={`text-xs ${error ? 'text-fail' : 'text-muted'}`}>
          {error ?? helperText}
        </p>
      )}
    </div>
  )
})
