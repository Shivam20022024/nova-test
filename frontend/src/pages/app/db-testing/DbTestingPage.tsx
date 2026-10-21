import { useState } from 'react'
import useSWR from 'swr'
import { Database, Plus, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import type { Status } from '../../../components/ui/StatusBadge'
import { Textarea } from '../../../components/ui/Textarea'
import { useData, isAllProjects } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { DbAssertionOperator, DbAssertionType, DbConnection, DbStep, Release, Sprint } from '../../../lib/types'

const ASSERTION_TYPES: DbAssertionType[] = [
  'rowCount', 'cellValue', 'jsonPath', 'schemaColumns', 'columnNotNull', 'columnUnique', 'regexMatch', 'dataType', 'dateValid', 'aggregate',
]
const OPERATORS: DbAssertionOperator[] = ['equals', 'notEquals', 'contains', 'exists', 'greaterThan', 'lessThan']

function blankStep(): DbStep {
  return { query: '', assertions: [{ type: 'rowCount', operator: 'greaterThan', expected: 0 }] }
}

type RunResult = { status: string; stepLogs: Array<{ action: string; status: string; details?: string }> | null; error: string | null } | null

export default function DbTestingPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()
  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : undefined

  const connections = useSWR<DbConnection[]>(
    projectId ? ['db-connections', projectId] : null,
    () => api.dbTesting.listConnections(projectId as string),
  )

  const [connectionId, setConnectionId] = useState('')
  const [name, setName] = useState('New database test')
  const [steps, setSteps] = useState<DbStep[]>([blankStep()])
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult>(null)

  const [releaseId, setReleaseId] = useState('')
  const [sprintId, setSprintId] = useState('')
  const releases = useSWR<Release[]>(projectId ? ['releases', projectId] : null, () => api.listReleases(projectId as string))
  const sprints = useSWR<Sprint[]>(releaseId ? ['release-sprints', releaseId] : null, () => api.listReleaseSprints(releaseId))

  const activeConnectionId = connectionId || connections.data?.[0]?.id || ''

  function updateStep(i: number, patch: Partial<DbStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  function updateAssertion(i: number, patch: Partial<NonNullable<DbStep['assertions']>[number]>) {
    setSteps((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s
        const a = s.assertions?.[0] ?? { type: 'rowCount' as DbAssertionType, operator: 'greaterThan' as DbAssertionOperator }
        return { ...s, assertions: [{ ...a, ...patch }] }
      }),
    )
  }

  async function generate() {
    if (!activeConnectionId) {
      triggerToast('Add a database connection first.', true)
      return
    }
    if (!prompt.trim()) {
      triggerToast('Describe what to test first.', true)
      return
    }
    setGenerating(true)
    try {
      const res = await api.dbTesting.generateFromPrompt({ test_name: name, prompt: prompt.trim(), connection_id: activeConnectionId })
      setSteps(res.steps.length ? res.steps : [blankStep()])
      triggerToast(`Generated ${res.steps.length} step(s).`)
    } catch (err) {
      triggerToast(`Generation failed: ${(err as Error).message}`, true)
    } finally {
      setGenerating(false)
    }
  }

  async function run() {
    if (!projectId || !activeConnectionId) {
      triggerToast('Select a product and a connection first.', true)
      return
    }
    if (!releaseId || !sprintId) {
      triggerToast('Select a release and sprint before running.', true)
      return
    }
    setRunning(true)
    setResult(null)
    try {
      const { executionId } = await api.dbTesting.run({
        projectId, name: name.trim() || 'Database Test', connectionId: activeConnectionId, steps, releaseId, sprintId,
      })
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((r) => setTimeout(r, 1500))
        const exec = await api.dbTesting.getExecution(executionId)
        if (exec.status === 'PASSED' || exec.status === 'FAILED') {
          setResult({ status: exec.status, stepLogs: exec.stepLogs, error: exec.error })
          triggerToast(exec.status === 'PASSED' ? 'Run passed.' : 'Run failed.', exec.status === 'FAILED')
          break
        }
      }
    } catch (err) {
      triggerToast(`Run failed: ${(err as Error).message}`, true)
    } finally {
      setRunning(false)
    }
  }

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Database Testing" description="Build, generate, and run database tests." />
        <EmptyState
          icon={Database}
          title="Select a product"
          description="Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  if (!connections.isLoading && (connections.data ?? []).length === 0) {
    return (
      <div>
        <PageHeader title="Database Testing" description="Build, generate, and run database tests." />
        <EmptyState
          icon={Database}
          title="No database connections yet"
          description="Add a connection before writing a database test."
          action={<Button href="/app/db-testing/connections">Add a connection</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Database Testing"
        description={`Build, generate, and run database tests for ${activeProject!.name}.`}
        actions={
          <>
            <Button href="/app/db-testing/connections" variant="outline" marker={false}>Connections</Button>
            <Button href="/app/db-testing/executions" variant="outline" marker={false}>Executions</Button>
          </>
        }
      />

      <Card className="mb-6 p-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Input label="Test name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Connection" value={activeConnectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {(connections.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.engine})</option>
            ))}
          </Select>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Select
            label="Release"
            value={releaseId}
            onChange={(e) => { setReleaseId(e.target.value); setSprintId('') }}
            helperText="Required — create new ones from the Releases page."
          >
            <option value="">Select a release…</option>
            {(releases.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          <Select
            label="Sprint"
            value={sprintId}
            onChange={(e) => setSprintId(e.target.value)}
            disabled={!releaseId}
            helperText={releaseId ? 'Required — attributes this run to a sprint.' : 'Pick a release first.'}
          >
            <option value="">Select a sprint…</option>
            {(sprints.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>

        <h2 className="mb-3 font-sans text-sm font-semibold text-ink">Generate from a prompt</h2>
        <div className="flex flex-col gap-3">
          <Textarea
            label="Describe what to test"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Verify the users table has no rows with a null email"
          />
          <div className="flex justify-end">
            <Button marker={false} variant="outline" disabled={generating} onClick={() => void generate()}>
              <Sparkles size={14} aria-hidden="true" />
              {generating ? 'Generating…' : 'Generate steps'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-4">
          {steps.map((step, i) => (
            <div key={i} className="rounded-md border border-line p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-xs text-muted uppercase">Step {i + 1}</span>
                <button
                  type="button"
                  onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-muted hover:text-fail"
                  aria-label="Remove step"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <Textarea
                label="SQL query (or Mongo filter JSON for a Mongo connection)"
                rows={2}
                value={step.query ?? ''}
                onChange={(e) => updateStep(i, { query: e.target.value })}
                placeholder="SELECT * FROM users WHERE email IS NULL"
              />
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Select
                  label="Assert"
                  value={step.assertions?.[0]?.type ?? 'rowCount'}
                  onChange={(e) => updateAssertion(i, { type: e.target.value as DbAssertionType })}
                >
                  {ASSERTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
                <Select
                  label="Operator"
                  value={step.assertions?.[0]?.operator ?? 'equals'}
                  onChange={(e) => updateAssertion(i, { operator: e.target.value as DbAssertionOperator })}
                >
                  {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
                <Input
                  label="Expected"
                  value={String(step.assertions?.[0]?.expected ?? '')}
                  onChange={(e) => updateAssertion(i, { expected: e.target.value })}
                  placeholder="0"
                />
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={!!step.commit} onChange={(e) => updateStep(i, { commit: e.target.checked })} />
                Commit this step (otherwise it always rolls back — safe by default)
              </label>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap justify-between gap-2">
          <Button variant="outline" marker={false} onClick={() => setSteps((prev) => [...prev, blankStep()])}>
            <Plus size={14} aria-hidden="true" /> Add step
          </Button>
          <Button marker={false} disabled={running || !releaseId || !sprintId} onClick={() => void run()}>
            {running ? 'Running…' : 'Run test'}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <StatusBadge status={(result.status === 'PASSED' ? 'pass' : 'fail') as Status} label={result.status} />
            {result.error && <span className="text-xs text-fail">{result.error}</span>}
          </div>
          <ul className="divide-y divide-line">
            {(result.stepLogs ?? []).map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-mono text-xs text-ink">{s.action}</span>
                <span className={`font-mono text-xs ${s.status === 'PASSED' ? 'text-pass' : s.status === 'FAILED' ? 'text-fail' : 'text-muted'}`}>{s.status}</span>
                {s.details && <span className="flex-1 truncate text-xs text-muted">{s.details}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
