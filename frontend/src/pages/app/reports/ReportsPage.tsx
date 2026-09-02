import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { BarChart3, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Chip } from '../../../components/ui/Chip'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { Tabs } from '../../../components/ui/Tabs'
import { CategoryBarChart } from '../../../components/charts/CategoryBarChart'
import { LineTrendChart } from '../../../components/charts/LineTrendChart'
import { useData } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type {
  BrowserDistributionEntry,
  DashboardSummary,
  ExecutionTrendPoint,
  RunSource,
} from '../../../lib/types'

type SourceFilter = RunSource | 'all'

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'web', label: 'Web' },
  { id: 'mobile', label: 'Mobile' },
]

/**
 * Two tabs only. The original design also had Test, Defects, Coverage and
 * Flaky tabs, but the backend exposes no per-test history, defect model,
 * coverage data or flake tracking, so those are not built.
 */
const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
]

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
]

export default function ReportsPage() {
  const { activeProject, scopedProjectId } = useData()
  const [activeTab, setActiveTab] = useState('overview')
  const [days, setDays] = useState('7')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  const scope = scopedProjectId ?? 'all'

  const summary = useSWR<DashboardSummary>(['reports-summary', scope], () =>
    api.getDashboardSummary(scopedProjectId),
  )
  const trend = useSWR<ExecutionTrendPoint[]>(['reports-trend', scope, days], () =>
    api.getExecutionTrend(Number(days), scopedProjectId),
  )
  const browsers = useSWR<BrowserDistributionEntry[]>(['reports-browsers', scope], () =>
    api.getBrowserDistribution(scopedProjectId),
  )

  const loading = summary.isLoading || trend.isLoading || browsers.isLoading
  const validating = summary.isValidating || trend.isValidating || browsers.isValidating
  const error = summary.error || trend.error || browsers.error

  const totalPoints = useMemo(
    () => (trend.data ?? []).map((point) => ({ label: point.date, value: point.passed + point.failed })),
    [trend.data],
  )
  const passedPoints = useMemo(
    () => (trend.data ?? []).map((point) => ({ label: point.date, value: point.passed })),
    [trend.data],
  )
  const failedPoints = useMemo(
    () => (trend.data ?? []).map((point) => ({ label: point.date, value: point.failed })),
    [trend.data],
  )
  const browserBars = useMemo(
    () => (browsers.data ?? []).map((entry) => ({ label: entry.browser, value: entry.count })),
    [browsers.data],
  )

  function refreshAll() {
    void Promise.all([summary.mutate(), trend.mutate(), browsers.mutate()])
  }

  // Same rule as Command Center: 'web' fields sit at the top level of
  // `summary` (pre-dating mobile support), 'mobile'/'combined' are nested,
  // and 'all' has no single meaningful avgDuration to show.
  const viewStats = useMemo(() => {
    if (!summary.data) return null
    if (sourceFilter === 'mobile') return summary.data.mobile
    if (sourceFilter === 'all') return { ...summary.data.combined, avgDuration: null as number | null }
    return summary.data
  }, [summary.data, sourceFilter])

  return (
    <div>
      <PageHeader
        title="Reports"
        description={`Execution analytics for ${activeProject?.name ?? 'all projects'}.`}
        actions={
          <Button variant="outline" marker={false} onClick={refreshAll} disabled={validating}>
            <RefreshCw size={15} aria-hidden="true" className={validating ? 'animate-spin' : ''} />
            {validating ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Show:</span>
        {SOURCE_FILTERS.map((filter) => (
          <Chip key={filter.id} active={sourceFilter === filter.id} onClick={() => setSourceFilter(filter.id)}>
            {filter.label}
          </Chip>
        ))}
      </div>

      <Tabs tabs={tabs} activeId={activeTab} onChange={setActiveTab} className="mb-6" />

      {error ? (
        <ErrorState
          title="Could not load report data"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={refreshAll}>
              Try again
            </Button>
          }
        />
      ) : loading ? (
        <div aria-hidden="true" className="flex flex-col gap-6">
          <Skeleton className="h-20 w-full rounded-card" />
          <Skeleton className="h-72 w-full rounded-card" />
        </div>
      ) : (viewStats?.totalExecutions ?? 0) === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing to report yet"
          description="Reports are built from execution history. Run a test to populate them."
          action={<Button href="/app/one-click-test">Run a test</Button>}
        />
      ) : activeTab === 'overview' ? (
        <div className="flex flex-col gap-6">
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

          {sourceFilter !== 'mobile' && (
            <Card className="p-5">
              <h2 className="mb-4 font-sans text-sm font-semibold text-ink">Runs by browser</h2>
              {browserBars.length > 0 ? (
                <CategoryBarChart data={browserBars} />
              ) : (
                <p className="py-8 text-center text-sm text-muted">No browser data recorded.</p>
              )}
            </Card>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex justify-end">
            <div className="w-44">
              <Select label="Range" value={days} onChange={(event) => setDays(event.target.value)}>
                {RANGES.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <Card className="p-5">
            <div className="mb-4 flex items-baseline justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-ink">Total executions</h2>
              <span className="font-mono text-xs text-muted">Web + mobile</span>
            </div>
            <LineTrendChart data={totalPoints} height={220} />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="mb-4 font-sans text-sm font-semibold text-ink">Passed</h2>
              <LineTrendChart data={passedPoints} height={180} color="var(--color-pass)" />
            </Card>
            <Card className="p-5">
              <h2 className="mb-4 font-sans text-sm font-semibold text-ink">Failed</h2>
              <LineTrendChart data={failedPoints} height={180} color="var(--color-fail)" />
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
