import { Layers, Plus, Trash2 } from 'lucide-react'
import type { TestSuite } from '../../../../lib/types'

type TestFolderTreeProps = {
  suites: TestSuite[]
  activeSuiteId: string | null
  onSelect: (suite: TestSuite) => void
  onCreate: () => void
  onDelete: (suite: TestSuite) => void
  deletingId: string | null
  loading: boolean
}

/**
 * The tree lists real test suites. A suite is not cosmetic grouping — every run
 * payload is attributed to one, so this doubles as the run target selector.
 */
export function TestFolderTree({
  suites,
  activeSuiteId,
  onSelect,
  onCreate,
  onDelete,
  deletingId,
  loading,
}: TestFolderTreeProps) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-paper-alt p-3">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <p className="font-mono text-xs tracking-wide text-muted uppercase">Suites</p>
        <button
          type="button"
          onClick={onCreate}
          aria-label="New suite"
          title="New suite"
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <p className="px-2 py-3 text-sm text-muted">Loading…</p>
      ) : suites.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted">
          No suites in this project yet.
        </p>
      ) : (
        suites.map((suite) => (
          <div
            key={suite.id}
            className={`group flex items-center gap-1 rounded-md text-sm transition-colors ${
              suite.id === activeSuiteId ? 'bg-accent-soft' : 'hover:bg-paper'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(suite)}
              aria-current={suite.id === activeSuiteId ? 'true' : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                suite.id === activeSuiteId ? 'font-medium text-accent-deep' : 'text-ink-soft group-hover:text-ink'
              }`}
            >
              <Layers aria-hidden="true" size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{suite.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted">{suite.type}</span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(suite)}
              disabled={deletingId === suite.id}
              aria-label={`Delete ${suite.name}`}
              title="Delete suite"
              className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-fail/10 hover:text-fail disabled:opacity-40"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))
      )}
    </div>
  )
}
