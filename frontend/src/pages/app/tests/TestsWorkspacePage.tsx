import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { FlaskConical, FolderKanban, Layers } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { PageHeader } from '../../../components/ui/PageHeader'
import { SearchBar } from '../../../components/ui/SearchBar'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { Textarea } from '../../../components/ui/Textarea'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { api } from '../../../lib/api'
import type { TestCase, TestSuite } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { CreateTestModal } from './components/CreateTestModal'
import { TestDetailPanel } from './components/TestDetailPanel'
import { TestFolderTree } from './components/TestFolderTree'

/** Suite types the backend accepts. DB suites exist in the schema but their
 *  execution route is not mounted, so they are not offered here. */
const SUITE_TYPES = [
  { value: 'WEB', label: 'Web' },
  { value: 'API', label: 'API' },
]

export default function TestsWorkspacePage() {
  const {
    activeProject,
    suites,
    suitesLoading,
    activeSuite,
    setActiveSuite,
    loadSuites,
    testCases,
    testCasesLoading,
    loadTestCases,
  } = useData()
  const { triggerToast } = useToast()

  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [testModalOpen, setTestModalOpen] = useState(false)
  const [editingTest, setEditingTest] = useState<TestCase | null>(null)
  const [deletingTestId, setDeletingTestId] = useState<string | null>(null)
  const [createSuiteOpen, setCreateSuiteOpen] = useState(false)
  const [suiteName, setSuiteName] = useState('')
  const [suiteDescription, setSuiteDescription] = useState('')
  const [suiteType, setSuiteType] = useState('WEB')
  const [creatingSuite, setCreatingSuite] = useState(false)
  const [suiteError, setSuiteError] = useState<string | null>(null)
  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return testCases
    return testCases.filter((test) =>
      `${test.name} ${test.intent}`.toLowerCase().includes(term),
    )
  }, [testCases, query])

  const selected = filtered.find((test) => test.id === selectedId) ?? null

  async function createSuite(event: FormEvent) {
    event.preventDefault()
    if (!activeProject || isAllProjects(activeProject)) return
    if (!suiteName.trim()) {
      setSuiteError('Enter a suite name.')
      return
    }
    setSuiteError(null)
    setCreatingSuite(true)
    try {
      const suite = await api.createSuite(
        activeProject.id,
        suiteName.trim(),
        suiteDescription.trim() || undefined,
        suiteType,
      )
      await loadSuites(activeProject.id)
      setActiveSuite(suite)
      setSuiteName('')
      setSuiteDescription('')
      setCreateSuiteOpen(false)
      triggerToast(`Suite "${suite.name}" created.`)
    } catch (error) {
      setSuiteError((error as Error).message)
    } finally {
      setCreatingSuite(false)
    }
  }

  function onTestSaved(test: TestCase) {
    setTestModalOpen(false)
    setEditingTest(null)
    setSelectedId(test.id)
    if (activeSuite) void loadTestCases(activeSuite.id)
  }

  function openCreateTest() {
    setEditingTest(null)
    setTestModalOpen(true)
  }

  function openEditTest(test: TestCase) {
    setEditingTest(test)
    setTestModalOpen(true)
  }

  async function deleteTestCase(test: TestCase) {
    if (!activeSuite) return
    const confirmed = window.confirm(`Delete "${test.name}"? This cannot be undone.`)
    if (!confirmed) return

    setDeletingTestId(test.id)
    try {
      await api.deleteTestCase(activeSuite.id, test.id)
      if (selectedId === test.id) setSelectedId(null)
      await loadTestCases(activeSuite.id)
      triggerToast('Test case deleted.')
    } catch (error) {
      triggerToast(`Delete failed: ${(error as Error).message}`, true)
    } finally {
      setDeletingTestId(null)
    }
  }

  async function deleteSuite(suite: TestSuite) {
    if (!activeProject) return
    const confirmed = window.confirm(
      `Delete "${suite.name}"? This also removes its test cases and execution history. This cannot be undone.`,
    )
    if (!confirmed) return

    setDeletingSuiteId(suite.id)
    try {
      await api.deleteSuite(suite.id)
      await loadSuites(activeProject.id)
      if (activeSuite?.id === suite.id) setSelectedId(null)
      triggerToast('Suite deleted.')
    } catch (error) {
      triggerToast(`Delete failed: ${(error as Error).message}`, true)
    } finally {
      setDeletingSuiteId(null)
    }
  }

  const columns: DataTableColumn<TestCase>[] = [
    {
      key: 'name',
      header: 'Name',
      sortAccessor: (row) => row.name,
      render: (row) => (
        <button
          type="button"
          onClick={() => setSelectedId(row.id)}
          className="text-left font-medium text-ink hover:text-accent-deep hover:underline"
        >
          {row.name}
        </button>
      ),
    },
    {
      key: 'intent',
      header: 'Intent',
      render: (row) => <span className="text-ink-soft">{row.intent || '—'}</span>,
    },
    {
      key: 'steps',
      header: 'Steps',
      align: 'right',
      sortAccessor: (row) => (Array.isArray(row.steps) ? row.steps.length : 0),
      render: (row) => (
        <span className="font-mono text-xs">{Array.isArray(row.steps) ? row.steps.length : 0}</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortAccessor: (row) => row.createdAt,
      render: (row) => (
        <span className="font-mono text-xs">{new Date(row.createdAt).toLocaleDateString()}</span>
      ),
    },
  ]

  // Every suite and test-case call is project-scoped, so "All Projects" has
  // nothing to query against.
  if (!activeProject || isAllProjects(activeProject)) {
    return (
      <div>
        <PageHeader title="Test Suites" description="Organize web and API tests into suites and cases." />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Test suites belong to a project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Test Suites"
        description={`Suites and test cases in ${activeProject.name}.`}
        actions={
          <>
            <Button variant="outline" marker={false} onClick={() => setCreateSuiteOpen(true)}>
              New Suite
            </Button>
            <Button onClick={openCreateTest} disabled={!activeSuite}>
              New Test Case
            </Button>
          </>
        }
      />

      <div className={`grid gap-6 ${selected ? 'lg:grid-cols-[240px_1fr_360px]' : 'lg:grid-cols-[240px_1fr]'}`}>
        <TestFolderTree
          suites={suites}
          activeSuiteId={activeSuite?.id ?? null}
          onSelect={(suite) => {
            setActiveSuite(suite)
            setSelectedId(null)
          }}
          onCreate={() => setCreateSuiteOpen(true)}
          onDelete={(suite) => void deleteSuite(suite)}
          deletingId={deletingSuiteId}
          loading={suitesLoading}
        />

        <div className="min-w-0">
          {!activeSuite ? (
            <EmptyState
              icon={Layers}
              title="No suite selected"
              description="Create a test suite to start adding test cases to this project."
              action={<Button onClick={() => setCreateSuiteOpen(true)}>New Suite</Button>}
            />
          ) : (
            <>
              <div className="mb-4">
                <SearchBar
                  value={query}
                  onChange={setQuery}
                  placeholder="Search test cases…"
                  className="max-w-xs"
                />
              </div>

              {testCasesLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : filtered.length > 0 ? (
                <div className="rounded-md border border-line bg-paper-alt">
                  <DataTable columns={columns} rows={filtered} getRowKey={(row) => row.id} />
                </div>
              ) : testCases.length > 0 ? (
                <EmptyState
                  icon={FlaskConical}
                  title="No matches"
                  description={`No test case in ${activeSuite.name} matches "${query}".`}
                />
              ) : (
                <EmptyState
                  icon={FlaskConical}
                  title="No test cases yet"
                  description={`${activeSuite.name} has no test cases. Add one, or generate a suite from the Code Generator.`}
                  action={<Button onClick={openCreateTest}>New Test Case</Button>}
                />
              )}
            </>
          )}
        </div>

        {selected && (
          <div>
            <TestDetailPanel
              test={selected}
              onEdit={() => openEditTest(selected)}
              onDelete={() => void deleteTestCase(selected)}
              deleting={deletingTestId === selected.id}
            />
          </div>
        )}
      </div>

      {activeSuite && (
        <CreateTestModal
          open={testModalOpen}
          onClose={() => {
            setTestModalOpen(false)
            setEditingTest(null)
          }}
          suite={activeSuite}
          editingTest={editingTest}
          onSaved={onTestSaved}
        />
      )}

      <Modal open={createSuiteOpen} onClose={() => setCreateSuiteOpen(false)} title="New test suite">
        <form onSubmit={createSuite} noValidate className="flex flex-col gap-4">
          <Input
            label="Name"
            value={suiteName}
            onChange={(event) => setSuiteName(event.target.value)}
            error={suiteError ?? undefined}
          />
          <Textarea
            label="Description"
            rows={2}
            value={suiteDescription}
            onChange={(event) => setSuiteDescription(event.target.value)}
            helperText="Optional."
          />
          <Select
            label="Type"
            value={suiteType}
            onChange={(event) => setSuiteType(event.target.value)}
            helperText="Decides which execution pipeline runs this suite."
          >
            {SUITE_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setCreateSuiteOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creatingSuite}>
              {creatingSuite ? 'Creating…' : 'Create suite'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
