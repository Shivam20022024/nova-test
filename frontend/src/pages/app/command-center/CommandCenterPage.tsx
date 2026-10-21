import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Activity, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Chip } from '../../../components/ui/Chip'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { DonutChart } from '../../../components/charts/DonutChart'
import type { DonutSlice } from '../../../components/charts/DonutChart'
import { LineTrendChart } from '../../../components/charts/LineTrendChart'
import { useAppShell } from '../../../app/providers'
import { useData } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type {
  CoverageDistributionEntry,
  DashboardSummary,
  ExecutionTrendPoint,
  RecentExecutionItem,
  RunSource,
} from '../../../lib/types'
import { RecentExecutionsSection } from './sections/RecentExecutionsSection'

type SourceFilter = RunSource | 'all'

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'web', label: 'Web' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'api', label: 'API' },
  { id: 'db', label: 'Database' },
]

type RangePreset = '' | '7' | '15' | '30' | '90' | 'custom'

const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: '', label: 'All time' },
  { id: '7', label: 'Last 7 days' },
  { id: '15', label: 'Last 15 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: 'custom', label: 'Custom range' },
]

/** yyyy-mm-dd, in the browser's local timezone (matches <input type="date">). */
function toDateInputValue(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

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

/** Card title + row label for the coverage donut, keyed by the active
 * Show: filter — see routes/dashboard.ts's /coverage-distribution for what
 * each source's breakdown actually represents. */
const COVERAGE_CARD_META: Record<SourceFilter, { title: string; unit: string }> = {
  all: { title: 'Testing coverage', unit: 'runs' },
  web: { title: 'Browser coverage', unit: 'runs' },
  mobile: { title: 'Platform coverage', unit: 'runs' },
  api: { title: 'Method coverage', unit: 'requests' },
  db: { title: 'Engine coverage', unit: 'runs' },
}

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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  // Command Center's date-range filter. Default '' = no selection = all-time
  // data, unfiltered — exactly as it behaved before this filter existed.
  const [rangePreset, setRangePreset] = useState<RangePreset>('')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const dateRange = useMemo(() => {
    if (rangePreset === '') return undefined
    if (rangePreset === 'custom') {
      if (!customStart && !customEnd) return undefined
      return { startDate: customStart || undefined, endDate: customEnd || undefined }
    }
    const days = Number(rangePreset)
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - (days - 1))
    return { startDate: toDateInputValue(start), endDate: toDateInputValue(end) }
  }, [rangePreset, customStart, customEnd])

  const isAllTime = rangePreset === ''
  const trendDays = isAllTime ? TREND_DAYS : rangePreset !== 'custom' ? Number(rangePreset) : TREND_DAYS

  const trendRangeLabel = useMemo(() => {
    if (isAllTime) return 'All time'
    if (rangePreset === 'custom') {
      if (dateRange?.startDate && dateRange?.endDate) return `${dateRange.startDate} → ${dateRange.endDate}`
      if (dateRange?.startDate) return `Since ${dateRange.startDate}`
      if (dateRange?.endDate) return `Through ${dateRange.endDate}`
      return 'Custom range'
    }
    return `Last ${trendDays} days`
  }, [isAllTime, rangePreset, trendDays, dateRange])

  // scopedProjectId is undefined for "All Projects", which the backend reads as
  // "no filter". It, and the active date range, are part of each key so
  // switching project or range refetches.
  const scope = scopedProjectId ?? 'all'
  const rangeKey = `${dateRange?.startDate ?? ''}:${dateRange?.endDate ?? ''}`

  const summary = useSWR<DashboardSummary>(
    ['dashboard-summary', scope, rangeKey],
    () => api.getDashboardSummary(scopedProjectId, dateRange),
    { refreshInterval: REFRESH_MS },
  )
  const trend = useSWR<ExecutionTrendPoint[]>(
    ['dashboard-trend', scope, rangeKey],
    () => api.getExecutionTrend(trendDays, scopedProjectId, dateRange, isAllTime),
    { refreshInterval: REFRESH_MS },
  )
  const browsers = useSWR<CoverageDistributionEntry[]>(
    ['dashboard-coverage', scope, sourceFilter, rangeKey],
    () => api.getCoverageDistribution(sourceFilter, scopedProjectId, dateRange),
    { refreshInterval: REFRESH_MS },
  )
  const recent = useSWR<RecentExecutionItem[]>(
    ['dashboard-recent', scope, rangeKey],
    () => api.getRecentExecutions(RECENT_LIMIT, scopedProjectId, dateRange),
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
        label: entry.label,
        value: entry.count,
        color: BROWSER_COLORS[index % BROWSER_COLORS.length],
      })),
    [browsers.data],
  )

  const coverageMeta = COVERAGE_CARD_META[sourceFilter]

  function refreshAll() {
    void Promise.all([summary.mutate(), trend.mutate(), browsers.mutate(), recent.mutate()])
  }

  const totalRuns = browserSlices.reduce((sum, slice) => sum + slice.value, 0)

  // The stat tiles below read whichever slice of `summary` matches the
  // filter — 'web' fields sit at the top level (pre-dating mobile support),
  // 'mobile' and 'combined' are nested. avgDuration has no combined figure:
  // averaging across two structurally different run types (browser vs.
  // device) isn't a meaningful single number, so 'all' just omits it.
  const viewStats = useMemo(() => {
    if (!summary.data) return null
    if (sourceFilter === 'mobile') return summary.data.mobile
    if (sourceFilter === 'api') return summary.data.api
    if (sourceFilter === 'db') return summary.data.db
    if (sourceFilter === 'all') return { ...summary.data.combined, avgDuration: null as number | null }
    return summary.data
  }, [summary.data, sourceFilter])

  const visibleRecent = useMemo(
    () =>
      (recent.data ?? []).filter((item) => sourceFilter === 'all' || (item.source ?? 'web') === sourceFilter),
    [recent.data, sourceFilter],
  )

  const hasExecutions = (viewStats?.totalExecutions ?? 0) > 0

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

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <span className="text-sm font-medium text-muted">Show:</span>
        {SOURCE_FILTERS.map((filter) => (
          <Chip
            key={filter.id}
            active={sourceFilter === filter.id}
            onClick={() => setSourceFilter(filter.id)}
            className="!px-4 !py-2 !text-sm !font-medium"
          >
            {filter.label}
          </Chip>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select
            label="Date range"
            value={rangePreset}
            onChange={(e) => setRangePreset(e.target.value as RangePreset)}
          >
            {RANGE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </div>
        {rangePreset === 'custom' && (
          <>
            <div className="w-40">
              <label className="mb-1.5 block text-sm font-medium text-ink">Start date</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                max={customEnd || undefined}
                className="w-full rounded-md border border-line bg-paper-alt px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </div>
            <div className="w-40">
              <label className="mb-1.5 block text-sm font-medium text-ink">End date</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                min={customStart || undefined}
                className="w-full rounded-md border border-line bg-paper-alt px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </div>
          </>
        )}
      </div>

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
            <StatTile label="Executions" value={viewStats?.totalExecutions ?? 0} />
            <StatTile label="Success rate" value={viewStats?.successRate ?? 0} unit="%" />
            <StatTile label="Passed" value={viewStats?.passedCount ?? 0} />
            <StatTile label="Failed" value={viewStats?.failedCount ?? 0} />
            <StatTile
              label="Avg duration"
              value={viewStats?.avgDuration ?? '—'}
              unit={viewStats?.avgDuration != null ? 's' : undefined}
            />
            <StatTile label="Self-healed" value={viewStats?.selfHealingCount ?? 0} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="font-sans text-sm font-semibold text-ink">Execution trend</h2>
                <span className="font-mono text-xs text-muted">{trendRangeLabel}</span>
              </div>
              {trendPoints.length > 0 ? (
                <LineTrendChart data={trendPoints} height={220} />
              ) : (
                <p className="py-10 text-center text-sm text-muted">No runs in this window.</p>
              )}
            </Card>

            <Card className="flex flex-col items-center p-5">
              <h2 className="mb-4 self-start font-sans text-sm font-semibold text-ink">
                {coverageMeta.title}
              </h2>
              {browserSlices.length > 0 ? (
                <DonutChart
                  data={browserSlices}
                  size={160}
                  centerValue={totalRuns}
                  centerLabel={coverageMeta.unit}
                />
              ) : (
                <p className="py-10 text-center text-sm text-muted">No data in this window.</p>
              )}
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
            {visibleRecent.length > 0 ? (
              <RecentExecutionsSection items={visibleRecent} />
            ) : (
              <p className="rounded-md border border-line bg-paper-alt px-4 py-8 text-center text-sm text-muted">
                No recent {sourceFilter === 'all' ? '' : `${sourceFilter} `}executions for this project.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
