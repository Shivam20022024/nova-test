import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Wand2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Chip } from '../../../components/ui/Chip'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { api } from '../../../lib/api'
import type { HealingEvent, MobileHealingRecord, MobileLocator, RunSource } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { HealingItemCard } from './components/HealingItemCard'
import { MobileHealingItemCard } from './components/MobileHealingItemCard'

type SourceFilter = RunSource | 'all'

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'web', label: 'Web' },
  { id: 'mobile', label: 'Mobile' },
]

// Mobile's finer-grained status vocabulary — see MobileHealingItemCard for
// where these actually matter (only DEAD_END gets a manual-fix affordance).
const MOBILE_DEAD_END = new Set(['REQUIRES_REVIEW', 'PENDING_APPROVAL'])

export default function HealingPage() {
  const { activeProject, scopedProjectId } = useData()
  const { triggerToast } = useToast()
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)

  // The web endpoint has no project filter, so everything is fetched once and
  // scoped client-side from the suite/project the backend includes. The
  // mobile endpoint does take project_uuid directly (see backend/mobile/api.py).
  const web = useSWR<HealingEvent[]>('healing-events', () => api.getHealingEvents())
  const mobile = useSWR<MobileHealingRecord[]>(['mobile-healing-events', scopedProjectId], () =>
    api.mobile.getHealingHistory(scopedProjectId ? { project_uuid: scopedProjectId } : {}),
  )

  const isLoading = web.isLoading || mobile.isLoading
  const error = web.error // a mobile-side failure shouldn't blank the whole page — see mobileScoped below

  const webScoped = useMemo(() => {
    const events = web.data ?? []
    if (!activeProject || isAllProjects(activeProject)) return events
    return events.filter((event) => event.executionLog?.suite?.project?.id === activeProject.id)
  }, [web.data, activeProject])

  const mobileScoped = useMemo(() => mobile.data ?? [], [mobile.data])

  const visibleWeb = useMemo(() => (sourceFilter === 'mobile' ? [] : webScoped), [webScoped, sourceFilter])
  const visibleMobile = useMemo(() => (sourceFilter === 'web' ? [] : mobileScoped), [mobileScoped, sourceFilter])

  // One reverse-chronological feed instead of a review queue — nothing here
  // is waiting on a decision, so there's no reason to bucket by status.
  const combined = useMemo(() => {
    const webItems = visibleWeb.map((item) => ({ kind: 'web' as const, item, at: item.createdAt }))
    const mobileItems = visibleMobile.map((item) => ({ kind: 'mobile' as const, item, at: item.created_at }))
    return [...webItems, ...mobileItems].sort(
      (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
    )
  }, [visibleWeb, visibleMobile])

  const totalCount = webScoped.length + mobileScoped.length
  const needsManualFixCount = mobileScoped.filter((r) => MOBILE_DEAD_END.has(r.status)).length
  const autoHealedCount = totalCount - needsManualFixCount

  async function retryWithLocator(id: number, locator: MobileLocator) {
    setBusyId(String(id))
    try {
      const result = await api.mobile.approveHealing(id, locator)
      triggerToast(`Retrying.${result.rerun_execution_id ? ` New run #${result.rerun_execution_id}.` : ''}`)
      await mobile.mutate()
    } catch (err) {
      triggerToast(`Could not retry: ${(err as Error).message}`, true)
    } finally {
      setBusyId(null)
    }
  }

  async function dismiss(id: number) {
    setBusyId(String(id))
    try {
      await api.mobile.rejectHealing(id)
      triggerToast('Dismissed.')
      await mobile.mutate()
    } catch (err) {
      triggerToast(`Could not dismiss: ${(err as Error).message}`, true)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="AutoHeal"
        description="A log of every selector/locator AutoHeal has fixed automatically — web and mobile. Fixes are applied and saved the moment they're found; nothing here needs a decision."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Show:</span>
        {SOURCE_FILTERS.map((filter) => (
          <Chip key={filter.id} active={sourceFilter === filter.id} onClick={() => setSourceFilter(filter.id)}>
            {filter.label}
          </Chip>
        ))}
      </div>

      {error ? (
        <ErrorState
          title="Could not load healing events"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={() => void web.mutate()}>
              Try again
            </Button>
          }
        />
      ) : isLoading ? (
        <div aria-hidden="true" className="flex flex-col gap-4">
          <Skeleton className="h-20 w-full rounded-card" />
          <Skeleton className="h-40 w-full rounded-card" />
          <Skeleton className="h-40 w-full rounded-card" />
        </div>
      ) : totalCount === 0 ? (
        <EmptyState
          icon={Wand2}
          title="No healing events yet"
          description="When a selector or locator breaks mid-run, AutoHeal analyzes it, applies a fix, and keeps the test running — it shows up here automatically."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3">
            <StatTile label="Auto-healed" value={autoHealedCount} />
            <StatTile label="Needs manual fix" value={needsManualFixCount} />
          </div>

          <div className="flex flex-col gap-3">
            {combined.map(({ kind, item }) =>
              kind === 'web' ? (
                <HealingItemCard key={`web-${item.id}`} item={item} />
              ) : (
                <MobileHealingItemCard
                  key={`mobile-${item.id}`}
                  item={item}
                  busy={busyId === String(item.id)}
                  onRetryWithLocator={retryWithLocator}
                  onDismiss={dismiss}
                />
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}
