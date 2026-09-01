import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'

export type ToastKind = 'success' | 'error'

type Toast = {
  id: number
  kind: ToastKind
  message: string
}

type ToastContextValue = {
  /**
   * Signature matches the previous frontend so ported call sites read the same:
   * triggerToast(message) for success, triggerToast(message, true) for error.
   */
  triggerToast: (message: string, isError?: boolean) => void
  dismissToast: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

const TOAST_MS = 5000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  // Tracked so a manual dismiss also cancels the pending auto-dismiss.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const triggerToast = useCallback(
    (message: string, isError = false) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { id, kind: isError ? 'error' : 'success', message }])
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), TOAST_MS),
      )
    },
    [dismissToast],
  )

  const value = useMemo(() => ({ triggerToast, dismissToast }), [triggerToast, dismissToast])

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Errors are assertive so screen readers announce a failed run immediately. */}
      <div
        className="pointer-events-none fixed top-4 left-1/2 z-[999] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4 print:hidden"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm shadow-float ${
              toast.kind === 'error'
                ? 'border-fail/30 bg-fail/10 text-fail'
                : 'border-pass/30 bg-pass/10 text-pass'
            }`}
          >
            {toast.kind === 'error' ? (
              <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
