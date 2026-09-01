import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { ContextHeader } from '../components/navigation/ContextHeader'
import { Sidebar } from '../components/navigation/Sidebar'
import { Topbar } from '../components/navigation/Topbar'
import { RouteFade } from '../components/ui/RouteFade'
import { Skeleton } from '../components/ui/Skeleton'

function RouteLoadingFallback() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64 rounded-sm" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  )
}

export default function AppLayout() {
  return (
    <div className="flex h-dvh overflow-hidden bg-paper text-ink print:h-auto print:overflow-visible print:bg-paper-alt">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <ContextHeader />
        <main className="flex-1 overflow-y-auto print:h-auto print:overflow-visible">
          <div className="relative mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8 print:max-w-none print:p-0">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-64 md:h-80 print:hidden"
              style={{
                background:
                  'linear-gradient(180deg, var(--color-accent-soft) 0%, color-mix(in srgb, var(--color-accent-soft) 45%, var(--color-paper)) 60%, var(--color-paper) 100%)',
              }}
            >
              <div className="bg-grain" style={{ position: 'absolute', inset: 0 }} />
            </div>
            <RouteFade>
              <Suspense fallback={<RouteLoadingFallback />}>
                <Outlet />
              </Suspense>
            </RouteFade>
          </div>
        </main>
      </div>
    </div>
  )
}
