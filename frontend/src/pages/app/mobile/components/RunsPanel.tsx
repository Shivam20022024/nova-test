import { PlayCircle } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { MobileExecution } from '../../../../lib/types'
import { formatDuration, formatWhen, statusLabel, toStatus } from '../mobileStatus'

type Props = {
  executions: MobileExecution[]
  loading: boolean
  activeId: number | null
  onWatch: (id: number) => void
}

export function RunsPanel({ executions, loading, activeId, onWatch }: Props) {
  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-6 w-40" />
        <div className="mt-5 flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <h2 className="font-sans text-base font-semibold text-ink">Recent runs</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Every run in this project, however it was started. Open any one to replay its evidence, or watch it live
        if it is still going.
      </p>

      {executions.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={PlayCircle}
          title="Nothing has run yet"
          description="Generate or import a test, pick a device, and the run will appear here."
        />
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {executions.map((execution) => {
            const active = activeId === execution.id
            return (
              <li
                key={execution.id}
                className={`flex flex-wrap items-center gap-4 py-3 transition-colors duration-150 ${
                  active ? 'bg-accent-soft/30' : ''
                }`}
              >
                <span className="w-12 shrink-0 font-mono text-xs text-muted">#{execution.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{execution.test_name ?? `Test ${execution.test_id}`}</span>
                  <span className="mt-0.5 block font-mono text-xs text-muted">
                    {formatWhen(execution.started_at)} · {formatDuration(execution.duration_ms)}
                  </span>
                </span>
                <StatusBadge status={toStatus(execution.status)} label={statusLabel(execution.status)} />
                <Button variant="outline" marker={false} onClick={() => onWatch(execution.id)}>
                  {active ? 'Viewing' : 'Open'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
