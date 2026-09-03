import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Smartphone } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { api } from '../../../lib/api'
import type { MobileSuite } from '../../../lib/types'
import { formatDuration, statusLabel, suiteBadge, toStatus } from './mobileStatus'
import { LiveExecutionPanel } from './components/LiveExecutionPanel'

const RUNNING_LIKE = new Set(['QUEUED', 'RUNNING'])

/**
 * Landing page for a suite the moment it starts — reached immediately after
 * generating/importing a mobile test, the same way One-Click Test drops you
 * straight onto the web execution's live view instead of leaving you to go
 * find it. A "suite" is the right unit to land on here (not a single
 * execution): an Author-generated test is a suite of one, but a CSV/XLSX
 * import or batch generation can be a suite of many, and this page has to
 * make sense for both.
 */
export default function MobileSuiteRunPage() {
  const { suiteId = '' } = useParams()
  const navigate = useNavigate()

  const [suite, setSuite] = useState<MobileSuite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeExecutionId, setActiveExecutionId] = useState<number | null>(null)
  // Once the viewer has clicked a specific test row, stop auto-following
  // whichever test happens to be running and respect that choice.
  const pinnedRef = useRef(false)
  // Mirrors `suite.status` so the polling interval can decide whether to keep
  // going without taking `suite` as an effect dependency (which would tear the
  // interval down and rebuild it on every single poll tick).
  const statusRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.mobile.getSuite(Number(suiteId))
      setSuite(fresh)
      statusRef.current = fresh.status
      setError(null)
      if (!pinnedRef.current) {
        const running = fresh.tests.find((t) => t.execution_id != null && RUNNING_LIKE.has(t.status))
        const anyStarted = fresh.tests.find((t) => t.execution_id != null)
        const next = running ?? anyStarted
        if (next?.execution_id != null) setActiveExecutionId(next.execution_id)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [suiteId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (statusRef.current === 'COMPLETED') {
        clearInterval(timer)
        return
      }
      void refresh()
    }, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const backAction = (
    <Button variant="outline" marker={false} onClick={() => navigate('/app/mobile/executions')}>
      <ArrowLeft size={14} aria-hidden="true" />
      Back to Executions
    </Button>
  )

  if (loading) {
    return (
      <div>
        <PageHeader title="Running…" actions={backAction} />
        <Card className="p-6">
          <Skeleton className="h-6 w-64" />
          <div className="mt-5 flex flex-col gap-3">
            <Skeleton className="h-64 w-full" />
          </div>
        </Card>
      </div>
    )
  }

  if (error || !suite) {
    return (
      <div>
        <PageHeader title="Run not found" actions={backAction} />
        <EmptyState icon={AlertTriangle} title="Could not load this run" description={error ?? 'Unknown error.'} />
      </div>
    )
  }

  const total = suite.test_count || 1

  return (
    <div>
      <PageHeader
        title={suite.name}
        description={`${suite.application_name ?? 'Unknown app'}${suite.device_id ? ' · on device' : ''}`}
        actions={backAction}
      />

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <StatusBadge {...suiteBadge(suite)} />
            <span className="font-mono text-xs text-muted">
              {suite.passed_count}/{suite.test_count} tests passed
            </span>
          </div>
          <div className="flex h-1.5 w-40 overflow-hidden rounded-full bg-line" role="img"
            aria-label={`${suite.passed_count} passed, ${suite.failed_count} failed, ${suite.blocked_count} blocked, ${suite.skipped_count} skipped`}>
            <span style={{ width: `${(suite.passed_count / total) * 100}%`, backgroundColor: 'var(--color-pass)' }} />
            <span style={{ width: `${(suite.failed_count / total) * 100}%`, backgroundColor: 'var(--color-fail)' }} />
            <span style={{ width: `${(suite.blocked_count / total) * 100}%`, backgroundColor: 'var(--color-blocked)' }} />
            <span style={{ width: `${(suite.skipped_count / total) * 100}%`, backgroundColor: 'var(--color-blocked)' }} />
          </div>
        </div>

        {/* Only worth showing as a picker once there is more than one test —
            an Author-generated test is a suite of one and this would just be
            a single redundant row above the live view below. */}
        {suite.tests.length > 1 && (
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {suite.tests.map((row) => (
              <li key={row.test_id}>
                <button
                  type="button"
                  disabled={row.execution_id == null}
                  onClick={() => {
                    pinnedRef.current = true
                    if (row.execution_id != null) setActiveExecutionId(row.execution_id)
                  }}
                  className={`flex w-full items-center justify-between gap-3 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                    row.execution_id === activeExecutionId ? 'text-accent' : 'text-ink'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted">{formatDuration(row.duration_ms)}</span>
                    <StatusBadge status={toStatus(row.status)} label={statusLabel(row.status)} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {activeExecutionId != null ? (
        <LiveExecutionPanel executionId={activeExecutionId} onClose={() => navigate('/app/mobile/executions')} />
      ) : (
        <Card className="p-6">
          <EmptyState
            icon={Smartphone}
            title="Waiting for the run to start"
            description="This suite hasn't allocated a device yet — it should begin in a few seconds."
          />
        </Card>
      )}
    </div>
  )
}
