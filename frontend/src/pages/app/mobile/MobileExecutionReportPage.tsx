import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Download, FileJson, Image as ImageIcon } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { api } from '../../../lib/api'
import { useToast } from '../../../contexts/ToastContext'
import { ReportSection } from '../../../features/report/ReportSection'
import type {
  MobileApplication,
  MobileDevice,
  MobileEvidenceItem,
  MobileExecution,
  MobileHealingRecord,
  MobileStepResult,
  MobileTest,
} from '../../../lib/types'
import { downloadMobileReportJson, downloadMobileReportPdf } from '../../../features/report/mobileReportExport'
import { buildMobileExecutiveSummary, mobileQualityScorecard } from '../../../features/report/mobileReportData'
import { formatDuration, formatWhen, statusLabel, toStatus } from './mobileStatus'

type ReportBundle = {
  execution: MobileExecution
  test: MobileTest | null
  application: MobileApplication | null
  device: MobileDevice | null
  evidence: MobileEvidenceItem[]
  healing: MobileHealingRecord[]
}

async function loadReport(executionId: number): Promise<ReportBundle> {
  const execution = await api.mobile.getExecution(executionId)
  const [test, evidence, healing, devices] = await Promise.all([
    api.mobile.getTest(execution.test_id).catch(() => null),
    api.mobile.getExecutionEvidence(executionId).catch(() => []),
    api.mobile.getHealingHistory({ execution_id: executionId }).catch(() => []),
    api.mobile.listDevices().catch(() => []),
  ])
  const application = test?.application_id != null ? await api.mobile.getApplication(test.application_id).catch(() => null) : null
  const device = devices.find((d) => d.id === execution.device_id) ?? null
  return { execution, test, application, device, evidence, healing }
}

const STEP_COLUMNS: DataTableColumn<MobileStepResult>[] = [
  {
    key: 'step_index',
    header: 'Step',
    sortAccessor: (row) => row.step_index,
    render: (row) => <span className="font-mono text-xs text-muted">{row.step_index}</span>,
  },
  {
    key: 'action',
    header: 'Action',
    sortAccessor: (row) => row.action,
    render: (row) => <span className="font-mono text-sm text-ink">{row.action}</span>,
  },
  {
    key: 'locator',
    header: 'Locator',
    render: (row) => (
      <span className="block max-w-xs truncate font-mono text-xs text-ink-soft">
        {row.resolved_locator?.value ?? row.locator?.value ?? '—'}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortAccessor: (row) => row.status,
    render: (row) => <StatusBadge status={toStatus(row.status)} label={row.status} />,
  },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    sortAccessor: (row) => row.duration_ms ?? 0,
    render: (row) => <span className="font-mono text-xs text-ink-soft">{formatDuration(row.duration_ms)}</span>,
  },
]

const HEALING_COLUMNS: DataTableColumn<MobileHealingRecord>[] = [
  {
    key: 'step_index',
    header: 'Step',
    sortAccessor: (row) => row.step_index,
    render: (row) => <span className="font-mono text-xs text-muted">{row.step_index}</span>,
  },
  {
    key: 'original',
    header: 'Original locator',
    render: (row) => (
      <span className="block max-w-xs truncate font-mono text-xs text-fail">{row.original_locator?.value ?? '—'}</span>
    ),
  },
  {
    key: 'replacement',
    header: 'Replacement',
    render: (row) => (
      <span className="block max-w-xs truncate font-mono text-xs text-pass">
        {row.replacement_locator?.value ?? row.candidate_locators?.[0]?.locator?.value ?? '—'}
      </span>
    ),
  },
  {
    key: 'confidence',
    header: 'Confidence',
    align: 'right',
    sortAccessor: (row) => row.confidence ?? 0,
    render: (row) => <span className="font-mono text-xs text-ink-soft">{row.confidence != null ? `${Math.round(row.confidence)}%` : '—'}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <span className="font-mono text-xs text-ink-soft">{row.status.toLowerCase()}</span>,
  },
]

/**
 * The mobile equivalent of Web Testing's ExecutionReportPage — same section
 * structure (executive summary, quality scorecard, results table, evidence,
 * technical appendix), so the two report types read as one product's output
 * rather than a rich one and a thin one. No AI narrative like the web
 * report's (the mobile engine doesn't generate one): the executive summary
 * here is deterministic, built from real telemetry, exactly like the web
 * report's own fallback when no AI summary exists.
 */
export default function MobileExecutionReportPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { triggerToast } = useToast()
  const executionId = Number(id)

  const [data, setData] = useState<ReportBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filing, setFiling] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadReport(executionId)
      .then((bundle) => {
        if (!cancelled) {
          setData(bundle)
          setError(null)
        }
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [executionId])

  async function fileJiraBug() {
    setFiling(true)
    try {
      const result = await api.mobile.createJiraBug(executionId)
      triggerToast('Jira bug filed.')
      setData((prev) =>
        prev
          ? { ...prev, execution: { ...prev.execution, result_json: { ...(prev.execution.result_json || {}), jira: { ticketUrl: result.ticketUrl } } } }
          : prev,
      )
    } catch (err) {
      triggerToast(`Could not file a Jira bug: ${(err as Error).message}`, true)
    } finally {
      setFiling(false)
    }
  }

  const backAction = (
    <Button variant="outline" marker={false} onClick={() => navigate('/app/mobile/executions')}>
      <ArrowLeft size={14} aria-hidden="true" />
      Back to Executions
    </Button>
  )

  if (loading) {
    return (
      <div>
        <PageHeader title="Execution report" actions={backAction} />
        <Card className="p-6">
          <Skeleton className="h-6 w-64" />
          <div className="mt-5 flex flex-col gap-3">
            <Skeleton className="h-40 w-full" />
          </div>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Execution report" actions={backAction} />
        <ErrorState title="Could not load this execution" description={error ?? 'Unknown error.'} />
      </div>
    )
  }

  const { execution, test, application, device, evidence, healing } = data
  const steps = execution.step_results ?? []
  const screenshots = evidence.filter((e) => e.artifact_type === 'SCREENSHOT')
  const video = evidence.find((e) => e.artifact_type === 'VIDEO')
  const title = test?.name ?? `Execution #${execution.id}`
  const jiraUrl = (execution.result_json as { jira?: { ticketUrl?: string } } | null | undefined)?.jira?.ticketUrl
  const isPassed = execution.status === 'PASSED'
  const failedStep = steps.find((s) => s.status === 'FAILED' || s.status === 'BLOCKED')

  const summaryText = buildMobileExecutiveSummary({ execution, test, application, device, steps, healing })
  const scorecard = mobileQualityScorecard({ steps, healing, evidence })

  const decisionPalette = isPassed
    ? { border: 'var(--color-pass)', bg: 'color-mix(in srgb, var(--color-pass) 7%, transparent)' }
    : { border: 'var(--color-fail)', bg: 'color-mix(in srgb, var(--color-fail) 7%, transparent)' }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-wide text-muted uppercase">Mobile execution report</p>
          <h1 className="mt-1 font-serif text-2xl break-words text-ink">{title}</h1>
          <p className="mt-1.5 font-mono text-xs text-muted">
            Execution #{execution.id} · {application?.package_name ?? 'unknown app'} ·{' '}
            {device?.model ?? device?.serial ?? 'unknown device'} · {formatDuration(execution.duration_ms)} ·{' '}
            {formatWhen(execution.started_at)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 print:hidden">
          {backAction}
          <Button variant="outline" marker={false} onClick={() => downloadMobileReportJson(data)}>
            <FileJson size={14} aria-hidden="true" />
            JSON
          </Button>
          <Button variant="outline" marker={false} onClick={() => downloadMobileReportPdf(data)}>
            <Download size={14} aria-hidden="true" />
            PDF
          </Button>
          {jiraUrl ? (
            <Button variant="outline" marker={false} href={jiraUrl}>
              View Jira bug
            </Button>
          ) : (
            <Button marker={false} disabled={filing} onClick={() => void fileJiraBug()}>
              {filing ? 'Filing…' : 'File Jira bug'}
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Status" value={statusLabel(execution.status)} />
        <StatTile label="Duration" value={formatDuration(execution.duration_ms)} />
        <StatTile label="Steps" value={`${steps.filter((s) => s.status === 'PASSED' || s.status === 'HEALED' || s.status === 'FALLBACK_RESOLVED').length}/${steps.length}`} />
        <StatTile label="Self-healed" value={healing.length} />
        <StatTile label="Started" value={formatWhen(execution.started_at)} />
      </div>

      <ReportSection title="Release decision">
        <Card className="p-5" style={{ borderColor: decisionPalette.border, backgroundColor: decisionPalette.bg }}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={isPassed ? 'pass' : 'fail'} label={isPassed ? 'PASSED' : execution.status} />
            <span className="font-mono text-xs text-muted">
              Step pass rate: {scorecard.stepPassRate}% · Evidence coverage: {scorecard.evidenceCoverage}%
            </span>
          </div>
          {!isPassed && failedStep && (
            <p className="mt-3 text-sm font-medium text-ink">
              Failed at step {failedStep.step_index} ({failedStep.action}
              {failedStep.resolved_locator?.value || failedStep.locator?.value
                ? ` on ${failedStep.resolved_locator?.value ?? failedStep.locator?.value}`
                : ''}
              ).
            </p>
          )}
        </Card>
      </ReportSection>

      <ReportSection title="Executive summary">
        <Card className="p-5">
          <p className="text-sm whitespace-pre-wrap text-ink-soft">{summaryText}</p>
        </Card>
      </ReportSection>

      <ReportSection title="Quality scorecard">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Step pass rate" value={scorecard.stepPassRate} unit="%" />
          <StatTile label="Healing recovery rate" value={scorecard.healingRecoveryRate ?? 'N/A'} unit={scorecard.healingRecoveryRate != null ? '%' : ''} />
          <StatTile label="Evidence coverage" value={scorecard.evidenceCoverage} unit="%" />
        </div>
      </ReportSection>

      <ReportSection title="Device & application details">
        <Card className="p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Application</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-ink">{application?.package_name ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Version</dt>
              <dd className="mt-0.5 text-ink">{application?.versions?.[0]?.version_name ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">SDK range</dt>
              <dd className="mt-0.5 text-ink">
                {application?.versions?.[0]?.min_sdk ?? '?'}–{application?.versions?.[0]?.target_sdk ?? '?'}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Device</dt>
              <dd className="mt-0.5 text-ink">{device?.model ?? device?.serial ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Android version</dt>
              <dd className="mt-0.5 text-ink">{device?.android_version ?? '—'} (API {device?.api_level ?? '?'})</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Environment</dt>
              <dd className="mt-0.5 text-ink">{execution.environment ?? 'DEV'}{device?.is_emulator ? ' · emulator' : ''}</dd>
            </div>
          </dl>
        </Card>
      </ReportSection>

      {steps.length > 0 && (
        <ReportSection title="Step-by-step execution">
          <div className="rounded-md border border-line bg-paper-alt">
            <DataTable columns={STEP_COLUMNS} rows={steps} getRowKey={(row) => String(row.step_index)} />
          </div>
        </ReportSection>
      )}

      {healing.length > 0 && (
        <ReportSection title="Self-healing results">
          <div className="rounded-md border border-line bg-paper-alt">
            <DataTable columns={HEALING_COLUMNS} rows={healing} getRowKey={(row) => String(row.id)} />
          </div>
        </ReportSection>
      )}

      {video && (
        <ReportSection title="Recording">
          <video
            src={api.mobile.artifactUrl(video.url) ?? undefined}
            controls
            className="w-full max-w-md rounded-md border border-line"
          />
        </ReportSection>
      )}

      {screenshots.length > 0 && (
        <ReportSection title="Evidence">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {screenshots.map((item) => {
              const href = api.mobile.artifactUrl(item.url)
              return (
                <a
                  key={item.id}
                  href={href ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-sm border border-line transition-colors duration-150 hover:border-accent"
                >
                  {href ? (
                    <img src={href} alt={`Step ${item.step_index ?? '?'}`} loading="lazy" className="aspect-[9/16] w-full object-cover" />
                  ) : (
                    <span className="flex aspect-[9/16] items-center justify-center">
                      <ImageIcon size={16} />
                    </span>
                  )}
                </a>
              )
            })}
          </div>
        </ReportSection>
      )}

      <ReportSection title="Technical appendix">
        <Card className="p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Execution ID</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-ink">{execution.id}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Execution UID</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-ink">{execution.execution_uid ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Raw status</dt>
              <dd className="mt-0.5 text-ink">{execution.status}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Started</dt>
              <dd className="mt-0.5 text-ink">{execution.started_at ? new Date(execution.started_at).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Completed</dt>
              <dd className="mt-0.5 text-ink">{execution.completed_at ? new Date(execution.completed_at).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-muted uppercase">Recorded steps</dt>
              <dd className="mt-0.5 text-ink">{steps.length}</dd>
            </div>
            {jiraUrl && (
              <div>
                <dt className="font-mono text-xs text-muted uppercase">Jira ticket</dt>
                <dd className="mt-0.5 text-ink">
                  <a href={jiraUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                    View ticket
                  </a>
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
            Full raw evidence and healing detail is available via Export JSON.
          </p>
        </Card>
      </ReportSection>
    </div>
  )
}
