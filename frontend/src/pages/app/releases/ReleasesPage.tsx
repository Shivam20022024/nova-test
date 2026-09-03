import { useState } from 'react'
import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { Milestone, Plus } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { useData, isAllProjects } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { Release } from '../../../lib/types'
import { ReleaseStatusBadge } from './statusBadges'

export default function ReleasesPage() {
  const { activeProject, scopedProjectId } = useData()
  const { triggerToast } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const releases = useSWR<Release[]>(
    scopedProjectId ? ['releases', scopedProjectId] : null,
    () => api.listReleases(scopedProjectId),
  )

  async function createRelease() {
    if (!scopedProjectId || !name.trim()) return
    setCreating(true)
    try {
      const created = await api.createRelease({ projectId: scopedProjectId, name: name.trim(), description: description.trim() || undefined })
      await releases.mutate()
      setCreateOpen(false)
      setName('')
      setDescription('')
      triggerToast(`Release "${created.name}" created.`)
    } catch (err) {
      triggerToast(`Could not create release: ${(err as Error).message}`, true)
    } finally {
      setCreating(false)
    }
  }

  if (!activeProject || isAllProjects(activeProject)) {
    return (
      <div>
        <PageHeader title="Releases" description="Organize test cases into releases and sprints." />
        <EmptyState
          icon={Milestone}
          title="Select a product"
          description="Releases belong to a product. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Releases"
        description={`Releases and sprints for ${activeProject.name}.`}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={14} aria-hidden="true" /> New Release
          </Button>
        }
      />

      {releases.error ? (
        <ErrorState
          title="Could not load releases"
          description={(releases.error as Error).message}
          action={<Button marker={false} onClick={() => void releases.mutate()}>Try again</Button>}
        />
      ) : releases.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-card" />)}
        </div>
      ) : (releases.data ?? []).length === 0 ? (
        <EmptyState
          icon={Milestone}
          title="No releases yet"
          description="Create a release, then add sprints and assign test cases to them."
          action={<Button onClick={() => setCreateOpen(true)}>New Release</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(releases.data ?? []).map((r) => (
            <Card key={r.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/app/releases/${r.id}`} className="font-sans text-sm font-semibold text-ink hover:text-accent-deep hover:underline">
                  {r.name}
                </Link>
                <ReleaseStatusBadge status={r.status} />
              </div>
              {r.description && <p className="text-xs text-muted">{r.description}</p>}
              <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted">
                <div>
                  <dt className="uppercase">Sequence</dt>
                  <dd className="text-ink">{r.sequence ?? '—'}</dd>
                </div>
                <div>
                  <dt className="uppercase">Created</dt>
                  <dd className="text-ink">{new Date(r.createdAt).toLocaleDateString()}</dd>
                </div>
              </dl>
              <Link
                to={`/app/releases/${r.id}`}
                className="font-mono text-xs text-accent hover:underline"
              >
                Open release →
              </Link>
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New release">
        <div className="flex flex-col gap-3">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release 2" autoFocus />
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <p className="text-xs text-muted">
            A release is a free-text checkpoint. Its sequence is assigned automatically; edit it on the release page.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button marker={false} disabled={creating || !name.trim()} onClick={() => void createRelease()}>
              {creating ? 'Creating…' : 'Create release'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
