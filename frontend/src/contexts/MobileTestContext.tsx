import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import { isAllProjects, useData } from './DataContext'
import type {
  MobileApplication, MobileCapabilities, MobileDevice, MobileExecution, MobileSuite, MobileTest,
} from '../lib/types'

type MobileTestContextValue = {
  projectId: string | null
  capabilities: MobileCapabilities | null
  applications: MobileApplication[]
  devices: MobileDevice[]
  suites: MobileSuite[]
  tests: MobileTest[]
  executions: MobileExecution[]
  loading: boolean
  unavailable: string | null
  applicationId: number | null
  setApplicationId: (id: number | null) => void
  deviceId: number | null
  setDeviceId: (id: number | null) => void
  reload: () => Promise<void>
}

const MobileTestContext = createContext<MobileTestContextValue | null>(null)

export function useMobileTest(): MobileTestContextValue {
  const ctx = useContext(MobileTestContext)
  if (!ctx) throw new Error('useMobileTest must be used within <MobileTestProvider>')
  return ctx
}

/**
 * Shared app/device selection + data for the Application Testing vertical.
 *
 * Apps, Devices, Author, Executions and Compatibility used to be tabs inside
 * one page, sharing state as plain useState in that one component. Splitting
 * them into standalone routed pages (to give Application Testing the same
 * top-level weight as Web Testing) would otherwise reset that selection and
 * re-fetch everything every time the user moves between them — this context
 * is mounted once, above all five routes, so the selection and data persist
 * across navigation exactly like it did as tabs.
 */
export function MobileTestProvider({ children }: { children: ReactNode }) {
  const { activeProject } = useData()
  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : null

  const [capabilities, setCapabilities] = useState<MobileCapabilities | null>(null)
  const [applications, setApplications] = useState<MobileApplication[]>([])
  const [devices, setDevices] = useState<MobileDevice[]>([])
  const [suites, setSuites] = useState<MobileSuite[]>([])
  const [tests, setTests] = useState<MobileTest[]>([])
  const [executions, setExecutions] = useState<MobileExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState<string | null>(null)

  const [applicationId, setApplicationId] = useState<number | null>(null)
  const [deviceId, setDeviceId] = useState<number | null>(null)

  // Devices are a shared, global, adb-discovered resource (not project data —
  // GET /devices takes no project filter at all) — but an on-demand emulator
  // idles itself out after a while, so "no device" is a routine, recurring
  // state, not just a first-run one. Rather than make every project/page
  // re-teach the user to click "Start an emulator," this auto-provisions one
  // the moment a device-less reload is seen (when the backend reports the
  // capability at all) and polls briefly until it comes online — no page in
  // the Application Testing vertical needs its own copy of this logic.
  const autoProvisionInFlight = useRef(false)

  function pollForDevice(attempts = 24) {
    if (attempts <= 0) return
    setTimeout(() => {
      api.mobile
        .listDevices()
        .then((rows) => {
          setDevices(rows)
          if (rows.length === 0) pollForDevice(attempts - 1)
          else autoProvisionInFlight.current = false
        })
        .catch(() => pollForDevice(attempts - 1))
    }, 5000)
  }

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      // Devices are excluded from Promise.all deliberately: that call re-syncs
      // adb on the server and is the slowest of the six. Failing it should not
      // blank the whole vertical.
      const [caps, apps, suiteRows, runs, testRows] = await Promise.all([
        api.mobile.getCapabilities(),
        api.mobile.listApplications(projectId),
        api.mobile.listSuites(20, projectId),
        api.mobile.listExecutions(25, projectId),
        api.mobile.listTests(projectId),
      ])
      setCapabilities(caps)
      setApplications(apps)
      setSuites(suiteRows)
      setExecutions(runs)
      setTests(testRows)
      setUnavailable(null)
      // Deliberately no auto-selection here (of the one app, of the first
      // available device, ...) — opening a page should never look like
      // something was already picked on your behalf. Selection only ever
      // happens from an explicit click, in Apps/DevicesPanel's onSelect.

      api.mobile
        .listDevices()
        .then((rows) => {
          setDevices(rows)
          if (rows.length === 0 && caps.features.emulator_auto_start && !autoProvisionInFlight.current) {
            autoProvisionInFlight.current = true
            api.mobile
              .provisionDevice()
              .then(() => pollForDevice())
              .catch(() => {
                autoProvisionInFlight.current = false
              })
          }
        })
        .catch(() => setDevices([]))
    } catch (error) {
      // The engine is a separate process; if it is down the rest of the product
      // is fine, so this says so rather than showing five empty pages.
      setUnavailable((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <MobileTestContext.Provider
      value={{
        projectId,
        capabilities,
        applications,
        devices,
        suites,
        tests,
        executions,
        loading,
        unavailable,
        applicationId,
        setApplicationId,
        deviceId,
        setDeviceId,
        reload,
      }}
    >
      {children}
    </MobileTestContext.Provider>
  )
}
