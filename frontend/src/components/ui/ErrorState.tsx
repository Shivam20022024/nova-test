import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

type ErrorStateProps = {
  title?: string
  description?: string
  action?: ReactNode
  className?: string
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  action,
  className = '',
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-fail/30 bg-fail/5 px-6 py-16 text-center ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-fail/10 text-fail"
      >
        <TriangleAlert aria-hidden="true" size={20} />
      </span>
      <div>
        <p className="font-sans text-sm font-semibold text-ink">{title}</p>
        {description && (
          <p className="mt-1 max-w-sm text-sm text-ink-soft">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}
