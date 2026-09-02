import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { GitCompare, Plus } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Chip } from '../../../components/ui/Chip'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { api } from '../../../lib/api'
import type { Release, ReleaseComparisonEntry } from '../../../lib/types'

/** Suggests a plausible "next" name from the most recent release's name —
 *  purely a starting point in the text box, never a locked choice. Falls
 *  back to "1.0" for the very first release, and leaves anything it can't
 *  parse as a trailing number alone (the person just types their own name). */
function suggestNextName(releases: Release[]): string {
  if (releases.length === 0) return '1.0'
  const latest = releases[0]!.name
  const match = latest.match(/^(.*?)(\d+)(\.(\d+))?$/)
  if (!match) return ''
  const [, prefix, major, , minor] = match
  if (minor !== undefined) return `${prefix}${major}.${Number(minor) + 1}`
  return `${prefix}${major}.1`
}

export default function ReleaseComparisonPage() {
  const { activeProject, scopedProjectId } = useData()
  const { triggerToast } = useToast()
  const [selected, setSelected] = useState<string[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const releases = useSWR<Release[]>(['releases', scopedProjectId], () => api.listReleases(scopedProjectId))

  const comparison = useSWR<ReleaseComparisonEntry[]>(
    selected.length >= 2 ? ['release-comparison', selected] : null,
    () => api.compareReleases(selected),
  )

  const suggested = useMemo(() => suggestNextName(releases.data ?? []), [releases.data])

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function createRelease() {
    const name = newName.trim() || suggested
    if (!name) return
    if (!scopedProjectId) {
      triggerToast('Select a specific project before creating a release.', true)
      return
    }
    setCreating(true)
    try {
      await api.createRelease({ projectId: scopedProjectId, name })
      setNewName('')
      await releases.mutate()
      triggerToast(`Release "${name}" created.`)
    } catch (err) {
      triggerToast(`Could not create release: ${(err as Error).message}`, true)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Compare Releases"
        description={`Pick two or more named releases to see how web and mobile tests did on each one, for ${activeProject?.name ?? 'all projects'}.`}
      />

      <Card className="mb-6 p-5">
        <h2 className="font-sans text-sm font-semibold text-ink">Releases</h2>
        <p className="mt-1 text-xs text-muted">
          A release is just a name you attach to test runs — a checkpoint, not a version format. Type anything.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Input
              label="New release name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={suggested || 'e.g. Sprint 14'}
            />
          </div>
          <Button marker={false} disabled={creating} onClick={() => void createRelease()}>
            <Plus size={14} aria-hidden="true" />
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>

        {releases.isLoading ? (
          <Skeleton className="mt-4 h-8 w-full rounded-full" />
        ) : (releases.data ?? []).length === 0 ? (
          <p className="mt-4 text-xs text-muted">No releases yet — create one above, then tag test runs with it.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {(releases.data ?? []).map((r) => (
              <Chip key={r.id} active={selected.includes(r.id)} onClick={() => toggle(r.id)}>
                {r.name}
              </Chip>
            ))}
          </div>
        )}
      </Card>

      {selected.length < 2 ? (
        <EmptyState
          icon={GitCompare}
          title="Pick 2 or more releases"
          description="Select releases above to compare their web and mobile test results side by side."
        />
      ) : comparison.error ? (
        <ErrorState
          title="Could not load comparison"
          description={(comparison.error as Error).message}
          action={
            <Button marker={false} onClick={() => void comparison.mutate()}>
              Try again
            </Button>
          }
        />
      ) : comparison.isLoading || !comparison.data ? (
        <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {selected.map((id) => (
            <Skeleton key={id} className="h-56 w-full rounded-card" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {comparison.data.map((entry) => (
            <Card key={entry.releaseId} className="p-5">
              <h3 className="font-sans text-sm font-semibold text-ink">{entry.release?.name ?? 'Unknown release'}</h3>
              {entry.release?.description && (
                <p className="mt-1 text-xs text-muted">{entry.release.description}</p>
              )}

              <p className="mt-4 font-mono text-xs tracking-wide text-muted uppercase">Web</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <StatTile label="Runs" value={entry.web.totalExecutions} />
                <StatTile label="Success" value={entry.web.successRate} unit="%" />
              </div>

              <p className="mt-4 font-mono text-xs tracking-wide text-muted uppercase">Mobile</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <StatTile label="Runs" value={entry.mobile.totalExecutions} />
                <StatTile label="Success" value={entry.mobile.successRate} unit="%" />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
