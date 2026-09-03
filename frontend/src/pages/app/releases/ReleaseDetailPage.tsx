import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSWR from 'swr'
import { GitCompare, Plus } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { Release, ReleaseStatus, Sprint } from '../../../lib/types'
import { ReleaseStatusBadge, SprintStatusBadge } from './statusBadges'

const RELEASE_STATUSES: ReleaseStatus[] = ['PLANNED', 'ACTIVE', 'RELEASED', 'ARCHIVED']

export default function ReleaseDetailPage() {
  const { releaseId = '' } = useParams()
  const { triggerToast } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [sprintName, setSprintName] = useState('')
  const [creating, setCreating] = useState(false)

  const release = useSWR<Release>(releaseId ? ['release', releaseId] : null, () => api.getRelease(releaseId))
  const sprints = useSWR<Sprint[]>(releaseId ? ['release-sprints', releaseId] : null, () => api.listReleaseSprints(releaseId))

  async function setStatus(status: ReleaseStatus) {
    try {
      await api.updateRelease(releaseId, { status })
      await release.mutate()
      triggerToast(`Release marked ${status}.`)
    } catch (err) {
      triggerToast(`Could not update release: ${(err as Error).message}`, true)
    }
  }

  async function createSprint() {
    if (!sprintName.trim()) return
    setCreating(true)
    try {
      const created = await api.createSprint({ releaseId, name: sprintName.trim() })
      await sprints.mutate()
      setCreateOpen(false)
      setSprintName('')
      triggerToast(`Sprint "${created.name}" created.`)
    } catch (err) {
      triggerToast(`Could not create sprint: ${(err as Error).message}`, true)
    } finally {
      setCreating(false)
    }
  }

  const columns: DataTableColumn<Sprint>[] = [
    {
      key: 'name',
      header: 'Sprint',
      render: (s) => (
        <Link
          to={`/app/releases/${releaseId}/sprints/${s.id}`}
          className="font-medium text-ink hover:text-accent-deep hover:underline"
        >
          {s.name}
        </Link>
      ),
    },
    { key: 'sequence', header: 'Seq', align: 'right', render: (s) => <span className="font-mono text-xs">{s.sequence}</span> },
    { key: 'status', header: 'Status', render: (s) => <SprintStatusBadge status={s.status} /> },
    {
      key: 'dates',
      header: 'Dates',
      render: (s) => (
        <span className="font-mono text-xs text-muted">
          {s.startDate ? new Date(s.startDate).toLocaleDateString() : '—'} → {s.endDate ? new Date(s.endDate).toLocaleDateString() : '—'}
        </span>
      ),
    },
    {
      key: 'open',
      header: '',
      align: 'right',
      render: (s) => (
        <Link to={`/app/releases/${releaseId}/sprints/${s.id}`} className="font-mono text-xs text-accent hover:underline">
          Open →
        </Link>
      ),
    },
  ]

  if (release.error) {
    return (
      <div>
        <PageHeader title="Release" />
        <ErrorState title="Could not load release" description={(release.error as Error).message} action={<Button href="/app/releases" marker={false}>Back to releases</Button>} />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={release.data?.name ?? 'Release'}
        description={release.data?.description || 'Sprints in this release.'}
        actions={
          <>
            <Button href="/app/reports/release-comparison" variant="outline" marker={false}>
              <GitCompare size={14} aria-hidden="true" /> Compare
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={14} aria-hidden="true" /> New Sprint
            </Button>
          </>
        }
      />

      <Card className="mb-6 flex flex-wrap items-center gap-4 p-4">
        {release.isLoading || !release.data ? (
          <Skeleton className="h-8 w-64" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted uppercase">Status</span>
              <ReleaseStatusBadge status={release.data.status} />
            </div>
            <div className="w-44">
              <Select
                aria-label="Release status"
                value={release.data.status ?? 'PLANNED'}
                onChange={(e) => void setStatus(e.target.value as ReleaseStatus)}
              >
                {RELEASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
            <div className="font-mono text-xs text-muted">
              Sequence {release.data.sequence ?? '—'} · created {new Date(release.data.createdAt).toLocaleDateString()}
            </div>
          </>
        )}
      </Card>

      {sprints.error ? (
        <ErrorState title="Could not load sprints" description={(sprints.error as Error).message} action={<Button marker={false} onClick={() => void sprints.mutate()}>Try again</Button>} />
      ) : sprints.isLoading ? (
        <Skeleton className="h-48 w-full rounded-card" />
      ) : (sprints.data ?? []).length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No sprints yet"
          description="Add a sprint, then assign test cases to it and run them."
          action={<Button onClick={() => setCreateOpen(true)}>New Sprint</Button>}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable columns={columns} rows={sprints.data ?? []} getRowKey={(s) => s.id} />
        </Card>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New sprint">
        <div className="flex flex-col gap-3">
          <Input label="Name" value={sprintName} onChange={(e) => setSprintName(e.target.value)} placeholder="e.g. Sprint 2.1" autoFocus />
          <p className="text-xs text-muted">Sequence and status (Planned) are set automatically. Edit them on the sprint page.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" marker={false} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button marker={false} disabled={creating || !sprintName.trim()} onClick={() => void createSprint()}>
              {creating ? 'Creating…' : 'Create sprint'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
