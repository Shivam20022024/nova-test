import { useParams, Link } from 'react-router-dom'
import useSWR from 'swr'
import { Network } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type { ProjectTraceability } from '../../../lib/types'
import { ReleaseStatusBadge, SprintStatusBadge } from '../releases/statusBadges'

/** Compact counts strip used at both release and sprint level. */
function Counts({ items }: { items: [string, number][] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
      {items.map(([label, value]) => (
        <span key={label} className={value > 0 && label === 'regressions' ? 'text-fail' : 'text-muted'}>
          {label} <span className="text-ink">{value}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * One product's full Release → Sprint tree with rolled-up results. Reached two
 * ways: the "Traceability" sidebar item (uses the active product from the top
 * bar) and Projects → "View traceability" (uses the :projectId in the URL).
 */
export default function ProjectTraceabilityPage() {
  const { projectId: routeProjectId } = useParams()
  const { activeProject } = useData()

  const activeId =
    activeProject && !isAllProjects(activeProject) ? activeProject.id : undefined
  const projectId = routeProjectId ?? activeId

  const trace = useSWR<ProjectTraceability>(
    projectId ? ['project-traceability', projectId] : null,
    () => api.getProjectTraceability(projectId as string),
  )

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Traceability" description="Releases and sprints for the selected product." />
        <EmptyState
          icon={Network}
          title="Select a product"
          description="Pick a product from the menu in the top bar to see its releases, sprints and results."
        />
      </div>
    )
  }

  if (trace.error) {
    return (
      <div>
        <PageHeader title="Traceability" />
        <ErrorState
          title="Could not load traceability"
          description={(trace.error as Error).message}
          action={<Button href="/app/projects" marker={false}>Back to projects</Button>}
        />
      </div>
    )
  }

  const d = trace.data

  return (
    <div>
      <PageHeader
        title={d ? `${d.project.name} — traceability` : 'Traceability'}
        description="Every release and sprint for this product, with rolled-up results and regressions."
        actions={<Button href="/app/releases" variant="outline" marker={false}>Manage releases</Button>}
      />

      {trace.isLoading ? (
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => <Skeleton key={i} className="h-40 w-full rounded-card" />)}
        </div>
      ) : !d || d.releases.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No releases yet"
          description="Create a release and add sprints to start building product traceability."
          action={<Button href="/app/releases">Go to releases</Button>}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {d.releases.map((rel) => (
            <Card key={rel.id} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Link to={`/app/releases/${rel.id}`} className="font-sans text-sm font-semibold text-ink hover:text-accent-deep hover:underline">
                    {rel.name}
                  </Link>
                  <ReleaseStatusBadge status={rel.status} />
                  <span className="font-mono text-xs text-muted">seq {rel.sequence ?? '—'} · {rel.sprintCount} sprint{rel.sprintCount === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div className="mt-2">
                <Counts
                  items={[
                    ['assigned', rel.totals.assigned],
                    ['passed', rel.totals.passed],
                    ['failed', rel.totals.failed],
                    ['not-run', rel.totals.notRun],
                    ['new', rel.totals.new],
                    ['carried', rel.totals.carried],
                    ['ad-hoc', rel.totals.adHocTotal],
                    ['regressions', rel.totals.regressionCount],
                  ]}
                />
              </div>

              {rel.sprints.length > 0 && (
                <ul className="mt-4 flex flex-col gap-2 border-l border-line pl-4">
                  {rel.sprints.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <Link
                          to={`/app/releases/${rel.id}/sprints/${s.id}`}
                          className="font-medium text-ink hover:text-accent-deep hover:underline"
                        >
                          {s.name}
                        </Link>
                        <SprintStatusBadge status={s.status} />
                      </div>
                      <Counts
                        items={[
                          ['assigned', s.assigned],
                          ['passed', s.passed],
                          ['failed', s.failed],
                          ['partial', s.partial],
                          ['not-run', s.notRun],
                          ['ad-hoc', s.adHoc.total],
                          ['regressions', s.regressionCount],
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
