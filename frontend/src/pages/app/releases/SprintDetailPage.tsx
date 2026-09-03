import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { ListPlus, Play, GitBranch, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Modal } from '../../../components/ui/Modal'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { PageHeader } from '../../../components/ui/PageHeader'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { Sprint, SprintResults, TestCase } from '../../../lib/types'
import { AggregatedStatusBadge, AssignmentSourceBadge, SprintStatusBadge } from './statusBadges'

type Row = SprintResults['testCases'][number]

export default function SprintDetailPage() {
  const { releaseId = '', sprintId = '' } = useParams()
  const { triggerToast } = useToast()
  const [assignOpen, setAssignOpen] = useState(false)
  const [carryOpen, setCarryOpen] = useState(false)
  const [carryFrom, setCarryFrom] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const results = useSWR<SprintResults>(sprintId ? ['sprint-results', sprintId] : null, () => api.getSprintResults(sprintId))
  const projectId = results.data?.release.projectId

  const siblingSprints = useSWR<Sprint[]>(
    releaseId ? ['release-sprints', releaseId] : null,
    () => api.listReleaseSprints(releaseId),
  )

  // Product test-case library, loaded only when the assign modal opens.
  const library = useSWR(
    assignOpen && projectId ? ['project-testcases', projectId] : null,
    async () => {
      const suites = await api.getSuites(projectId as string)
      const perSuite = await Promise.all(
        suites.map(async (s) => (await api.getTestCases(s.id)).map((c) => ({ ...c, suiteName: s.name }))),
      )
      return perSuite.flat() as (TestCase & { suiteName: string })[]
    },
  )

  const assignedIds = useMemo(
    () => new Set((results.data?.testCases ?? []).map((t) => t.testRunId)),
    [results.data],
  )
  const assignable = (library.data ?? []).filter((c) => !assignedIds.has(c.id))

  async function refresh() {
    await results.mutate()
  }

  async function doAssign() {
    if (picked.size === 0) return
    setBusy(true)
    try {
      const r = await api.assignSprintTestCases(sprintId, [...picked])
      triggerToast(`Assigned ${r.assigned}${r.skipped ? `, ${r.skipped} already present` : ''}.`)
      setAssignOpen(false)
      setPicked(new Set())
      await refresh()
    } catch (err) {
      triggerToast(`Assign failed: ${(err as Error).message}`, true)
    } finally {
      setBusy(false)
    }
  }

  async function doCarry() {
    if (!carryFrom) return
    setBusy(true)
    try {
      const r = await api.carryForwardSprint(sprintId, carryFrom)
      triggerToast(`Carried forward ${r.carried}${r.skipped ? `, ${r.skipped} already present` : ''}.`)
      setCarryOpen(false)
      setCarryFrom('')
      await refresh()
    } catch (err) {
      triggerToast(`Carry forward failed: ${(err as Error).message}`, true)
    } finally {
      setBusy(false)
    }
  }

  async function unassign(row: Row) {
    if (!window.confirm(`Remove ${row.code || row.name} from this sprint? The test case and its run history stay.`)) return
    try {
      await api.unassignSprintTestCase(sprintId, row.testRunId)
      await refresh()
    } catch (err) {
      triggerToast(`Could not unassign: ${(err as Error).message}`, true)
    }
  }

  async function run(testRunIds?: string[]) {
    setBusy(true)
    try {
      const r = await api.runSprint(sprintId, testRunIds ? { testRunIds } : undefined)
      triggerToast(
        `Queued ${r.queued} run${r.queued === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length} (no steps)` : ''}.`,
      )
      await refresh()
    } catch (err) {
      triggerToast(`Run failed: ${(err as Error).message}`, true)
    } finally {
      setBusy(false)
    }
  }

  const columns: DataTableColumn<Row>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs text-muted">{r.code || '—'}</span> },
    {
      key: 'name',
      header: 'Test case',
      render: (r) => <span className="font-medium text-ink">{r.name || r.testRunId}</span>,
    },
    { key: 'assignmentSource', header: 'Assignment', render: (r) => <AssignmentSourceBadge source={r.assignmentSource} /> },
    { key: 'aggregatedStatus', header: 'Latest status', render: (r) => <AggregatedStatusBadge status={r.aggregatedStatus} /> },
    {
      key: 'lastExecutedAt',
      header: 'Last run',
      render: (r) => (
        <span className="font-mono text-xs text-muted">
          {r.lastExecutedAt ? new Date(r.lastExecutedAt).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-3">
          {r.latestExecutions[0] && (
            <Link
              to={`/app/execution/${r.latestExecutions[0].executionId}/report`}
              className="font-mono text-xs text-accent hover:underline"
            >
              Report
            </Link>
          )}
          <button
            type="button"
            onClick={() => void run([r.testRunId])}
            disabled={busy}
            className="font-mono text-xs text-accent hover:underline disabled:opacity-50"
          >
            Run
          </button>
          <button
            type="button"
            onClick={() => void unassign(r)}
            className="text-muted hover:text-fail"
            aria-label={`Remove ${r.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ]

  if (results.error) {
    return (
      <div>
        <PageHeader title="Sprint" />
        <ErrorState
          title="Could not load sprint"
          description={(results.error as Error).message}
          action={<Button href={`/app/releases/${releaseId}`} marker={false}>Back to release</Button>}
        />
      </div>
    )
  }

  const d = results.data

  return (
    <div>
      <PageHeader
        title={d?.sprint.name ?? 'Sprint'}
        description={
          d ? (
            <>
              <Link to={`/app/releases/${releaseId}`} className="text-accent hover:underline">{d.release.name}</Link>
              {' · '}
              {d.sprint.startDate ? new Date(d.sprint.startDate).toLocaleDateString() : 'no start'} →{' '}
              {d.sprint.endDate ? new Date(d.sprint.endDate).toLocaleDateString() : 'no end'}
            </>
          ) : (
            'Assigned test cases and their latest result.'
          )
        }
        actions={
          <>
            <Button variant="outline" marker={false} onClick={() => setCarryOpen(true)}>
              <GitBranch size={14} aria-hidden="true" /> Carry Forward
            </Button>
            <Button variant="outline" marker={false} onClick={() => setAssignOpen(true)}>
              <ListPlus size={14} aria-hidden="true" /> Assign Test Cases
            </Button>
            <Button marker={false} disabled={busy || !d || d.assignedTestCount === 0} onClick={() => void run()}>
              <Play size={14} aria-hidden="true" /> Run Sprint
            </Button>
          </>
        }
      />

      {!d ? (
        <Skeleton className="h-24 w-full rounded-card" />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            <span className="font-mono text-xs text-muted uppercase">Status</span>
            <SprintStatusBadge status={d.sprint.status} />
          </div>
          <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Assigned" value={d.assignedTestCount} />
            <StatTile label="Executed" value={d.executedTestCount} />
            <StatTile label="Passed" value={d.passedTestCount} />
            <StatTile label="Failed" value={d.failedTestCount} />
            <StatTile label="Partial" value={d.partialTestCount} />
            <StatTile label="Not run" value={d.notRunTestCount} />
          </div>
        </>
      )}

      {results.isLoading ? (
        <Skeleton className="h-48 w-full rounded-card" />
      ) : (d?.testCases.length ?? 0) === 0 ? (
        <EmptyState
          icon={ListPlus}
          title="No test cases assigned"
          description="Assign existing test cases from this product, or carry them forward from an earlier sprint."
          action={<Button onClick={() => setAssignOpen(true)}>Assign Test Cases</Button>}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable columns={columns} rows={d?.testCases ?? []} getRowKey={(r) => r.testRunId} />
        </Card>
      )}

      {/* Ad-hoc runs — One-Click / autonomous runs launched with this sprint
          selected. They carry the sprint but no assigned test case. */}
      {d && d.adHocRuns.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 font-sans text-sm font-semibold text-ink">Ad-hoc runs</h2>
          <p className="mb-3 text-xs text-muted">
            Launched from One-Click / autonomous with this sprint selected. Not tied to an assigned test case —{' '}
            <span className="font-mono">{d.adHocSummary.passed}</span> passed ·{' '}
            <span className="font-mono">{d.adHocSummary.failed}</span> failed ·{' '}
            <span className="font-mono">{d.adHocSummary.running}</span> running of{' '}
            <span className="font-mono">{d.adHocSummary.total}</span>.
          </p>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {d.adHocRuns.map((r) => (
                <li key={r.executionId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <AggregatedStatusBadge status={
                    /(passed|completed|completed with warnings)/i.test(r.status) ? 'PASSED'
                    : /(failed|blocked)/i.test(r.status) ? 'FAILED'
                    : /(queued|running|pending|generating|healing)/i.test(r.status) ? 'RUNNING'
                    : 'SKIPPED'
                  } />
                  <span className="min-w-0 flex-1 truncate text-ink">{r.testName || r.targetUrl || r.executionId}</span>
                  <span className="font-mono text-xs text-muted">{r.browser} · {new Date(r.createdAt).toLocaleString()}</span>
                  <Link to={r.reportPath} className="font-mono text-xs text-accent hover:underline">Report</Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* Assign modal */}
      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title="Assign test cases">
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {library.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : assignable.length === 0 ? (
            <p className="text-sm text-muted">Every test case in this product is already assigned to this sprint.</p>
          ) : (
            assignable.map((c) => (
              <label key={c.id} className="flex items-start gap-2 rounded-md border border-line p-2 text-sm hover:bg-sand">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.has(c.id)}
                  onChange={(e) => {
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(c.id)
                      else next.delete(c.id)
                      return next
                    })
                  }}
                />
                <span>
                  <span className="font-medium text-ink">{c.name}</span>{' '}
                  <span className="font-mono text-xs text-muted">{c.code ? `${c.code} · ` : ''}{c.suiteName}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" marker={false} onClick={() => setAssignOpen(false)}>Cancel</Button>
          <Button marker={false} disabled={busy || picked.size === 0} onClick={() => void doAssign()}>
            {busy ? 'Assigning…' : `Assign ${picked.size || ''}`.trim()}
          </Button>
        </div>
      </Modal>

      {/* Carry-forward modal */}
      <Modal open={carryOpen} onClose={() => setCarryOpen(false)} title="Carry forward test cases">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Copy every assignment from an earlier sprint into this one. Source assignments are untouched; test cases already here are skipped.
          </p>
          <Select label="Copy assignments from" value={carryFrom} onChange={(e) => setCarryFrom(e.target.value)}>
            <option value="">Select a sprint…</option>
            {(siblingSprints.data ?? [])
              .filter((s) => s.id !== sprintId)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setCarryOpen(false)}>Cancel</Button>
            <Button marker={false} disabled={busy || !carryFrom} onClick={() => void doCarry()}>
              {busy ? 'Copying…' : 'Carry forward'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
