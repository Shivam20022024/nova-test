import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { FileDown, FileJson, ListPlus, Loader2, Pencil, Play, GitBranch, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { PageHeader } from '../../../components/ui/PageHeader'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { Sprint, SprintResults, SprintStatus, TestCase } from '../../../lib/types'
import { downloadSprintReportPdf, downloadSprintReportJson } from '../../../features/report/hierarchicalReportExport'
import { AggregatedStatusBadge, AssignmentSourceBadge, SprintStatusBadge } from './statusBadges'

type Row = SprintResults['testCases'][number]

const SPRINT_STATUSES: SprintStatus[] = ['PLANNED', 'ACTIVE', 'CLOSED']

export default function SprintDetailPage() {
  const { releaseId = '', sprintId = '' } = useParams()
  const { triggerToast } = useToast()
  const [assignOpen, setAssignOpen] = useState(false)
  const [carryOpen, setCarryOpen] = useState(false)
  const [carryFrom, setCarryFrom] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState<'pdf' | 'json' | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editSequence, setEditSequence] = useState('')
  const [editStatus, setEditStatus] = useState<SprintStatus>('PLANNED')
  const [editStartDate, setEditStartDate] = useState('')
  const [editEndDate, setEditEndDate] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

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

  async function exportPdf() {
    setExporting('pdf')
    try {
      await downloadSprintReportPdf(sprintId)
      triggerToast('Sprint report downloaded.')
    } catch (err) {
      triggerToast(`Export failed: ${(err as Error).message}`, true)
    } finally {
      setExporting(null)
    }
  }

  async function exportJson() {
    setExporting('json')
    try {
      await downloadSprintReportJson(sprintId)
    } catch (err) {
      triggerToast(`Export failed: ${(err as Error).message}`, true)
    } finally {
      setExporting(null)
    }
  }

  function openEdit() {
    if (!d) return
    setEditName(d.sprint.name)
    setEditSequence(d.sprint.sequence != null ? String(d.sprint.sequence) : '')
    setEditStatus(d.sprint.status)
    setEditStartDate(d.sprint.startDate ? d.sprint.startDate.slice(0, 10) : '')
    setEditEndDate(d.sprint.endDate ? d.sprint.endDate.slice(0, 10) : '')
    setEditError(null)
    setEditOpen(true)
  }

  async function saveEdit() {
    if (!editName.trim()) {
      setEditError('Enter a sprint name.')
      return
    }
    setSavingEdit(true)
    try {
      await api.updateSprint(sprintId, {
        name: editName.trim(),
        sequence: editSequence.trim() ? Number(editSequence) : undefined,
        status: editStatus,
        startDate: editStartDate || undefined,
        endDate: editEndDate || undefined,
      })
      await refresh()
      setEditOpen(false)
      triggerToast('Sprint updated.')
    } catch (err) {
      setEditError((err as Error).message)
    } finally {
      setSavingEdit(false)
    }
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
            <Button variant="outline" marker={false} onClick={() => void exportPdf()} disabled={exporting !== null}>
              {exporting === 'pdf' ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <FileDown size={14} aria-hidden="true" />}
              Download Report
            </Button>
            <Button variant="outline" marker={false} onClick={() => void exportJson()} disabled={exporting !== null}>
              {exporting === 'json' ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <FileJson size={14} aria-hidden="true" />}
              Download JSON
            </Button>
            <Button variant="outline" marker={false} onClick={openEdit} disabled={!d}>
              <Pencil size={14} aria-hidden="true" /> Edit
            </Button>
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

      {/* Mobile runs — Appium-engine tests generated/run against this sprint.
          The mobile engine has no SprintTestCase-style assignment, so every
          run here is tagged only via mobile_executions.sprint_uuid. */}
      {d && d.mobileRuns.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 font-sans text-sm font-semibold text-ink">Mobile runs</h2>
          <p className="mb-3 text-xs text-muted">
            Appium/mobile executions generated or run against this sprint —{' '}
            <span className="font-mono">{d.mobileSummary.passed}</span> passed ·{' '}
            <span className="font-mono">{d.mobileSummary.failed}</span> failed ·{' '}
            <span className="font-mono">{d.mobileSummary.review}</span> needs review of{' '}
            <span className="font-mono">{d.mobileSummary.total}</span>.
          </p>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {d.mobileRuns.map((r) => (
                <li key={r.executionId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <AggregatedStatusBadge status={
                    r.status === 'PASSED' ? 'PASSED'
                    : /(FAILED|INFRA_FAILURE|TIMEOUT|BLOCKED)/.test(r.status) ? 'FAILED'
                    : /(QUEUED|RUNNING|HEALING|RETRYING|ALLOCATING|STARTING|WAITING|CLEANUP|CREATED)/.test(r.status) ? 'RUNNING'
                    : 'SKIPPED'
                  } />
                  <span className="min-w-0 flex-1 truncate text-ink">{r.testName || `Execution ${r.executionId}`}</span>
                  <span className="font-mono text-xs text-muted">
                    {r.status} · {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </span>
                  <Link to={r.reportPath} className="font-mono text-xs text-accent hover:underline">Report</Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* API runs — same "no assignment, every run is ad hoc" reasoning as
          mobile above, tagged via ApiExecution.sprintId. */}
      {d && d.apiRuns.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 font-sans text-sm font-semibold text-ink">API runs</h2>
          <p className="mb-3 text-xs text-muted">
            API tests run against this sprint —{' '}
            <span className="font-mono">{d.apiSummary.passed}</span> passed ·{' '}
            <span className="font-mono">{d.apiSummary.failed}</span> failed of{' '}
            <span className="font-mono">{d.apiSummary.total}</span>.
          </p>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {d.apiRuns.map((r) => (
                <li key={r.executionId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <AggregatedStatusBadge status={r.status === 'PASSED' ? 'PASSED' : r.status === 'FAILED' ? 'FAILED' : 'RUNNING'} />
                  <span className="min-w-0 flex-1 truncate text-ink">{r.testName || `Execution ${r.executionId}`}</span>
                  <span className="font-mono text-xs text-muted">
                    {r.status} · {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </span>
                  <Link to={r.reportPath} className="font-mono text-xs text-accent hover:underline">Report</Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* Database runs — tagged via DbTestExecution.sprintId. */}
      {d && d.dbRuns.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 font-sans text-sm font-semibold text-ink">Database runs</h2>
          <p className="mb-3 text-xs text-muted">
            Database tests run against this sprint —{' '}
            <span className="font-mono">{d.dbSummary.passed}</span> passed ·{' '}
            <span className="font-mono">{d.dbSummary.failed}</span> failed of{' '}
            <span className="font-mono">{d.dbSummary.total}</span>.
          </p>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {d.dbRuns.map((r) => (
                <li key={r.executionId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <AggregatedStatusBadge status={r.status === 'PASSED' ? 'PASSED' : r.status === 'FAILED' ? 'FAILED' : 'RUNNING'} />
                  <span className="min-w-0 flex-1 truncate text-ink">{r.testName || `Execution ${r.executionId}`}</span>
                  <span className="font-mono text-xs text-muted">
                    {r.status} · {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </span>
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

      {/* Edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit sprint">
        <div className="flex flex-col gap-3">
          <Input label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} error={editError ?? undefined} />
          <Select label="Status" value={editStatus} onChange={(e) => setEditStatus(e.target.value as SprintStatus)}>
            {SPRINT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Sequence" type="number" value={editSequence} onChange={(e) => setEditSequence(e.target.value)} />
            <Input label="Start date" type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} />
            <Input label="End date" type="date" value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button marker={false} disabled={savingEdit} onClick={() => void saveEdit()}>
              {savingEdit ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
