import { ChevronLeft, ChevronRight } from 'lucide-react'

type PaginationProps = {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  className?: string
}

export function Pagination({ page, pageCount, onPageChange, className = '' }: PaginationProps) {
  return (
    <nav
      aria-label="Pagination"
      className={`flex items-center justify-between gap-3 px-4 py-2.5 ${className}`.trim()}
    >
      <p className="font-mono text-xs text-muted">
        Page {page} of {pageCount}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeft aria-hidden="true" size={15} />
        </button>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronRight aria-hidden="true" size={15} />
        </button>
      </div>
    </nav>
  )
}
