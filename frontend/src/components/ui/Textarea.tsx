import { useId } from 'react'
import type { TextareaHTMLAttributes } from 'react'

type TextareaProps = {
  label?: string
  error?: string
  helperText?: string
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>

export function Textarea({ label, error, helperText, id, ...rest }: TextareaProps) {
  const generatedId = useId()
  const textareaId = id ?? generatedId
  const helperId = `${textareaId}-helper`

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={textareaId} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        aria-invalid={Boolean(error)}
        aria-describedby={error || helperText ? helperId : undefined}
        className={`resize-none rounded-md border bg-paper-alt px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:outline-none ${
          error ? 'border-fail focus:border-fail' : 'border-line focus:border-accent'
        }`}
        {...rest}
      />
      {(error || helperText) && (
        <p id={helperId} className={`text-xs ${error ? 'text-fail' : 'text-muted'}`}>
          {error ?? helperText}
        </p>
      )}
    </div>
  )
}
