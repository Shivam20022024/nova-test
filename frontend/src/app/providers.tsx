import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../contexts/ToastContext'
import { AuthProvider } from '../contexts/AuthContext'
import { DataProvider } from '../contexts/DataContext'

/**
 * Environments the app can target. This is configuration, not data — the
 * backend takes `environment` as a free-form string on run payloads and does
 * not expose a list to choose from.
 */
export const environments = ['Dev', 'QA', 'Staging', 'Production'] as const
export type Environment = (typeof environments)[number]

/**
 * Chrome-only UI state. Project selection deliberately lives in `DataContext`
 * instead, because it drives real API calls rather than just layout.
 */
type AppShellContextValue = {
  environment: Environment
  setEnvironment: (environment: Environment) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  mobileNavOpen: boolean
  openMobileNav: () => void
  closeMobileNav: () => void
}

const AppShellContext = createContext<AppShellContextValue | null>(null)

export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext)
  if (!ctx) throw new Error('useAppShell must be used within <Providers>')
  return ctx
}

const ENV_STORAGE_KEY = 'novatest_environment'

function readStoredEnvironment(): Environment {
  try {
    const stored = localStorage.getItem(ENV_STORAGE_KEY)
    if (stored && (environments as readonly string[]).includes(stored)) {
      return stored as Environment
    }
  } catch {
    /* storage unavailable */
  }
  return environments[0]
}

function AppShellProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironmentState] = useState<Environment>(readStoredEnvironment)
  const isWideDesktop = useMediaQuery('(min-width: 1280px)')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(!isWideDesktop)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    setSidebarCollapsed(!isWideDesktop)
  }, [isWideDesktop])

  const value = useMemo<AppShellContextValue>(
    () => ({
      environment,
      setEnvironment: (next) => {
        setEnvironmentState(next)
        try {
          localStorage.setItem(ENV_STORAGE_KEY, next)
        } catch {
          /* selection is session-only when storage is blocked */
        }
      },
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed((v) => !v),
      mobileNavOpen,
      openMobileNav: () => setMobileNavOpen(true),
      closeMobileNav: () => setMobileNavOpen(false),
    }),
    [environment, sidebarCollapsed, mobileNavOpen],
  )

  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
}

/**
 * Provider order is load-bearing:
 *   Theme  - no dependencies, applies the palette as early as possible
 *   Toast  - Auth and Data both surface errors through it
 *   Auth   - owns the Supabase session and the API bearer token
 *   Data   - loads projects/suites/cases, and needs the signed-in user
 *   Shell  - pure UI state, last so it can read anything above it
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <DataProvider>
            <AppShellProvider>{children}</AppShellProvider>
          </DataProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
