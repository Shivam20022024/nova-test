import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type DropdownProps = {
  trigger: (props: { open: boolean }) => ReactNode
  children: (props: { close: () => void }) => ReactNode
  align?: 'left' | 'right'
  className?: string
  panelClassName?: string
  ariaLabel?: string
}

export function Dropdown({
  trigger,
  children,
  align = 'left',
  className = '',
  panelClassName = '',
  ariaLabel,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={`relative ${className}`.trim()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex"
      >
        {trigger({ open })}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-30 mt-2 min-w-48 rounded-md border border-line bg-paper-alt py-1.5 shadow-float print:hidden ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${panelClassName}`.trim()}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  )
}
