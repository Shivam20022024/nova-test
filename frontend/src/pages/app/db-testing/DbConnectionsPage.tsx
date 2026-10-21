import { useState } from 'react'
import useSWR from 'swr'
import { CheckCircle2, Database, Plug, Plus, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { useData, isAllProjects } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { DbConnection, DbEngine } from '../../../lib/types'

const ENGINES: DbEngine[] = ['postgres', 'mysql', 'mongodb']

export default function DbConnectionsPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()
  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : undefined

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', engine: 'postgres' as DbEngine, host: '', port: '5432', database: '', username: '', password: '', ssl: true })

  const connections = useSWR<DbConnection[]>(
    projectId ? ['db-connections', projectId] : null,
    () => api.dbTesting.listConnections(projectId as string),
  )

  async function create() {
    if (!projectId || !form.name || !form.host || !form.database || !form.username || !form.password) {
      triggerToast('Fill in every field.', true)
      return
    }
    setCreating(true)
    try {
      await api.dbTesting.createConnection({
        projectId,
        name: form.name,
        engine: form.engine,
        host: form.host,
        port: Number(form.port) || 5432,
        database: form.database,
        username: form.username,
        password: form.password,
        ssl: form.ssl,
      })
      await connections.mutate()
      setCreateOpen(false)
      setForm({ name: '', engine: 'postgres', host: '', port: '5432', database: '', username: '', password: '', ssl: true })
      triggerToast('Connection saved.')
    } catch (err) {
      triggerToast(`Could not save connection: ${(err as Error).message}`, true)
    } finally {
      setCreating(false)
    }
  }

  async function test(id: string) {
    setTestingId(id)
    try {
      const res = await api.dbTesting.testConnection(id)
      triggerToast(res.success ? 'Connection verified.' : `Connection failed: ${res.error}`, !res.success)
    } catch (err) {
      triggerToast(`Test failed: ${(err as Error).message}`, true)
    } finally {
      setTestingId(null)
    }
  }

  async function remove(conn: DbConnection) {
    if (!window.confirm(`Delete connection "${conn.name}"? Test history that used it is kept.`)) return
    try {
      await api.dbTesting.deleteConnection(conn.id)
      await connections.mutate()
      triggerToast('Connection deleted.')
    } catch (err) {
      triggerToast(`Could not delete: ${(err as Error).message}`, true)
    }
  }

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Database Connections" description="Saved connections for database testing." />
        <EmptyState
          icon={Database}
          title="Select a product"
          description="Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Database Connections"
        description={`Saved connections for ${activeProject!.name}. Passwords are encrypted at rest and never returned by the API.`}
        actions={
          <>
            <Button href="/app/db-testing/executions" variant="outline" marker={false}>Executions</Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={14} aria-hidden="true" /> New Connection
            </Button>
          </>
        }
      />

      {connections.error ? (
        <ErrorState
          title="Could not load connections"
          description={(connections.error as Error).message}
          action={<Button marker={false} onClick={() => void connections.mutate()}>Try again</Button>}
        />
      ) : connections.isLoading ? (
        <Skeleton className="h-48 w-full rounded-card" />
      ) : (connections.data ?? []).length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connections yet"
          description="Add a database connection to start writing and running database tests."
          action={<Button onClick={() => setCreateOpen(true)}>New Connection</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(connections.data ?? []).map((c) => (
            <Card key={c.id} className="flex flex-col gap-2 p-5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-sans text-sm font-semibold text-ink">{c.name}</span>
                <span className="font-mono text-xs uppercase text-muted">{c.engine}</span>
              </div>
              <p className="font-mono text-xs text-muted">{c.username}@{c.host}:{c.port}/{c.database}</p>
              <div className="mt-auto flex items-center justify-between pt-2">
                <button
                  type="button"
                  disabled={testingId === c.id}
                  onClick={() => void test(c.id)}
                  className="flex items-center gap-1 font-mono text-xs text-accent hover:underline disabled:opacity-50"
                >
                  {testingId === c.id ? 'Testing…' : (<><CheckCircle2 size={13} aria-hidden="true" /> Test connection</>)}
                </button>
                <button type="button" onClick={() => void remove(c)} className="text-muted hover:text-fail" aria-label={`Delete ${c.name}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New database connection">
        <div className="flex flex-col gap-3">
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Staging Postgres" autoFocus />
          <Select label="Engine" value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value as DbEngine })}>
            {ENGINES.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input label="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="db.example.com" />
            </div>
            <Input label="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          </div>
          <Input label="Database" value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            <Input label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} />
            Use SSL
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button marker={false} disabled={creating} onClick={() => void create()}>
              {creating ? 'Saving…' : 'Save connection'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
