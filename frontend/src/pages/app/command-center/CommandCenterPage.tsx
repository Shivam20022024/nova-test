import { useMemo } from 'react'
import useSWR from 'swr'
import { Activity, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { DonutChart } from '../../../components/charts/DonutChart'
import type { DonutSlice } from '../../../components/charts/DonutChart'
import { LineTrendChart } from '../../../components/charts/LineTrendChart'
import { useAppShell } from '../../../app/providers'
import { useData } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type {
  BrowserDistributionEntry,
  DashboardSummary,
  ExecutionTrendPoint,
  RecentExecutionItem,
} from '../../../lib/types'
import { RecentExecutionsSection } from './sections/RecentExecutionsSection'

/** Matches the previous dashboard: telemetry refreshes on a 30s cadence. */
const REFRESH_MS = 30_000
const TREND_DAYS = 7
const RECENT_LIMIT = 25

const BROWSER_COLORS = [
  'var(--color-accent)',
  'var(--color-running)',
  'var(--color-healing)',
  'var(--color-flaky)',
  'var(--color-pass)',
]

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-card" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="h-72 w-full rounded-card" />
        <Skeleton className="h-72 w-full rounded-card" />
      </div>
      <Skeleton className="h-72 w-full rounded-card" />
    </div>
  )
}

export default function CommandCenterPage() {
  const { environment } = useAppShell()
  const { activeProject, scopedProjectId } = useData()

  // scopedProjectId is undefined for "All Projects", which the backend reads as
  // "no filter". It is part of each key so switching project refetches.
  const scope = scopedProjectId ?? 'all'

  const summary = useSWR<DashboardSummary>(
    ['dashboard-summary', scope],
    () => api.getDashboardSummary(scopedProjectId),
    { refreshInterval: REFRESH_MS },
  )
  const trend = useSWR<ExecutionTrendPoint[]>(
    ['dashboard-trend', scope],
    () => api.getExecutionTrend(TREND_DAYS, scopedProjectId),
    { refreshInterval: REFRESH_MS },
  )
  const browsers = useSWR<BrowserDistributionEntry[]>(
    ['dashboard-browsers', scope],
    () => api.getBrowserDistribution(scopedProjectId),
    { refreshInterval: REFRESH_MS },
  )
  const recent = useSWR<RecentExecutionItem[]>(
    ['dashboard-recent', scope],
    () => api.getRecentExecutions(RECENT_LIMIT, scopedProjectId),
    { refreshInterval: REFRESH_MS },
  )

  const loading = summary.isLoading || trend.isLoading || browsers.isLoading || recent.isLoading
  const validating =
    summary.isValidating || trend.isValidating || browsers.isValidating || recent.isValidating
  const error = summary.error || trend.error || browsers.error || recent.error

  const trendPoints = useMemo(
    () =>
      (trend.data ?? []).map((point) => ({
        label: point.date,
        value: point.passed + point.failed,
      })),
    [trend.data],
  )

  const browserSlices = useMemo<DonutSlice[]>(
    () =>
      (browsers.data ?? []).map((entry, index) => ({
        label: entry.browser,
        value: entry.count,
        color: BROWSER_COLORS[index % BROWSER_COLORS.length],
      })),
    [browsers.data],
  )

  function refreshAll() {
    void Promise.all([summary.mutate(), trend.mutate(), browsers.mutate(), recent.mutate()])
  }

  const totalRuns = browserSlices.reduce((sum, slice) => sum + slice.value, 0)
  const hasExecutions = (summary.data?.totalExecutions ?? 0) > 0

  return (
    <div>
      <PageHeader
        title="Command Center"
        description={`${activeProject?.name ?? 'No project'} · ${environment}`}
        actions={
          <Button
            variant="outline"
            marker={false}
            onClick={refreshAll}
            disabled={validating}
            aria-label="Refresh telemetry"
          >
            <RefreshCw size={15} aria-hidden="true" className={validating ? 'animate-spin' : ''} />
            {validating ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load telemetry"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={refreshAll}>
              Try again
            </Button>
          }
        />
      ) : loading ? (
        <DashboardSkeleton />
      ) : !hasExecutions ? (
        <EmptyState
          icon={Activity}
          title="No executions yet"
          description="Run your first test to start seeing pass rates, trends and browser coverage here."
          action={<Button href="/app/one-click-test">Run a test</Button>}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Executions" value={summary.data?.totalExecutions ?? 0} />
            <StatTile label="Success rate" value={summary.data?.successRate ?? 0} unit="%" />
            <StatTile label="Passed" value={summary.data?.passedCount ?? 0} />
            <StatTile label="Failed" value={summary.data?.failedCount ?? 0} />
            <StatTile label="Avg duration" value={summary.data?.avgDuration ?? 0} unit="s" />
            <StatTile label="Self-healed" value={summary.data?.selfHealingCount ?? 0} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="font-sans text-sm font-semibold text-ink">Execution trend</h2>
                <span className="font-mono text-xs text-muted">Last {TREND_DAYS} days</span>
              </div>
              {trendPoints.length > 0 ? (
                <LineTrendChart data={trendPoints} height={220} />
              ) : (
                <p className="py-10 text-center text-sm text-muted">No runs in this window.</p>
              )}
            </Card>

            <Card className="flex flex-col items-center p-5">
              <h2 className="mb-4 self-start font-sans text-sm font-semibold text-ink">
                Browser coverage
              </h2>
              <DonutChart
                data={browserSlices}
                size={160}
                centerValue={totalRuns}
                centerLabel="runs"
              />
              <ul className="mt-4 w-full space-y-1.5">
                {browserSlices.map((slice) => (
                  <li key={slice.label} className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: slice.color }}
                    />
                    <span className="flex-1 truncate text-ink-soft capitalize">{slice.label}</span>
                    <span className="font-mono text-xs text-ink">{slice.value}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div>
            {(recent.data?.length ?? 0) > 0 ? (
              <RecentExecutionsSection items={recent.data ?? []} />
            ) : (
              <p className="rounded-md border border-line bg-paper-alt px-4 py-8 text-center text-sm text-muted">
                No recent executions for this project.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
