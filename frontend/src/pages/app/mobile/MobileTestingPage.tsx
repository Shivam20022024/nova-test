import { useCallback, useEffect, useState } from 'react'
import { FolderKanban } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Tabs } from '../../../components/ui/Tabs'
import { api } from '../../../lib/api'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import type {
  MobileApplication, MobileCapabilities, MobileDevice, MobileExecution, MobileSuite,
} from '../../../lib/types'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AuthorPanel } from './components/AuthorPanel'
import { DevicesPanel } from './components/DevicesPanel'
import { LiveExecutionPanel } from './components/LiveExecutionPanel'
import { RunsPanel } from './components/RunsPanel'
import { SuitesPanel } from './components/SuitesPanel'

const TABS = [
  { id: 'apps', label: 'Apps' },
  { id: 'devices', label: 'Devices' },
  { id: 'author', label: 'Author' },
  { id: 'suites', label: 'Suites' },
  { id: 'runs', label: 'Runs' },
]

/**
 * Android mobile testing.
 *
 * One route with tabs rather than five sidebar entries: the areas are steps in
 * a single workflow (upload an app, attach a device, author tests, run them,
 * read the results) and share the app/device selection, so splitting them
 * across routes would mean re-picking that context on every screen.
 *
 * All data is scoped to the active project. The engine has no user model of its
 * own — backend-node verifies project ownership and tells it what this user may
 * see (see backend-node/src/routes/mobile.ts).
 */
export default function MobileTestingPage() {
  const { activeProject } = useData()
  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : null

  const [tab, setTab] = useState('apps')
  const [capabilities, setCapabilities] = useState<MobileCapabilities | null>(null)
  const [applications, setApplications] = useState<MobileApplication[]>([])
  const [devices, setDevices] = useState<MobileDevice[]>([])
  const [suites, setSuites] = useState<MobileSuite[]>([])
  const [executions, setExecutions] = useState<MobileExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState<string | null>(null)

  const [applicationId, setApplicationId] = useState<number | null>(null)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [watching, setWatching] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      // Devices are excluded from Promise.all deliberately: that call re-syncs
      // adb on the server and is the slowest of the five. Failing it should not
      // blank the whole page.
      const [caps, apps, suiteRows, runs] = await Promise.all([
        api.mobile.getCapabilities(),
        api.mobile.listApplications(projectId),
        api.mobile.listSuites(20, projectId),
        api.mobile.listExecutions(25, projectId),
      ])
      setCapabilities(caps)
      setApplications(apps)
      setSuites(suiteRows)
      setExecutions(runs)
      setUnavailable(null)
      setApplicationId((current) => current ?? (apps.length === 1 ? apps[0].id : current))

      api.mobile
        .listDevices()
        .then((rows) => {
          setDevices(rows)
          setDeviceId((current) => current ?? rows.find((d) => d.status === 'AVAILABLE')?.id ?? null)
        })
        .catch(() => setDevices([]))
    } catch (error) {
      // The engine is a separate process; if it is down the rest of the product
      // is fine, so this says so rather than showing five empty panels.
      setUnavailable((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Mobile Testing" description="Run real Android apps on real devices." />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Apps, tests and runs belong to a project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Mobile Testing"
        description="Upload an Android build, author tests against its real screens, and run them on a device."
        actions={
          <Button variant="outline" marker={false} onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {unavailable ? (
        <EmptyState
          icon={FolderKanban}
          title="The mobile testing engine is not reachable"
          description={`${unavailable}. It runs as its own service — check that the backend is started, then refresh.`}
          action={<Button marker={false} onClick={() => void load()}>Try again</Button>}
        />
      ) : (
        <>
          <Tabs tabs={TABS} activeId={tab} onChange={setTab} className="mb-6" />

          {watching != null && (
            <div className="mb-6">
              <LiveExecutionPanel executionId={watching} onClose={() => setWatching(null)} />
            </div>
          )}

          {tab === 'apps' && (
            <ApplicationsPanel
              applications={applications}
              devices={devices}
              loading={loading}
              projectId={projectId}
              onChanged={() => void load()}
              selectedId={applicationId}
              onSelect={setApplicationId}
            />
          )}

          {tab === 'devices' && (
            <DevicesPanel
              devices={devices}
              loading={loading}
              emulatorAutoStart={!!capabilities?.features.emulator_auto_start}
              onChanged={() => void load()}
              selectedId={deviceId}
              onSelect={setDeviceId}
            />
          )}

          {tab === 'author' && (
            <AuthorPanel
              applications={applications}
              devices={devices}
              aiEnabled={!!capabilities?.features.ai_gateway}
              applicationId={applicationId}
              deviceId={deviceId}
              onChanged={() => {
                void load()
                setTab('suites')
              }}
            />
          )}

          {tab === 'suites' && (
            <SuitesPanel
              suites={suites}
              loading={loading}
              onChanged={() => void load()}
              onWatch={(id) => {
                setWatching(id)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            />
          )}

          {tab === 'runs' && (
            <RunsPanel
              executions={executions}
              loading={loading}
              activeId={watching}
              onWatch={(id) => {
                setWatching(id)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            />
          )}
        </>
      )}
    </div>
  )
}
