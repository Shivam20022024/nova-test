import useSWR from 'swr'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatTile } from '../../../components/ui/StatTile'
import { StatusBadge, type Status } from '../../../components/ui/StatusBadge'
import { useData } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type { ReleaseReadiness } from '../../../lib/types'

/** Reuses the platform's existing status-color system rather than inventing
 *  a fourth palette for this one page — GO reads as a pass, NO_GO as a
 *  fail, GO_WITH_RISK as flaky (amber, the same "proceed with caution"
 *  color used everywhere else), INCONCLUSIVE as blocked (gray, "nothing to
 *  judge yet"). */
const VERDICT_STATUS: Record<ReleaseReadiness['verdict'], Status> = {
  GO: 'pass',
  GO_WITH_RISK: 'flaky',
  NO_GO: 'fail',
  INCONCLUSIVE: 'blocked',
}

const VERDICT_LABEL: Record<ReleaseReadiness['verdict'], string> = {
  GO: 'GO',
  GO_WITH_RISK: 'GO — WITH RISK',
  NO_GO: 'NO-GO',
  INCONCLUSIVE: 'INCONCLUSIVE',
}

const VERDICT_EXPLANATION: Record<ReleaseReadiness['verdict'], string> = {
  GO: 'Nothing in the recent execution history is flagging a concern.',
  GO_WITH_RISK: 'Recent runs show some failures or filed defects — worth a look before you ship, not necessarily a blocker.',
  NO_GO: 'More than one in five recent runs failed. That crosses the fixed gate this page checks against.',
  INCONCLUSIVE: 'There is no execution history yet for this project to base a verdict on.',
}

export default function ReleaseReadinessPage() {
  const { activeProject, scopedProjectId } = useData()
  const scope = scopedProjectId ?? 'all'

  const readiness = useSWR<ReleaseReadiness>(['release-readiness', scope], () =>
    api.getReleaseReadiness(scopedProjectId),
  )

  const data = readiness.data

  return (
    <div>
      <PageHeader
        title="Release Readiness"
        description={`A GO / GO-WITH-RISK / NO-GO recommendation for ${activeProject?.name ?? 'all projects'}, built from real recent execution history.`}
        actions={
          <Button variant="outline" marker={false} onClick={() => readiness.mutate()} disabled={readiness.isValidating}>
            <RefreshCw size={15} aria-hidden="true" className={readiness.isValidating ? 'animate-spin' : ''} />
            {readiness.isValidating ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {readiness.error ? (
        <ErrorState
          title="Could not compute release readiness"
          description={(readiness.error as Error).message}
          action={
            <Button marker={false} onClick={() => readiness.mutate()}>
              Try again
            </Button>
          }
        />
      ) : readiness.isLoading || !data ? (
        <div aria-hidden="true" className="flex flex-col gap-6">
          <Skeleton className="h-32 w-full rounded-card" />
          <Skeleton className="h-20 w-full rounded-card" />
        </div>
      ) : data.verdict === 'INCONCLUSIVE' ? (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing to judge yet"
          description="This page reads recent execution history to produce a verdict. Run a test to populate it."
          action={<Button href="/app/one-click-test">Run a test</Button>}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-mono text-xs tracking-wide text-muted uppercase">Verdict</p>
                <div className="mt-2 flex items-center gap-3">
                  <StatusBadge status={VERDICT_STATUS[data.verdict]} label={VERDICT_LABEL[data.verdict]} />
                  {data.score != null && (
                    <span className="font-mono text-sm text-muted">
                      score <span className="font-semibold text-ink">{data.score}</span>/100
                    </span>
                  )}
                </div>
                <p className="mt-3 max-w-prose text-sm text-ink-soft">{VERDICT_EXPLANATION[data.verdict]}</p>
              </div>
            </div>

            {data.reasons.length > 0 && (
              <ul className="mt-5 flex flex-col gap-1.5 border-t border-line pt-4">
                {data.reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-2 text-sm text-ink-soft">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted" />
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Runs checked" value={data.window} />
            <StatTile label="Failed" value={data.failedCount} />
            <StatTile label="Failure rate" value={data.failureRate} unit="%" />
            <StatTile label="Recent defects" value={data.recentDefectCount} />
          </div>

          <Card className="p-5">
            <h2 className="font-sans text-sm font-semibold text-ink">How this verdict is decided</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Three fixed rules over the most recent {data.window} runs — not a model, nothing hidden.
            </p>
            <dl className="mt-4 flex flex-col gap-3 text-sm">
              <div className="flex gap-3">
                <dt className="w-32 shrink-0"><StatusBadge status="fail" label="NO-GO" /></dt>
                <dd className="text-ink-soft">More than 20% of recent runs failed.</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-32 shrink-0"><StatusBadge status="flaky" label="GO — RISK" /></dt>
                <dd className="text-ink-soft">1-20% failed, or a recent failure already has a defect filed against it.</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-32 shrink-0"><StatusBadge status="pass" label="GO" /></dt>
                <dd className="text-ink-soft">No failures and no recently-filed defects in the window.</dd>
              </div>
            </dl>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">{data.mobileDefectTrackingNote}</p>
          </Card>
        </div>
      )}
    </div>
  )
}
