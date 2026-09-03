import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import { FileText, FolderKanban, PlayCircle, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { Select } from '../../../components/ui/Select'
import { StatTile } from '../../../components/ui/StatTile'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { api } from '../../../lib/api'
import type { ExecutionListItem, Release, Sprint } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { ExecutionStatusBadge } from './components/ExecutionStatusBadge'
import { RunTestsModal } from './components/RunTestsModal'
import type { RunConfig } from './components/RunTestsModal'

/** Runs in flight are polled so the list settles without a manual refresh. */
const ACTIVE_REFRESH_MS = 5_000

const IN_FLIGHT = new Set(['QUEUED', 'RUNNING', 'PENDING', 'GENERATING_SCRIPT', 'HEALING'])
const SUCCESS = new Set(['PASSED', 'COMPLETED', 'Completed With Warnings'])
const FAILURE = new Set(['FAILED', 'BLOCKED'])

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export default function ExecutionListPage() {
  const navigate = useNavigate()
  const { activeProject, scopedProjectId, suites, activeSuite } = useData()
  const { triggerToast } = useToast()

  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const scope = scopedProjectId ?? 'all'
  const { data, error, isLoading, isValidating, mutate } = useSWR<ExecutionListItem[]>(
    ['executions', scope],
    () => api.getExecutions(scopedProjectId),
  )

  // Optional client-side traceability filter. Empty selection = today's
  // dataset, unchanged (the underlying query is never re-scoped).
  const [releaseFilter, setReleaseFilter] = useState('')
  const [sprintFilter, setSprintFilter] = useState('')
  const releases = useSWR<Release[]>(
    scopedProjectId ? ['releases', scopedProjectId] : null,
    () => api.listReleases(scopedProjectId),
  )
  const sprintOptions = useSWR<Sprint[]>(
    releaseFilter ? ['release-sprints', releaseFilter] : null,
    () => api.listReleaseSprints(releaseFilter),
  )

  const allExecutions = useMemo(() => data ?? [], [data])
  const executions = useMemo(
    () =>
      allExecutions.filter(
        (run) =>
          (!releaseFilter || run.releaseId === releaseFilter) &&
          (!sprintFilter || run.sprintId === sprintFilter),
      ),
    [allExecutions, releaseFilter, sprintFilter],
  )
  const hasActive = allExecutions.some((run) => IN_FLIGHT.has(run.status))

  // Poll only while something is actually running.
  useSWR(hasActive ? ['executions-poll', scope] : null, () => mutate(), {
    refreshInterval: ACTIVE_REFRESH_MS,
  })

  const counts = useMemo(
    () => ({
      total: executions.length,
      running: executions.filter((run) => IN_FLIGHT.has(run.status)).length,
      passed: executions.filter((run) => SUCCESS.has(run.status)).length,
      failed: executions.filter((run) => FAILURE.has(run.status)).length,
    }),
    [executions],
  )

  async function submitRun(config: RunConfig) {
    if (!activeProject || isAllProjects(activeProject)) {
      triggerToast('Select a specific project before running tests.', true)
      return
    }
    setSubmitting(true)
    try {
      const result = await api.runMultiTest({
        test_name: config.testName,
        base_url: config.baseUrl || null,
        steps: config.steps,
        browsers: config.browsers,
        devices: config.devices,
        project_id: activeProject.id,
        suite_id: config.suiteId || null,
      })
      setModalOpen(false)
      await mutate()
      triggerToast(
        `Queued ${result.executionIds.length} execution${result.executionIds.length === 1 ? '' : 's'}.`,
      )
      // Jump straight to the first run so the live stream is visible.
      if (result.executionIds[0]) navigate(`/app/execution/${result.executionIds[0]}`)
    } catch (err) {
      triggerToast(`Could not queue run: ${(err as Error).message}`, true)
    } finally {
      setSubmitting(false)
    }
  }

  const columns: DataTableColumn<ExecutionListItem>[] = [
    {
      key: 'testName',
      header: 'Run',
      render: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/app/execution/${row.id}`)}
          className="text-left"
        >
          <span className="block font-medium text-ink hover:text-accent-deep hover:underline">
            {row.testName || row.suite?.name || 'Untitled run'}
          </span>
          <span className="block font-mono text-xs text-muted">{row.id.slice(0, 8)}</span>
        </button>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <span className="font-mono text-xs">{row.executionType}</span>,
    },
    {
      key: 'browser',
      header: 'Browser',
      render: (row) => <span className="capitalize">{row.browser}</span>,
    },
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.suite?.project?.name ?? '—',
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      sortAccessor: (row) => row.durationMs ?? -1,
      render: (row) => <span className="font-mono text-xs">{formatDuration(row.durationMs)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortAccessor: (row) => row.status,
      render: (row) => <ExecutionStatusBadge status={row.status} />,
    },
    {
      key: 'started',
      header: 'Started',
      sortAccessor: (row) => row.startedAt ?? row.createdAt,
      render: (row) => (
        <span className="font-mono text-xs">
          {new Date(row.startedAt ?? row.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Report',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            navigate(`/app/execution/${row.id}/report`)
          }}
          aria-label={`Open report for ${row.testName ?? row.id}`}
          title="Open report"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
        >
          <FileText size={15} aria-hidden="true" />
        </button>
      ),
    },
  ]

  if (!activeProject) {
    return (
      <div>
        <PageHeader title="Executions" description="Every test run across your environments." />
        <EmptyState
          icon={FolderKanban}
          title="No project selected"
          description="Choose a project from the top bar to see its runs."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Executions"
        description={`Runs for ${activeProject.name}.`}
        actions={
          <>
            <Button
              variant="outline"
              marker={false}
              onClick={() => void mutate()}
              disabled={isValidating}
            >
              <RefreshCw
                size={15}
                aria-hidden="true"
                className={isValidating ? 'animate-spin' : ''}
              />
              Refresh
            </Button>
            <Button
              onClick={() => setModalOpen(true)}
              disabled={isAllProjects(activeProject)}
              title={
                isAllProjects(activeProject)
                  ? 'Select a specific project to run tests'
                  : undefined
              }
            >
              Run Tests
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load executions"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={() => void mutate()}>
              Try again
            </Button>
          }
        />
      ) : isLoading ? (
        <div aria-hidden="true">
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full rounded-card" />
            ))}
          </div>
          <Skeleton className="h-80 w-full rounded-md" />
        </div>
      ) : allExecutions.length === 0 ? (
        <EmptyState
          icon={PlayCircle}
          title="No executions yet"
          description="Queue a run here, or describe a test in plain English on the One-Click Test page."
          action={
            <Button onClick={() => setModalOpen(true)} disabled={isAllProjects(activeProject)}>
              Run Tests
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total" value={counts.total} />
            <StatTile label="In flight" value={counts.running} />
            <StatTile label="Passed" value={counts.passed} />
            <StatTile label="Failed" value={counts.failed} />
          </div>

          {(releases.data?.length ?? 0) > 0 && (
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="w-48">
                <Select
                  label="Release"
                  value={releaseFilter}
                  onChange={(e) => {
                    setReleaseFilter(e.target.value)
                    setSprintFilter('')
                  }}
                >
                  <option value="">All releases</option>
                  {(releases.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </Select>
              </div>
              <div className="w-48">
                <Select
                  label="Sprint"
                  value={sprintFilter}
                  onChange={(e) => setSprintFilter(e.target.value)}
                  disabled={!releaseFilter}
                >
                  <option value="">All sprints</option>
                  {(sprintOptions.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </div>
              {(releaseFilter || sprintFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setReleaseFilter('')
                    setSprintFilter('')
                  }}
                  className="pb-2.5 font-mono text-xs text-accent hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="rounded-md border border-line bg-paper-alt">
            <DataTable columns={columns} rows={executions} getRowKey={(row) => row.id} />
          </div>
        </>
      )}

      <RunTestsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        suites={suites}
        defaultSuiteId={activeSuite?.id ?? null}
        submitting={submitting}
        onSubmitRun={(config) => void submitRun(config)}
      />
    </div>
  )
}
