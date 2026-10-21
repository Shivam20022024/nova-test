import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { ArrowLeft, Bug, FileJson, FileDown, Loader2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import type { Status } from '../../../components/ui/StatusBadge'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { ApiDbStepLog } from '../../../lib/types'
import { ReportSection } from '../../../features/report/ReportSection'
import { downloadApiReportPdf, downloadApiReportJson } from '../../../features/report/apiReportExport'
import { apiDbQualityScorecard, buildApiExecutiveSummary } from '../../../features/report/apiDbReportData'

const STATUS_MAP: Record<string, Status> = { QUEUED: 'blocked', RUNNING: 'running', PASSED: 'pass', FAILED: 'fail' }

const STEP_COLUMNS: DataTableColumn<ApiDbStepLog>[] = [
  { key: 'action', header: 'Action', render: (row) => <span className="font-mono text-sm text-ink">{row.action}</span> },
  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={STATUS_MAP[row.status] ?? 'blocked'} label={row.status} /> },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    sortAccessor: (row) => row.durationMs ?? 0,
    render: (row) => <span className="font-mono text-xs text-ink-soft">{row.durationMs != null ? `${row.durationMs}ms` : '—'}</span>,
  },
  {
    key: 'detail',
    header: 'Detail',
    render: (row) => <span className="block max-w-md break-words font-mono text-xs text-ink-soft">{row.details || row.value || '—'}</span>,
  },
]

/**
 * API Testing's equivalent of Web/Mobile's execution report page — same
 * section structure (release decision, executive summary, quality
 * scorecard, results table, technical appendix), so the three report types
 * read as one product's output. No AI narrative (API testing has none): the
 * executive summary is deterministic, built from real telemetry, exactly
 * like the mobile report's own summary.
 */
export default function ApiExecutionReportPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { triggerToast } = useToast()
  const [exporting, setExporting] = useState<'pdf' | 'json' | null>(null)
  const [filing, setFiling] = useState(false)

  const { data, error, isLoading, mutate } = useSWR(id ? ['api-execution-report', id] : null, () => api.apiTesting.getExecution(id))

  async function exportPdf() {
    if (!data) return
    setExporting('pdf')
    try {
      await downloadApiReportPdf(data)
      triggerToast('PDF report downloaded.')
    } catch (err) {
      triggerToast(`Export failed: ${(err as Error).message}`, true)
    } finally {
      setExporting(null)
    }
  }

  function exportJson() {
    if (!data) return
    downloadApiReportJson(data)
  }

  async function fileJiraBug() {
    if (!id) return
    setFiling(true)
    try {
      await api.apiTesting.createJiraBug(id)
      triggerToast('Jira bug filed.')
      await mutate()
    } catch (err) {
      triggerToast(`Could not file bug: ${(err as Error).message}`, true)
    } finally {
      setFiling(false)
    }
  }

  const backAction = (
    <Button variant="outline" marker={false} onClick={() => navigate('/app/api-testing/executions')}>
      <ArrowLeft size={14} aria-hidden="true" />
      Back to Executions
    </Button>
  )

  if (error) {
    return (
      <div>
        <PageHeader title="API Execution Report" actions={backAction} />
        <ErrorState title="Could not load this execution" description={(error as Error).message} action={<Button marker={false} onClick={() => void mutate()}>Try again</Button>} />
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    )
  }

  const steps = data.stepLogs ?? []
  const isPassed = data.status === 'PASSED'
  const failedStep = steps.find((s) => s.status === 'FAILED')
  const summaryText = buildApiExecutiveSummary(data)
  const scorecard = apiDbQualityScorecard(steps)

  const decisionPalette = isPassed
    ? { border: 'var(--color-pass)', bg: 'color-mix(in srgb, var(--color-pass) 7%, transparent)' }
    : { border: 'var(--color-fail)', bg: 'color-mix(in srgb, var(--color-fail) 7%, transparent)' }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-wide text-muted uppercase">API execution report</p>
          <h1 className="mt-1 font-serif text-2xl break-words text-ink">{data.name}</h1>
          <p className="mt-1.5 font-mono text-xs text-muted">
            Execution #{data.id} · {data.durationMs != null ? `${(data.durationMs / 1000).toFixed(1)}s` : 'in progress'} ·{' '}
            {data.startedAt ? new Date(data.startedAt).toLocaleString() : 'not started'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 print:hidden">
          {backAction}
          <Button variant="outline" marker={false} onClick={exportJson}>
            <FileJson size={14} aria-hidden="true" /> JSON
          </Button>
          <Button variant="outline" marker={false} onClick={() => void exportPdf()} disabled={exporting !== null}>
            {exporting === 'pdf' ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <FileDown size={14} aria-hidden="true" />}
            PDF
          </Button>
          {data.jiraTicketUrl ? (
            <Button href={data.jiraTicketUrl} variant="outline" marker={false}>
              <Bug size={15} aria-hidden="true" /> {data.jiraTicketId}
            </Button>
          ) : (
            <Button marker={false} onClick={() => void fileJiraBug()} disabled={filing}>
              <Bug size={15} aria-hidden="true" /> {filing ? 'Filing…' : 'File Jira bug'}
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Status" value={data.status} />
        <StatTile label="Duration" value={data.durationMs != null ? `${(data.durationMs / 1000).toFixed(1)}s` : '—'} />
        <StatTile label="Steps" value={`${steps.filter((s) => s.status === 'PASSED').length}/${steps.length}`} />
        <StatTile label="Requests" value={data.steps.length} />
        <StatTile label="Started" value={data.startedAt ? new Date(data.startedAt).toLocaleTimeString() : '—'} />
      </div>

      <ReportSection title="Release decision">
        <Card className="p-5" style={{ borderColor: decisionPalette.border, backgroundColor: decisionPalette.bg }}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={isPassed ? 'pass' : 'fail'} label={isPassed ? 'PASSED' : data.status} />
            <span className="font-mono text-xs text-muted">
              Step pass rate: {scorecard.stepPassRate}%
              {scorecard.assertionPassRate != null && ` · Assertion pass rate: ${scorecard.assertionPassRate}%`}
            </span>
          </div>
          {!isPassed && failedStep && (
            <p className="mt-3 text-sm font-medium text-ink">
              Failed while executing "{failedStep.action}"{failedStep.details ? `: ${failedStep.details}` : '.'}
            </p>
          )}
          {!isPassed && data.error && <p className="mt-3 text-sm text-fail">{data.error}</p>}
        </Card>
      </ReportSection>

      <ReportSection title="Executive summary">
        <Card className="p-5">
          <p className="text-sm whitespace-pre-wrap text-ink-soft">{summaryText}</p>
        </Card>
      </ReportSection>

      <ReportSection title="Quality scorecard">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatTile label="Step pass rate" value={scorecard.stepPassRate} unit="%" />
          <StatTile label="Assertion pass rate" value={scorecard.assertionPassRate ?? 'N/A'} unit={scorecard.assertionPassRate != null ? '%' : ''} />
        </div>
      </ReportSection>

      <ReportSection title="Request definition">
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-line">
            {data.steps.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="rounded-sm bg-selected px-1.5 py-0.5 font-mono text-xs font-medium text-accent-deep">{s.method}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{s.url}</span>
                {s.assertions && s.assertions.length > 0 && (
                  <span className="font-mono text-xs text-muted">{s.assertions.length} assertion{s.assertions.length === 1 ? '' : 's'}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </ReportSection>

      {steps.length > 0 && (
        <ReportSection title="Step-by-step execution">
          <div className="rounded-md border border-line bg-paper-alt">
            <DataTable columns={STEP_COLUMNS} rows={steps} getRowKey={(row) => `${row.action}-${row.time}`} />
          </div>
        </ReportSection>
      )}

      <ReportSection title="Technical appendix">
        <Card className="p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Execution ID</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-ink">{data.id}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Raw status</dt>
              <dd className="mt-0.5 text-ink">{data.status}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Started</dt>
              <dd className="mt-0.5 text-ink">{data.startedAt ? new Date(data.startedAt).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Completed</dt>
              <dd className="mt-0.5 text-ink">{data.completedAt ? new Date(data.completedAt).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Recorded steps</dt>
              <dd className="mt-0.5 text-ink">{steps.length}</dd>
            </div>
            {data.jiraTicketUrl && (
              <div>
                <dt className="font-mono text-xs text-muted uppercase">Jira ticket</dt>
                <dd className="mt-0.5 text-ink">
                  <a href={data.jiraTicketUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                    View ticket
                  </a>
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
            Full raw request/response detail is available via Export JSON.
          </p>
        </Card>
      </ReportSection>
    </div>
  )
}
