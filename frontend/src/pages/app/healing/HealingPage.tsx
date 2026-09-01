import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Wand2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { Tabs } from '../../../components/ui/Tabs'
import { api } from '../../../lib/api'
import type { HealingEvent } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { HealingItemCard } from './components/HealingItemCard'

const tabs = [
  { id: 'PENDING', label: 'Needs review' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'REJECTED', label: 'Rejected' },
]

export default function HealingPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()
  const [activeTab, setActiveTab] = useState('PENDING')
  const [busyId, setBusyId] = useState<string | null>(null)

  // The endpoint has no project filter, so everything is fetched once and
  // scoped client-side from the suite/project the backend includes.
  const { data, error, isLoading, mutate } = useSWR<HealingEvent[]>('healing-events', () =>
    api.getHealingEvents(),
  )

  const scoped = useMemo(() => {
    const events = data ?? []
    if (!activeProject || isAllProjects(activeProject)) return events
    return events.filter(
      (event) => event.executionLog?.suite?.project?.id === activeProject.id,
    )
  }, [data, activeProject])

  const counts = useMemo(
    () => ({
      PENDING: scoped.filter((event) => event.status === 'PENDING').length,
      APPROVED: scoped.filter((event) => event.status === 'APPROVED').length,
      REJECTED: scoped.filter((event) => event.status === 'REJECTED').length,
    }),
    [scoped],
  )

  const visible = useMemo(
    () => scoped.filter((event) => event.status === activeTab),
    [scoped, activeTab],
  )

  async function decide(id: string, approve: boolean) {
    setBusyId(id)
    try {
      if (approve) {
        await api.approveHealingEvent(id)
        triggerToast('Approved. The healed selector is now saved to the test steps.')
      } else {
        await api.rejectHealingEvent(id)
        triggerToast('Rejected. The test steps are unchanged.')
      }
      await mutate()
    } catch (err) {
      triggerToast(`Could not update: ${(err as Error).message}`, true)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="AutoHeal"
        description="Selector repairs the execution agent made during runs. Approve one to write it back into the saved test."
      />

      {error ? (
        <ErrorState
          title="Could not load healing events"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={() => void mutate()}>
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
      ) : scoped.length === 0 ? (
        <EmptyState
          icon={Wand2}
          title="No healing events yet"
          description="When a selector breaks mid-run and the agent finds a confident replacement, it shows up here for review."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-3 gap-3">
            <StatTile label="Needs review" value={counts.PENDING} />
            <StatTile label="Approved" value={counts.APPROVED} />
            <StatTile label="Rejected" value={counts.REJECTED} />
          </div>

          <Tabs tabs={tabs} activeId={activeTab} onChange={setActiveTab} className="mb-5" />

          {visible.length === 0 ? (
            <EmptyState
              icon={Wand2}
              title={`Nothing ${activeTab.toLowerCase()}`}
              description="There are no healing events in this state for the selected project."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((item) => (
                <HealingItemCard
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onApprove={(id) => void decide(id, true)}
                  onReject={(id) => void decide(id, false)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
