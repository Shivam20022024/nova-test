import { createContext, useCallback, useContext, useEffect, useState } from 'react'
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
