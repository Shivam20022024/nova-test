import useSWR from 'swr'
import { useAppShell } from '../../app/providers'
import { isAllProjects, useData } from '../../contexts/DataContext'
import { api } from '../../lib/api'
import type { Release } from '../../lib/types'

/**
 * The strip under the topbar. It shows only state the backend actually knows
 * about: the selected project, the target environment, the active suite that
 * runs will be attributed to, and — now that a Release model exists — the
 * most recently created release for this project, if any.
 *
 * The rollup health dot from the original design is still deliberately not
 * shown — there is no health endpoint behind it, so anything rendered there
 * would be invented.
 */
export function ContextHeader() {
  const { environment } = useAppShell()
  const { activeProject, activeSuite, suites, suitesLoading } = useData()

  const scopedProjectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : undefined
  const releases = useSWR<Release[]>(
    scopedProjectId ? ['context-header-releases', scopedProjectId] : null,
    () => api.listReleases(scopedProjectId),
  )
  const latestRelease = releases.data?.[0]

  const suiteLabel = suitesLoading
    ? 'Loading suites…'
    : activeSuite
      ? `${activeSuite.name} · ${activeSuite.type}`
      : suites.length === 0
        ? 'No suites yet'
        : 'No suite selected'

  return (
    <div className="flex h-10 items-center gap-2 border-b border-line bg-paper px-4 font-mono text-xs text-ink-soft md:px-6 print:hidden">
      <span className="truncate font-medium text-ink">{activeProject?.name ?? 'No project'}</span>
      <span className="text-line">/</span>
      <span>{environment}</span>
      <span className="text-line">/</span>
      <span className="truncate">{suiteLabel}</span>
      {latestRelease && (
        <>
          <span className="text-line">/</span>
          <span className="truncate">{latestRelease.name}</span>
        </>
      )}
    </div>
  )
}
