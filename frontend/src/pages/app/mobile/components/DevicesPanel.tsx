import { useState } from 'react'
import { Activity, Smartphone } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { api } from '../../../../lib/api'
import { useToast } from '../../../../contexts/ToastContext'
import type { MobileDevice, MobileDeviceHealth } from '../../../../lib/types'
import { formatWhen } from '../mobileStatus'

type Props = {
  devices: MobileDevice[]
  loading: boolean
  emulatorAutoStart: boolean
  onChanged: () => void
  selectedId: number | null
  onSelect: (id: number) => void
}

/** Device state is its own vocabulary — a phone is not a test run, so it does
 *  not borrow the pass/fail badge. */
const DEVICE_TONE: Record<string, string> = {
  AVAILABLE: 'var(--color-pass)',
  RESERVED: 'var(--color-running)',
  UNHEALTHY: 'var(--color-fail)',
  OFFLINE: 'var(--color-blocked)',
  QUARANTINED: 'var(--color-flaky)',
}

export function DevicesPanel({
  devices, loading, emulatorAutoStart, onChanged, selectedId, onSelect,
}: Props) {
  const { triggerToast } = useToast()
  const [checking, setChecking] = useState<number | null>(null)
  const [health, setHealth] = useState<Record<number, MobileDeviceHealth>>({})
  const [provisioning, setProvisioning] = useState(false)

  async function checkHealth(id: number) {
    setChecking(id)
    try {
      const result = await api.mobile.checkDeviceHealth(id)
      setHealth((prev) => ({ ...prev, [id]: result }))
      triggerToast(result.healthy ? 'Device is healthy.' : 'Device reported problems — see the checks below.', !result.healthy)
      onChanged()
    } catch (error) {
      triggerToast(`Health check failed: ${(error as Error).message}`, true)
    } finally {
      setChecking(null)
    }
  }

  async function provision() {
    setProvisioning(true)
    try {
      await api.mobile.provisionDevice()
      triggerToast('Booting an emulator. It will appear here once Android has finished starting.')
      onChanged()
    } catch (error) {
      triggerToast(`Could not start an emulator: ${(error as Error).message}`, true)
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-base font-semibold text-ink">Devices</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Discovered live over adb each time this loads. Physical phones and emulators appear the same way.
          </p>
        </div>
        {emulatorAutoStart && (
          <Button variant="outline" marker={false} disabled={provisioning} onClick={() => void provision()}>
            {provisioning ? 'Starting…' : 'Start an emulator'}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="mt-5 flex flex-col gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : devices.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={Smartphone}
          title="No devices connected"
          description={
            emulatorAutoStart
              ? 'Start an emulator above, plug in a phone with USB debugging enabled, or attach one over the network with adb connect.'
              : 'Plug in a phone with USB debugging enabled, or attach one over the network with adb connect. Tests cannot run without a device.'
          }
        />
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {devices.map((device) => {
            const tone = DEVICE_TONE[device.status] ?? 'var(--color-blocked)'
            const result = health[device.id]
            const selected = selectedId === device.id
            return (
              <li key={device.id} className={`py-4 transition-colors duration-150 ${selected ? 'bg-accent-soft/30' : ''}`}>
                <div className="flex flex-wrap items-center gap-4">
                  <button type="button" onClick={() => onSelect(device.id)} aria-pressed={selected} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tone }} aria-hidden="true" />
                      <p className="truncate text-sm font-medium text-ink">
                        {device.model ?? device.serial}
                        {device.is_emulator && <span className="ml-2 text-xs font-normal text-muted">emulator</span>}
                      </p>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted">
                      {device.serial} · Android {device.android_version ?? '?'} · API {device.api_level ?? '?'}
                      {device.battery_level != null && ` · ${device.battery_level}%`}
                    </p>
                  </button>

                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs uppercase tracking-wider" style={{ color: tone }}>
                      {device.status.toLowerCase()}
                    </span>
                    <Button
                      variant="outline"
                      marker={false}
                      disabled={checking === device.id}
                      onClick={() => void checkHealth(device.id)}
                    >
                      <Activity size={14} aria-hidden="true" />
                      {checking === device.id ? 'Checking…' : 'Check'}
                    </Button>
                  </div>
                </div>

                {result && (
                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 pl-4">
                    {Object.entries(result.checks).map(([name, ok]) => (
                      <div key={name} className="flex items-center gap-1.5">
                        <dt className="font-mono text-xs text-muted">{name.replace(/_/g, ' ')}</dt>
                        <dd
                          className="font-mono text-xs font-medium"
                          style={{ color: ok ? 'var(--color-pass)' : 'var(--color-fail)' }}
                        >
                          {ok ? 'ok' : 'failed'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}

                {device.last_health_check && !result && (
                  <p className="mt-2 pl-4 font-mono text-xs text-muted">
                    last checked {formatWhen(device.last_health_check)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
