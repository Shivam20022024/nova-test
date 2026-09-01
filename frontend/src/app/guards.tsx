import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

/** Where a signed-in user goes when they hit an auth-only page. */
export const APP_HOME = '/app/command-center'
const LOGIN = '/login'

/**
 * Shown while the Supabase session is still resolving. Without this the guard
 * would read `currentUser` as null on first paint and bounce a signed-in user
 * straight to the login page on every hard refresh.
 */
function AuthPending() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper" role="status">
      <span className="font-mono text-xs tracking-wide text-muted uppercase">Loading…</span>
    </div>
  )
}

/**
 * Gate for everything under /app. Unauthenticated visitors are sent to the
 * login page with their intended destination attached, so they land where they
 * were headed once they sign in.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { currentUser, authLoading } = useAuth()
  const location = useLocation()

  if (authLoading) return <AuthPending />
  if (!currentUser) return <Navigate to={LOGIN} replace state={{ from: location }} />

  return children ? <>{children}</> : <Outlet />
}

/**
 * Inverse gate for /login and /create-account: a signed-in user has no reason
 * to see them, so send them on to the app (or back to wherever they were
 * originally headed).
 */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { currentUser, authLoading } = useAuth()
  const location = useLocation()

  if (authLoading) return <AuthPending />

  if (currentUser) {
    const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname
    return <Navigate to={from ?? APP_HOME} replace />
  }

  return <>{children}</>
}
