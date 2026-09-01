import { useRef, useState } from 'react'
import { AlertTriangle, Compass, Package, Upload } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { api } from '../../../../lib/api'
import { useToast } from '../../../../contexts/ToastContext'
import type { MobileApplication, MobileDevice } from '../../../../lib/types'
import { formatBytes, frameworkSeverity } from '../mobileStatus'

type Props = {
  applications: MobileApplication[]
  devices: MobileDevice[]
  loading: boolean
  projectId: string
  onChanged: () => void
  selectedId: number | null
  onSelect: (id: number) => void
}

export function ApplicationsPanel({
  applications, devices, loading, projectId, onChanged, selectedId, onSelect,
}: Props) {
  const { triggerToast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [exploring, setExploring] = useState<number | null>(null)
  const [warning, setWarning] = useState<{ text: string; severity: 'blocking' | 'caution' } | null>(null)

  const availableDevice = devices.find((d) => d.status === 'AVAILABLE')

  async function upload(file: File) {
    if (!file.name.endsWith('.apk')) {
      triggerToast('Only .apk files can be uploaded.', true)
      return
    }
    setUploading(true)
    setWarning(null)
    try {
      const result = await api.mobile.uploadApplication(file, projectId)
      const severity = frameworkSeverity(result.application.versions?.[0]?.framework_hint ?? null)
      if (result.compatibility_warning) {
        setWarning({ text: result.compatibility_warning, severity: severity ?? 'caution' })
      }
      triggerToast(
        result.duplicate
          ? `${result.application.package_name} was already uploaded — reusing that build.`
          : `Uploaded ${result.application.package_name}.`,
      )
      onChanged()
    } catch (error) {
      triggerToast(`Upload failed: ${(error as Error).message}`, true)
    } finally {
      setUploading(false)
    }
  }

  async function explore(applicationId: number) {
    if (!availableDevice) return
    setExploring(applicationId)
    try {
      await api.mobile.exploreApplication(applicationId, availableDevice.id)
      triggerToast('Exploring the app to build its screen map. This runs in the background for a few minutes.')
    } catch (error) {
      triggerToast(`Could not start exploration: ${(error as Error).message}`, true)
    } finally {
      setExploring(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <h2 className="font-sans text-base font-semibold text-ink">Upload an APK</h2>
        <p className="mt-1 text-sm text-ink-soft">
          The package is inspected on upload — its identifier, version, permissions and UI toolkit are
          read from the binary itself.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".apk"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void upload(file)
          }}
        />

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button marker={false} disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload size={15} aria-hidden="true" />
            {uploading ? 'Inspecting…' : 'Choose APK'}
          </Button>
          <span className="text-xs text-muted">Android packages only.</span>
        </div>

        {warning && (
          <div
            role="status"
            className="mt-5 rounded-md border p-4"
            style={{
              borderColor: warning.severity === 'blocking' ? 'var(--color-fail)' : 'var(--color-flaky)',
              // Tinted from the status hue rather than a flat gray, so the
              // severity reads before the text does.
              backgroundColor:
                warning.severity === 'blocking' ? 'color-mix(in srgb, var(--color-fail) 7%, transparent)'
                                                : 'color-mix(in srgb, var(--color-flaky) 9%, transparent)',
            }}
          >
            <div className="flex gap-3">
              <AlertTriangle
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
                style={{ color: warning.severity === 'blocking' ? 'var(--color-fail)' : 'var(--color-flaky)' }}
              />
              <div>
                <p className="text-sm font-semibold text-ink">
                  {warning.severity === 'blocking'
                    ? 'This app cannot be automated by locators'
                    : 'This app may be harder to automate'}
                </p>
                <p className="mt-1 text-sm text-ink-soft">{warning.text}</p>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="font-sans text-base font-semibold text-ink">Applications</h2>

        {loading ? (
          <div className="mt-5 flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : applications.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={Package}
            title="No apps in this project yet"
            description="Upload an APK to begin. Everything else — tests, runs, evidence — hangs off the app it was built against."
            action={
              <Button marker={false} onClick={() => fileRef.current?.click()}>
                Upload the first APK
              </Button>
            }
          />
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {applications.map((app) => {
              const version = app.versions?.[0]
              const selected = selectedId === app.id
              return (
                <li key={app.id}>
                  <div
                    className={`flex flex-wrap items-center gap-4 py-4 transition-colors duration-150 ${
                      selected ? 'bg-accent-soft/30' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(app.id)}
                      aria-pressed={selected}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate font-mono text-sm font-medium text-ink">{app.package_name}</p>
                      <p className="mt-1 font-mono text-xs text-muted">
                        {version
                          ? `v${version.version_name ?? '?'} · ${formatBytes(version.size)} · SDK ${version.min_sdk ?? '?'}–${version.target_sdk ?? '?'}`
                          : 'No valid build'}
                      </p>
                    </button>

                    <Button
                      variant="outline"
                      marker={false}
                      disabled={!availableDevice || exploring === app.id}
                      onClick={() => void explore(app.id)}
                      title={
                        availableDevice
                          ? 'Crawl the app to map its real screens and elements'
                          : 'Needs an available device — connect one on the Devices tab'
                      }
                    >
                      <Compass size={14} aria-hidden="true" />
                      {exploring === app.id ? 'Exploring…' : 'Explore'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
