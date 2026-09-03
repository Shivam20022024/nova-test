import { useCallback, useEffect, useRef, useState } from 'react'
import { Layers } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Select } from '../../../../components/ui/Select'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { api } from '../../../../lib/api'
import { useToast } from '../../../../contexts/ToastContext'
import type { MobileCompatibilityRun, MobileDevice, MobileTest } from '../../../../lib/types'
import { formatDuration, statusLabel, toStatus } from '../mobileStatus'

type Props = {
  tests: MobileTest[]
  devices: MobileDevice[]
  loading: boolean
  onWatch: (executionId: number) => void
}

/**
 * One saved test, fanned out across several devices at once — genuinely
 * concurrent, not queued — with a single per-device pass/fail report. Distinct
 * from a Suite (many tests, one device) and a single Execution (one test, one
 * device): this is one test, many devices, for checking the same app/test
 * behaves the same way across Android versions, manufacturers, or screen sizes.
 */
export function CompatibilityPanel({ tests, devices, loading, onWatch }: Props) {
  const { triggerToast } = useToast()

  const [testId, setTestId] = useState<number | null>(null)
  const [deviceIds, setDeviceIds] = useState<Set<number>>(new Set())
  const [starting, setStarting] = useState(false)

  const [currentRun, setCurrentRun] = useState<MobileCompatibilityRun | null>(null)
  const [recentRuns, setRecentRuns] = useState<MobileCompatibilityRun[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshRecent = useCallback(() => {
    api.mobile
      .listCompatibilityRuns(10)
      .then(setRecentRuns)
      .catch(() => {})
      .finally(() => setRunsLoading(false))
  }, [])

  useEffect(() => {
    refreshRecent()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refreshRecent])

  const pollRun = useCallback(
    (runId: number) => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const run = await api.mobile.getCompatibilityRun(runId)
          setCurrentRun(run)
          if (run.status === 'COMPLETED') {
            if (pollRef.current) clearInterval(pollRef.current)
            refreshRecent()
          }
        } catch {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 3000)
    },
    [refreshRecent],
  )

  function toggleDevice(id: number) {
    setDeviceIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function run() {
    if (!testId) {
      triggerToast('Pick a saved test first.', true)
      return
    }
    if (deviceIds.size < 2) {
      triggerToast('Select at least 2 devices to compare.', true)
      return
    }
    setStarting(true)
    try {
      const created = await api.mobile.createCompatibilityRun({
        test_id: testId,
        device_ids: Array.from(deviceIds),
      })
      setCurrentRun(created)
      triggerToast(`Compatibility run #${created.id} started on ${created.device_count} device(s).`)
      if (created.status !== 'COMPLETED') pollRun(created.id)
      else refreshRecent()
    } catch (error) {
      triggerToast(`Compatibility run failed to start: ${(error as Error).message}`, true)
    } finally {
      setStarting(false)
    }
  }

  async function view(runId: number) {
    try {
      const runDetail = await api.mobile.getCompatibilityRun(runId)
      setCurrentRun(runDetail)
      if (runDetail.status !== 'COMPLETED') pollRun(runDetail.id)
      else if (pollRef.current) clearInterval(pollRef.current)
    } catch (error) {
      triggerToast(`Could not load compatibility run #${runId}: ${(error as Error).message}`, true)
    }
  }

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-6 w-40" />
        <div className="mt-5 flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Layers size={18} aria-hidden="true" className="text-accent" />
          <h3 className="text-sm font-semibold text-ink">Compatibility run</h3>
        </div>
        <p className="mb-4 text-sm text-muted">
          Run one saved test on several devices at the same time — genuinely concurrent, not queued —
          and get a single per-device pass/fail report. Useful for checking the same app/test behaves
          the same way across different Android versions, manufacturers, or screen sizes.
        </p>

        {tests.length === 0 ? (
          <p className="text-sm text-muted">
            No saved tests yet. Create one from the Author tab first.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <Select
              label="Saved test"
              value={testId ?? ''}
              onChange={(event) => setTestId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Select a saved test…</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.id} — {t.name}
                </option>
              ))}
            </Select>

            <div>
              <p className="mb-2 text-xs font-medium text-muted">Devices to compare (pick 2 or more)</p>
              {devices.length === 0 ? (
                <p className="text-sm text-muted">No devices detected via adb.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {devices.map((d) => {
                    const checked = deviceIds.has(d.id)
                    const disabled = d.status === 'RESERVED'
                    return (
                      <button
                        key={d.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleDevice(d.id)}
                        aria-pressed={checked}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          checked ? 'border-accent bg-accent/10 text-accent' : 'border-line text-ink-soft'
                        }`}
                      >
                        {d.model ?? d.serial} ({d.serial}){disabled ? ' · reserved' : ''}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <Button
              marker={false}
              disabled={starting || !testId || deviceIds.size < 2}
              onClick={() => void run()}
            >
              {starting ? 'Starting…' : `Run on ${deviceIds.size || 0} device(s)`}
            </Button>
          </div>
        )}
      </Card>

      {currentRun && (
        <Card className="p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">
              #{currentRun.id} — {currentRun.test_name ?? `test ${currentRun.test_id}`} ·{' '}
              {currentRun.passed_count}/{currentRun.device_count} passed
            </p>
            <StatusBadge
              status={currentRun.status === 'COMPLETED' ? 'pass' : 'running'}
              label={currentRun.status === 'COMPLETED' ? 'Completed' : 'Running'}
            />
          </div>
          <ul className="flex flex-col gap-1.5">
            {currentRun.devices.map((d) => (
              <li key={d.execution_id}>
                <button
                  type="button"
                  onClick={() => onWatch(d.execution_id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left hover:border-accent"
                >
                  <span className="truncate text-xs font-medium text-ink">
                    {d.device_label ?? `device ${d.device_id ?? '—'}`}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted">{formatDuration(d.duration_ms)}</span>
                    <StatusBadge status={toStatus(d.status)} label={statusLabel(d.status)} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-6">
        <p className="mb-3 text-xs font-medium text-muted">Recent compatibility runs</p>
        {runsLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : recentRuns.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No compatibility runs yet"
            description="Pick a test and 2+ devices above to run one."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {recentRuns.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => void view(r.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left hover:border-accent"
                >
                  <span className="truncate text-xs font-medium text-ink">
                    #{r.id} — {r.test_name ?? `test ${r.test_id}`} ({r.device_count} devices)
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted">
                      {r.passed_count}/{r.device_count}
                    </span>
                    <StatusBadge
                      status={r.status === 'COMPLETED' ? 'pass' : 'running'}
                      label={r.status === 'COMPLETED' ? 'Completed' : 'Running'}
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
