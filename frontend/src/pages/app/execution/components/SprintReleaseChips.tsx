import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { api } from '../../../../lib/api'

/**
 * Read-only "this run belongs to a sprint" chips. Renders nothing when the
 * execution has no sprint/release context — i.e. every run created before the
 * traceability feature, and every ad-hoc run since.
 */
export function SprintReleaseChips({
  sprintId,
  releaseId,
}: {
  sprintId?: string | null
  releaseId?: string | null
}) {
  const sprint = useSWR(sprintId ? ['sprint', sprintId] : null, () => api.getSprint(sprintId as string))
  const release = useSWR(
    !sprintId && releaseId ? ['release', releaseId] : null,
    () => api.getRelease(releaseId as string),
  )

  if (!sprintId && !releaseId) return null

  const chip = 'inline-flex items-center rounded-full border border-line bg-sand px-2 py-0.5 font-mono text-[11px] text-ink-soft'

  if (sprintId && sprint.data) {
    const s = sprint.data
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {s.release && (
          <Link to={`/app/releases/${s.release.id}`} className={`${chip} hover:text-accent-deep`}>
            {s.release.name}
          </Link>
        )}
        <Link
          to={s.release ? `/app/releases/${s.release.id}/sprints/${s.id}` : '#'}
          className={`${chip} hover:text-accent-deep`}
        >
          {s.name}
        </Link>
      </span>
    )
  }

  if (releaseId && release.data) {
    return (
      <Link to={`/app/releases/${release.data.id}`} className={`${chip} hover:text-accent-deep`}>
        {release.data.name}
      </Link>
    )
  }

  // IDs present but names not loaded yet — show a neutral placeholder chip.
  return <span className={chip}>{sprintId ? 'Sprint' : 'Release'}</span>
}
