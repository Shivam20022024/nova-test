import { useAppShell } from '../../app/providers'
import { useData } from '../../contexts/DataContext'

/**
 * The strip under the topbar. It shows only state the backend actually knows
 * about: the selected project, the target environment, and the active suite
 * that runs will be attributed to.
 *
 * The release/build identifier and rollup health dot from the original design
 * are deliberately not shown. There is no release model and no health endpoint
 * behind them, so anything rendered there would be invented.
 */
export function ContextHeader() {
  const { environment } = useAppShell()
  const { activeProject, activeSuite, suites, suitesLoading } = useData()

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
    </div>
  )
}
