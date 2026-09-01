import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

type DrawerProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export function Drawer({ open, onClose, title, children, footer }: DrawerProps) {
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-sm flex-col border-l border-line bg-paper-alt shadow-float"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-sans text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-sm border border-line text-ink-soft transition-colors hover:bg-ink hover:text-paper"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="border-t border-line p-4">{footer}</div>}
      </div>
    </div>
  )
}
