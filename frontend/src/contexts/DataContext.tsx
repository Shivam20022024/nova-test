import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { Project, TestCase, TestSuite } from '../lib/types'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'

/**
 * Sentinel for the "All Projects" selection. Dashboard endpoints take an
 * optional projectId, so this stands in for "send no filter" without needing a
 * separate null state everywhere.
 */
export const ALL_PROJECTS_ID = '__ALL__'
export const ALL_PROJECTS: Project = {
  id: ALL_PROJECTS_ID,
  name: 'All Projects',
  description: null,
  userId: '',
  createdAt: '',
  updatedAt: '',
}

export function isAllProjects(project: Project | null): boolean {
  return !project || project.id === ALL_PROJECTS_ID
}

type DataContextValue = {
  projects: Project[]
  activeProject: Project | null
  setActiveProject: (project: Project | null) => void
  loadProjects: () => Promise<void>
  projectsLoading: boolean

  suites: TestSuite[]
  activeSuite: TestSuite | null
  setActiveSuite: (suite: TestSuite | null) => void
  loadSuites: (projectId: string) => Promise<void>
  suitesLoading: boolean

  testCases: TestCase[]
  activeCase: TestCase | null
  setActiveCase: (testCase: TestCase | null) => void
  loadTestCases: (suiteId: string) => Promise<void>
  testCasesLoading: boolean

  /** The concrete project id to send to the API, or undefined for "all". */
  scopedProjectId: string | undefined
}

const DataContext = createContext<DataContextValue | null>(null)

export function useData(): DataContextValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within <DataProvider>')
  return ctx
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth()
  const { triggerToast } = useToast()

  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(false)

  const [suites, setSuites] = useState<TestSuite[]>([])
  const [activeSuite, setActiveSuite] = useState<TestSuite | null>(null)
  const [suitesLoading, setSuitesLoading] = useState(false)

  const [testCases, setTestCases] = useState<TestCase[]>([])
  const [activeCase, setActiveCase] = useState<TestCase | null>(null)
  const [testCasesLoading, setTestCasesLoading] = useState(false)

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const data = await api.getProjects()
      setProjects(data)
      // Only auto-select when nothing is chosen yet, so a refresh triggered by
      // creating or renaming a project does not yank the user elsewhere.
      setActiveProject((current) => current ?? (data.length > 0 ? data[0] : ALL_PROJECTS))
    } catch (error) {
      triggerToast(`Could not load projects: ${(error as Error).message}`, true)
    } finally {
      setProjectsLoading(false)
    }
  }, [triggerToast])

  const loadSuites = useCallback(
    async (projectId: string) => {
      setSuitesLoading(true)
      try {
        const data = await api.getSuites(projectId)
        setSuites(data)
        setActiveSuite(data.length > 0 ? data[0] : null)
      } catch (error) {
        triggerToast(`Could not load test suites: ${(error as Error).message}`, true)
      } finally {
        setSuitesLoading(false)
      }
    },
    [triggerToast],
  )

  const loadTestCases = useCallback(
    async (suiteId: string) => {
      setTestCasesLoading(true)
      try {
        const data = await api.getTestCases(suiteId)
        setTestCases(data)
        setActiveCase(data.length > 0 ? data[0] : null)
      } catch (error) {
        triggerToast(`Could not load test cases: ${(error as Error).message}`, true)
      } finally {
        setTestCasesLoading(false)
      }
    },
    [triggerToast],
  )

  // Signing out must drop every cached row, otherwise the next user briefly
  // sees the previous one's projects.
  useEffect(() => {
    if (!currentUser) {
      setProjects([])
      setActiveProject(null)
      setSuites([])
      setActiveSuite(null)
      setTestCases([])
      setActiveCase(null)
      return
    }
    void loadProjects()
  }, [currentUser, loadProjects])

  useEffect(() => {
    if (activeProject && !isAllProjects(activeProject)) {
      void loadSuites(activeProject.id)
    } else {
      setSuites([])
      setActiveSuite(null)
    }
  }, [activeProject, loadSuites])

  useEffect(() => {
    if (activeSuite) {
      void loadTestCases(activeSuite.id)
    } else {
      setTestCases([])
      setActiveCase(null)
    }
  }, [activeSuite, loadTestCases])

  const value = useMemo<DataContextValue>(
    () => ({
      projects,
      activeProject,
      setActiveProject,
      loadProjects,
      projectsLoading,
      suites,
      activeSuite,
      setActiveSuite,
      loadSuites,
      suitesLoading,
      testCases,
      activeCase,
      setActiveCase,
      loadTestCases,
      testCasesLoading,
      scopedProjectId: isAllProjects(activeProject) ? undefined : activeProject!.id,
    }),
    [
      projects,
      activeProject,
      loadProjects,
      projectsLoading,
      suites,
      activeSuite,
      loadSuites,
      suitesLoading,
      testCases,
      activeCase,
      loadTestCases,
      testCasesLoading,
    ],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}
