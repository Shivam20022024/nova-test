import { useEffect, useState } from 'react'
import { Ban, Image as ImageIcon, Smartphone } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { api } from '../../../../lib/api'
import { useToast } from '../../../../contexts/ToastContext'
import { useMobileExecutionSocket } from '../../../../hooks/useMobileExecutionSocket'
import type { MobileEvidenceItem, MobileHealingRecord } from '../../../../lib/types'
import { formatDuration, statusLabel, toStatus } from '../mobileStatus'

type Props = { executionId: number; onClose: () => void }

const STEP_TONE: Record<string, string> = {
  PASSED: 'var(--color-pass)',
  FAILED: 'var(--color-fail)',
  HEALED: 'var(--color-healing)',
  SKIPPED: 'var(--color-blocked)',
  BLOCKED: 'var(--color-blocked)',
}

export function LiveExecutionPanel({ executionId, onClose }: Props) {
  const { triggerToast } = useToast()
  const { connectionStatus, events, frame, status, steps, videoUrl, isTerminal } =
    useMobileExecutionSocket(executionId)
  const [evidence, setEvidence] = useState<MobileEvidenceItem[]>([])
  const [healing, setHealing] = useState<MobileHealingRecord[]>([])
  const [acting, setActing] = useState<number | null>(null)

  // Evidence and healing rows are written as the run progresses, so they are
  // fetched once the run settles rather than streamed.
  useEffect(() => {
    if (!isTerminal) return
    api.mobile.getExecutionEvidence(executionId).then(setEvidence).catch(() => {})
    api.mobile.getHealingHistory({ execution_id: executionId }).then(setHealing).catch(() => {})
  }, [executionId, isTerminal])

  async function decide(record: MobileHealingRecord, approve: boolean) {
    setActing(record.id)
    try {
      const result = approve
        ? await api.mobile.approveHealing(record.id)
        : await api.mobile.rejectHealing(record.id)
      triggerToast(
        approve
          ? `Fix approved${'rerun_execution_id' in result && result.rerun_execution_id ? ` — re-running as #${result.rerun_execution_id}` : ''}.`
          : 'Fix rejected.',
      )
      setHealing((prev) => prev.filter((h) => h.id !== record.id))
    } catch (error) {
      triggerToast(`Could not record that decision: ${(error as Error).message}`, true)
    } finally {
      setActing(null)
    }
  }

  const screenshots = evidence.filter((e) => e.artifact_type === 'SCREENSHOT')
  const pending = healing.filter((h) => h.status === 'PENDING_APPROVAL' || h.status === 'REQUIRES_REVIEW')

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <h2 className="font-sans text-base font-semibold text-ink">Execution #{executionId}</h2>
          {status && <StatusBadge status={toStatus(status)} label={statusLabel(status)} />}
          {!isTerminal && (
            <span className="font-mono text-xs text-muted">
              {connectionStatus === 'live' ? 'streaming' : connectionStatus}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isTerminal && (
            <Button
              variant="outline"
              marker={false}
              onClick={() =>
                api.mobile
                  .cancelExecution(executionId)
                  .then(() => triggerToast('Cancellation requested — the run stops before its next step.'))
                  .catch((e) => triggerToast(`Could not cancel: ${(e as Error).message}`, true))
              }
            >
              <Ban size={14} aria-hidden="true" />
              Cancel
            </Button>
          )}
          <Button variant="outline" marker={false} onClick={onClose}>Close</Button>
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Device viewport. Fixed 9:19.5 so the frame doesn't resize as frames
            arrive — a jumping panel is unreadable while you're watching a run. */}
        <div>
          <div
            className="relative overflow-hidden rounded-md border border-line bg-ink"
            style={{ aspectRatio: '9 / 19.5' }}
          >
            {frame ? (
              <img src={frame} alt="Live device screen" className="size-full object-contain" />
            ) : videoUrl ? (
              <video src={videoUrl} controls className="size-full object-contain" />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Smartphone size={22} aria-hidden="true" className="text-muted" />
                <p className="text-sm text-paper/70">
                  {isTerminal ? 'No recording was captured for this run.' : 'Waiting for the device…'}
                </p>
              </div>
            )}
          </div>
          {videoUrl && frame && (
            <a href={videoUrl} target="_blank" rel="noreferrer"
               className="mt-2 inline-block font-mono text-xs text-accent underline underline-offset-4">
              Open recording
            </a>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {pending.length > 0 && (
            <div>
              <h3 className="font-sans text-sm font-semibold text-ink">AutoHeal needs a decision</h3>
              <ul className="mt-3 flex flex-col gap-3">
                {pending.map((record) => (
                  <li key={record.id} className="rounded-md border p-4"
                      style={{ borderColor: 'var(--color-healing)',
                               backgroundColor: 'color-mix(in srgb, var(--color-healing) 6%, transparent)' }}>
                    <p className="text-sm text-ink">
                      Step {record.step_index} — a replacement locator was found
                      {record.confidence != null && (
                        <span className="ml-1 font-mono text-xs text-muted">
                          ({Math.round(record.confidence)}% confidence)
                        </span>
                      )}
                    </p>
                    {record.reason && <p className="mt-1 text-sm text-ink-soft">{record.reason}</p>}
                    <div className="mt-2 flex flex-col gap-1 font-mono text-xs">
                      <span className="text-muted line-through">{record.original_locator?.value ?? '—'}</span>
                      <span className="text-ink">{record.replacement_locator?.value ?? record.candidate_locators?.[0]?.locator?.value ?? '—'}</span>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button marker={false} disabled={acting === record.id} onClick={() => void decide(record, true)}>
                        Approve and re-run
                      </Button>
                      <Button variant="outline" marker={false} disabled={acting === record.id} onClick={() => void decide(record, false)}>
                        Reject
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="font-sans text-sm font-semibold text-ink">
              Steps
              {steps.length > 0 && (
                <span className="ml-2 font-mono text-xs font-normal text-muted">
                  {steps.filter((s) => s.status === 'PASSED' || s.status === 'HEALED' || s.status === 'FALLBACK_RESOLVED').length}/{steps.length} passed
                </span>
              )}
            </h3>
            {steps.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No steps reported yet.</p>
            ) : (
              <ol className="mt-3 divide-y divide-line">
                {steps.map((step) => (
                  <li key={step.step_index} className="flex items-baseline gap-3 py-2">
                    <span className="w-6 shrink-0 font-mono text-xs text-muted">{step.step_index}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-mono text-sm text-ink">{step.action}</span>
                      {step.actual && <span className="mt-0.5 block truncate text-xs text-muted">{step.actual}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted">{formatDuration(step.duration_ms)}</span>
                    <span className="shrink-0 font-mono text-xs" style={{ color: STEP_TONE[step.status] ?? 'var(--color-blocked)' }}>
                      {step.status.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {screenshots.length > 0 && (
            <div>
              <h3 className="font-sans text-sm font-semibold text-ink">Evidence</h3>
              <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4">
                {screenshots.map((item) => {
                  const href = api.mobile.artifactUrl(item.url)
                  return (
                    <li key={item.id}>
                      <a href={href ?? '#'} target="_blank" rel="noreferrer"
                         className="block overflow-hidden rounded-sm border border-line transition-colors duration-150 hover:border-accent">
                        {href ? (
                          <img src={href} alt={`Step ${item.step_index ?? '?'}`} loading="lazy"
                               className="aspect-[9/16] w-full object-cover" />
                        ) : (
                          <span className="flex aspect-[9/16] items-center justify-center"><ImageIcon size={16} /></span>
                        )}
                      </a>
                      <span className="mt-1 block font-mono text-xs text-muted">step {item.step_index ?? '—'}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <div>
            <h3 className="font-sans text-sm font-semibold text-ink">Event log</h3>
            {events.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing reported yet.</p>
            ) : (
              <ul className="mt-3 max-h-64 overflow-y-auto">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3 py-1">
                    <time className="shrink-0 font-mono text-xs text-muted">
                      {event.time.toLocaleTimeString(undefined, { hour12: false })}
                    </time>
                    <span className="min-w-0 break-words font-mono text-xs text-ink-soft">{event.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}
