import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import useSWR from 'swr'
import { Bug, FileDown, FileJson, Loader2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import type { Status } from '../../../components/ui/StatusBadge'
import { DonutChart } from '../../../components/charts/DonutChart'
import type { DonutSlice } from '../../../components/charts/DonutChart'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { api } from '../../../lib/api'
import type { ExecutionDetail } from '../../../lib/types'
import { normalizeExecutionReport } from '../../../features/report/reportTransform'
import type { NormalizedReport } from '../../../features/report/reportTransform'
import { generateReportPdf, generateReportJson } from '../../../features/report/reportExport'
import { ReportSection } from '../../../features/report/ReportSection'
import { SprintReleaseChips } from './components/SprintReleaseChips'
import { useToast } from '../../../contexts/ToastContext'
import { ExecutionSteps } from './components/ExecutionSteps'
import type { StepLog } from './components/ExecutionSteps'

/**
 * Renders the normalised report produced by the carried-over
 * `reportTransform.js`, and exports it through the carried-over
 * `reportExport.js` (jsPDF + autotable). Both files are the originals from the
 * previous frontend, so the PDF is byte-for-byte the same document.
 *
 * The AI report JSON lives in storage, not the database, so it is fetched
 * separately from the execution row and folded in. When that fetch fails the
 * transform still runs on execution telemetry alone.
 */
async function loadReport(runId: string): Promise<{
  execution: ExecutionDetail
  report: NormalizedReport | null
}> {
  const execution = await api.getRunDetails(runId)

  let aiReport: Record<string, unknown> | null = null
  const reportUrl = execution.reports?.[0]?.url
  if (reportUrl) {
    try {
      const response = await fetch(reportUrl)
      if (response.ok) aiReport = await response.json()
    } catch {
      // Storage unreachable - fall back to execution telemetry alone.
    }
  }

  return { execution, report: normalizeExecutionReport(execution, aiReport) }
}

function decisionStatus(decision: string | undefined): Status {
  const value = (decision ?? '').toUpperCase()
  if (value === 'PENDING') return 'running'
  if (value === 'APPROVED') return 'pass'
  if (value === 'BLOCKED') return 'fail'
  if (value === 'CONDITIONAL') return 'flaky'
  if (value.includes('GO') && !value.includes('NO')) return 'pass'
  if (value.includes('NO')) return 'fail'
  return 'flaky'
}

/** Maps a scenario's own status (as computed by reportTransform) onto the shared badge colours. */
function scenarioStatus(status: string | undefined): Status {
  const value = (status ?? '').toUpperCase()
  if (value === 'PASSED') return 'pass'
  if (value === 'FAILED') return 'fail'
  if (value === 'SKIPPED') return 'blocked'
  return 'flaky'
}

const RISK_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

const RISK_COLOR: Record<string, string> = {
  CRITICAL: 'var(--color-fail)',
  HIGH: 'var(--color-fail)',
  MEDIUM: 'var(--color-flaky)',
  LOW: 'var(--color-pass)',
}

const DISTRIBUTION_COLOR: Record<string, string> = {
  PASSED: 'var(--color-pass)',
  FAILED: 'var(--color-fail)',
  SKIPPED: 'var(--color-blocked)',
}

type ScenarioRow = {
  id: string
  name: string
  status: string
  risk: string
  durationMs: number
  healed: boolean
  totalSteps: number
  passedSteps: number
  failedSteps: number
}

export default function ExecutionReportPage() {
  const { id = '' } = useParams()
  const { triggerToast } = useToast()
  const [exporting, setExporting] = useState<'pdf' | 'json' | null>(null)
  const [filingBug, setFilingBug] = useState(false)

  const { data, error, isLoading, mutate } = useSWR(
    id ? ['execution-report', id] : null,
    () => loadReport(id),
  )

  const report = data?.report ?? null
  const execution = data?.execution

  const steps = useMemo<StepLog[]>(
    () => (Array.isArray(execution?.stepLogs) ? (execution.stepLogs as StepLog[]) : []),
    [execution],
  )

  useEffect(() => {
    document.title = report ? `Report · ${report.metadata.suiteName}` : 'Execution report'
    return () => {
      document.title = 'NovaTest AI'
    }
  }, [report])

  async function exportPdf() {
    if (!report) return
    setExporting('pdf')
    try {
      await generateReportPdf(report, { download: true })
      triggerToast('PDF report downloaded.')
    } catch (err) {
      triggerToast(`Export failed: ${(err as Error).message}`, true)
    } finally {
      setExporting(null)
    }
  }

  function exportJson() {
    if (!report) return
    setExporting('json')
    try {
      generateReportJson(report)
      triggerToast('Report JSON downloaded.')
    } catch (err) {
      triggerToast(`Export failed: ${(err as Error).message}`, true)
    } finally {
      setExporting(null)
    }
  }

  async function fileJiraBug() {
    setFilingBug(true)
    try {
      const issue = await api.createJiraBug(id)
      triggerToast(issue?.key ? `Filed ${issue.key} in Jira.` : 'Jira bug filed.')
      await mutate()
    } catch (err) {
      triggerToast(`Could not file bug: ${(err as Error).message}`, true)
    } finally {
      setFilingBug(false)
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load this report"
        description={(error as Error).message}
        action={
          <Button marker={false} onClick={() => void mutate()}>
            Try again
          </Button>
        }
      />
    )
  }

  if (isLoading || !data) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    )
  }

  if (!report) {
    return (
      <ErrorState
        title="Report unavailable"
        description="This execution has no telemetry to build a report from yet."
      />
    )
  }

  const { metadata, summary, quality, tests, timeline, releaseDecision, accessibility, security, ai, evidence } =
    report

  const scenarioRows = (tests ?? []) as ScenarioRow[]

  const distributionSlices: DonutSlice[] = ['PASSED', 'FAILED', 'SKIPPED']
    .map((status) => ({
      label: status.charAt(0) + status.slice(1).toLowerCase(),
      value: scenarioRows.filter((row) => (row.status ?? '').toUpperCase() === status).length,
      color: DISTRIBUTION_COLOR[status],
    }))
    .filter((slice) => slice.value > 0)

  const riskRows = RISK_ORDER.map((risk) => ({
    risk,
    scenarios: scenarioRows.filter((row) => (row.risk ?? '').toUpperCase() === risk),
  })).filter((row) => row.scenarios.length > 0)

  const scenarioColumns: DataTableColumn<ScenarioRow>[] = [
    {
      key: 'name',
      header: 'Scenario',
      sortAccessor: (row) => row.name,
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortAccessor: (row) => row.status,
      render: (row) => <StatusBadge status={scenarioStatus(row.status)} label={row.status} />,
    },
    {
      key: 'risk',
      header: 'Risk',
      sortAccessor: (row) => row.risk,
      render: (row) => <span className="font-mono text-xs">{row.risk}</span>,
    },
    {
      key: 'steps',
      header: 'Steps',
      align: 'right',
      render: (row) => (
        <span className="font-mono text-xs">
          {row.passedSteps ?? 0}/{row.totalSteps ?? 0}
        </span>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      sortAccessor: (row) => row.durationMs ?? 0,
      render: (row) => (
        <span className="font-mono text-xs">{((row.durationMs ?? 0) / 1000).toFixed(1)}s</span>
      ),
    },
    {
      key: 'healed',
      header: 'Healed',
      render: (row) => (row.healed ? <span className="text-healing">Yes</span> : <span className="text-muted">—</span>),
    },
  ]

  return (
    <div className="mx-auto max-w-4xl">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-wide text-muted uppercase">Execution report</p>
          <h1 className="mt-1 font-serif text-2xl break-words text-ink">{metadata.suiteName}</h1>
          <p className="mt-1.5 font-mono text-xs text-muted">
            {metadata.runNumber} · {metadata.browser} · {metadata.environment} ·{' '}
            {metadata.durationFormatted} · {metadata.createdAtFormatted}
          </p>
          {metadata.targetUrl && (
            <p className="mt-0.5 font-mono text-xs break-all text-muted">{metadata.targetUrl}</p>
          )}
          {(execution?.sprintId || execution?.releaseId) && (
            <p className="mt-1.5">
              <SprintReleaseChips sprintId={execution?.sprintId} releaseId={execution?.releaseId} />
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="outline" marker={false} onClick={() => void exportPdf()} disabled={exporting !== null}>
            {exporting === 'pdf' ? (
              <Loader2 size={15} aria-hidden="true" className="animate-spin" />
            ) : (
              <FileDown size={15} aria-hidden="true" />
            )}
            Export PDF
          </Button>
          <Button variant="outline" marker={false} onClick={exportJson} disabled={exporting !== null}>
            <FileJson size={15} aria-hidden="true" />
            Export JSON
          </Button>
          {metadata.jiraTicketUrl ? (
            <Button href={metadata.jiraTicketUrl as string} variant="outline" marker={false}>
              <Bug size={15} aria-hidden="true" />
              {metadata.jiraTicketId as string}
            </Button>
          ) : (
            <Button marker={false} onClick={() => void fileJiraBug()} disabled={filingBug}>
              <Bug size={15} aria-hidden="true" />
              {filingBug ? 'Filing…' : 'File Jira bug'}
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Scenarios" value={summary.totalTests ?? 0} />
        <StatTile label="Passed" value={summary.passedCount ?? 0} />
        <StatTile label="Failed" value={summary.failedCount ?? 0} />
        <StatTile label="Skipped" value={summary.skippedCount ?? 0} />
        <StatTile label="Pass rate" value={summary.passRate ?? 0} unit="%" />
        <StatTile label="Self-healed" value={summary.selfHealedCount ?? 0} />
      </div>

      {execution?.triggeredBy === 'jira' && execution?.jiraSourceIssueKey && (
        <ReportSection title="Raised from Jira">
          <Card className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-deep">
                <Bug size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  <span className="font-mono text-xs text-muted">{execution.jiraSourceIssueKey}</span>
                  {execution.jiraSourceReporter ? ` · raised by ${execution.jiraSourceReporter}` : ''}
                </p>
                {execution.jiraSourceSummary && (
                  <p className="mt-1 text-sm font-medium break-words text-ink">{execution.jiraSourceSummary}</p>
                )}
                <p className="mt-2 text-xs text-muted">
                  This run was generated automatically from the Jira bug above and its linked user stories.
                </p>
                {execution.jiraResultCommentUrl && (
                  <a
                    href={execution.jiraResultCommentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                  >
                    <Bug size={12} aria-hidden="true" />
                    Result posted back to Jira
                  </a>
                )}
              </div>
            </div>
          </Card>
        </ReportSection>
      )}

      <ReportSection title="Quality scorecard">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Functional" value={quality?.functionalScore ?? 'N/A'} unit={quality?.functionalScore != null ? '%' : ''} />
          <StatTile label="Accessibility" value={quality?.a11yScore ?? 'N/A'} unit={quality?.a11yScore != null ? '%' : ''} />
          <StatTile label="Security" value={quality?.secScore ?? 'N/A'} unit={quality?.secScore != null ? '%' : ''} />
          <StatTile label="DOM stability" value={quality?.stabilityScore ?? 'N/A'} unit={quality?.stabilityScore != null ? '%' : ''} />
        </div>
      </ReportSection>

      {distributionSlices.length > 0 && (
        <ReportSection title="Test result distribution">
          <Card className="flex flex-col items-center gap-4 p-5 sm:flex-row sm:items-start">
            <DonutChart
              data={distributionSlices}
              size={140}
              centerValue={scenarioRows.length}
              centerLabel="scenarios"
            />
            <ul className="flex-1 space-y-1.5">
              {distributionSlices.map((slice) => (
                <li key={slice.label} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: slice.color }}
                  />
                  <span className="flex-1 text-ink-soft">{slice.label}</span>
                  <span className="font-mono text-xs text-ink">{slice.value}</span>
                </li>
              ))}
            </ul>
          </Card>
        </ReportSection>
      )}

      <ReportSection title="Release decision">
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge
              status={decisionStatus(releaseDecision.decision)}
              label={releaseDecision.decision ?? 'Unknown'}
            />
            <span className="font-mono text-xs text-muted">
              Risk: {releaseDecision.riskLevel ?? 'UNKNOWN'}
            </span>
            {releaseDecision.healthScore != null && (
              <span className="font-mono text-xs text-muted">
                Health: {releaseDecision.healthScore}
              </span>
            )}
          </div>
          {releaseDecision.title && (
            <p className="mt-3 text-sm font-medium text-ink">{releaseDecision.title}</p>
          )}
          {Array.isArray(releaseDecision.reasons) && releaseDecision.reasons.length > 0 && (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-soft">
              {releaseDecision.reasons.map((reason: string, index: number) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
        </Card>
      </ReportSection>

      <ReportSection title="Summary">
        <Card className="p-5">
          <p className="text-sm whitespace-pre-wrap text-ink-soft">
            {ai.narrative || summary.aiSummaryText || 'No summary was generated for this run.'}
          </p>
          {Array.isArray(summary.validationResults) && summary.validationResults.length > 0 && (
            <ul className="mt-4 flex list-disc flex-col gap-1 border-t border-line pt-4 pl-5 text-sm text-ink-soft">
              {summary.validationResults.map((item: string, index: number) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </Card>
      </ReportSection>

      {scenarioRows.length > 0 && (
        <ReportSection title="Test scenarios execution results">
          <div className="rounded-md border border-line bg-paper-alt">
            <DataTable columns={scenarioColumns} rows={scenarioRows} getRowKey={(row) => row.id} />
          </div>
        </ReportSection>
      )}

      {Array.isArray(timeline) && timeline.length > 0 && (
        <ReportSection title="Execution timeline">
          <ol className="flex flex-col gap-1.5">
            {timeline.slice(0, 300).map((event: Record<string, any>, index: number) => (
              <li
                key={index}
                className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border px-3 py-2 text-sm ${
                  (event.status ?? '').toUpperCase() === 'FAILED'
                    ? 'border-fail/30 bg-fail/5'
                    : 'border-line bg-paper-alt'
                }`}
              >
                <span className="font-mono text-xs text-muted">{event.timestamp ?? '—'}</span>
                <span className="font-medium text-ink">{event.action ?? 'step'}</span>
                {event.target && (
                  <span className="min-w-0 truncate font-mono text-xs text-ink-soft">{event.target}</span>
                )}
                {event.scenarioName && (
                  <span className="ml-auto font-mono text-xs text-muted">{event.scenarioName}</span>
                )}
              </li>
            ))}
          </ol>
          {timeline.length > 300 && (
            <p className="mt-2 font-mono text-xs text-muted">
              Showing the first 300 of {timeline.length} events. Full detail is in Export JSON.
            </p>
          )}
        </ReportSection>
      )}

      <ReportSection title="Accessibility & security">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <h3 className="font-sans text-sm font-semibold text-ink">Accessibility</h3>
            <p className="mt-1 font-mono text-xs text-muted">
              {accessibility.evaluated ? (accessibility.label ?? accessibility.status) : 'Not evaluated'}
            </p>
            {Array.isArray(accessibility.violations) && accessibility.violations.length > 0 && (
              <p className="mt-2 text-sm text-fail">
                {accessibility.violations.length} violation
                {accessibility.violations.length === 1 ? '' : 's'} found
              </p>
            )}
          </Card>
          <Card className="p-5">
            <h3 className="font-sans text-sm font-semibold text-ink">Security sanity</h3>
            <p className="mt-1 font-mono text-xs text-muted">
              {security.evaluated ? (security.label ?? security.status) : 'Not evaluated'}
            </p>
            {security.scope && <p className="mt-2 text-xs text-ink-soft">{security.scope}</p>}
          </Card>
        </div>
      </ReportSection>

      {Array.isArray(ai.observations) && ai.observations.length > 0 && (
        <ReportSection title="Observations">
          <ul className="flex flex-col gap-2">
            {ai.observations.map((observation: Record<string, string>, index: number) => (
              <li key={index} className="rounded-md border border-line bg-paper-alt p-3">
                <p className="font-mono text-xs tracking-wide text-muted uppercase">
                  {observation.type}
                </p>
                <p className="mt-0.5 text-sm font-medium text-ink">{observation.title}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{observation.description}</p>
              </li>
            ))}
          </ul>
        </ReportSection>
      )}

      {Array.isArray(ai.recommendations) && ai.recommendations.length > 0 && (
        <ReportSection title="Recommended actions">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-soft">
            {ai.recommendations.map((recommendation: string, index: number) => (
              <li key={index}>{recommendation}</li>
            ))}
          </ul>
        </ReportSection>
      )}

      {riskRows.length > 0 && (
        <ReportSection title="Release risk matrix">
          <div className="flex flex-col gap-2">
            {riskRows.map((row) => (
              <div key={row.risk} className="rounded-md border border-line bg-paper-alt p-3">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: RISK_COLOR[row.risk] }}
                  />
                  <span className="font-mono text-xs font-medium tracking-wide text-ink uppercase">
                    {row.risk}
                  </span>
                  <span className="ml-auto font-mono text-xs text-muted">
                    {row.scenarios.length} scenario{row.scenarios.length === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-ink-soft">
                  {row.scenarios.map((s) => s.name).join(', ')}
                </p>
              </div>
            ))}
          </div>
        </ReportSection>
      )}

      <ReportSection title="Steps">
        <ExecutionSteps steps={steps} />
      </ReportSection>

      <ReportSection title="Technical appendix">
        <Card className="p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Execution ID</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-ink">{metadata.id}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Raw status</dt>
              <dd className="mt-0.5 text-ink">{metadata.rawStatus}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Execution type</dt>
              <dd className="mt-0.5 text-ink">{metadata.executionType}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Started</dt>
              <dd className="mt-0.5 text-ink">
                {report.technical?.rawExecution?.startedAt
                  ? new Date(report.technical.rawExecution.startedAt).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Completed</dt>
              <dd className="mt-0.5 text-ink">
                {report.technical?.rawExecution?.completedAt
                  ? new Date(report.technical.rawExecution.completedAt).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Recorded steps</dt>
              <dd className="mt-0.5 text-ink">
                {Array.isArray(report.technical?.stepLogs) ? report.technical.stepLogs.length : 0}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Plan data</dt>
              <dd className="mt-0.5 text-ink">{report.technical?.planData ? 'Recorded' : 'Not recorded'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Trace data</dt>
              <dd className="mt-0.5 text-ink">{report.technical?.traceData ? 'Recorded' : 'Not recorded'}</dd>
            </div>
            {metadata.jiraTicketId != null && (
              <div>
                <dt className="font-mono text-xs text-muted uppercase">Jira ticket</dt>
                <dd className="mt-0.5 text-ink">{metadata.jiraTicketId as string}</dd>
              </div>
            )}
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
            Full raw logs and step-level detail are available via Export JSON, or on this
            execution's Trace &amp; Plan tab.
          </p>
        </Card>
      </ReportSection>

      {((Array.isArray(evidence.videos) && evidence.videos.length > 0) ||
        (Array.isArray(evidence.screenshots) && evidence.screenshots.length > 0)) && (
        <ReportSection title="Evidence">
          {Array.isArray(evidence.videos) && evidence.videos.length > 0 && (
            <div className="mb-4">
              {/* Backend returns videos newest-first; the first row is the
                  finalized recording (idle LLM-wait time already trimmed). */}
              <video
                src={evidence.videos[0].url}
                controls
                preload="metadata"
                className="w-full rounded-md border border-line bg-ink"
              />
              <a
                href={evidence.videos[0].url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block font-mono text-xs text-muted hover:text-accent"
              >
                Open recording in new tab
                {evidence.videos[0].durationFormatted
                  ? ` · run ${evidence.videos[0].durationFormatted}`
                  : ''}
              </a>
            </div>
          )}
          {Array.isArray(evidence.screenshots) && evidence.screenshots.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {evidence.screenshots.map((shot: { id?: string; url: string }, index: number) => (
                <a
                  key={shot.id ?? index}
                  href={shot.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="overflow-hidden rounded-md border border-line hover:border-accent"
                >
                  <img src={shot.url} alt={`Evidence ${index + 1}`} className="w-full" />
                </a>
              ))}
            </div>
          )}
        </ReportSection>
      )}
    </div>
  )
}
