import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Braces, Bug, ChevronDown, ChevronRight, Database, Folder, FolderOpen, GitBranch, Globe, Smartphone } from 'lucide-react'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import type { Status } from '../../../../components/ui/StatusBadge'
import type { RecentExecutionItem, RunSource } from '../../../../lib/types'

/** Rows fetched before this field existed have no `source` — they're all web
 *  (mobile support landed after them), so default rather than mis-badge. */
function toRunSource(source: RunSource | undefined): RunSource {
  return source ?? 'web'
}

const SOURCE_META: Record<RunSource, { color: string; icon: typeof Globe; label: string }> = {
  web: { color: 'var(--color-running)', icon: Globe, label: 'Web' },
  mobile: { color: 'var(--color-healing)', icon: Smartphone, label: 'Mobile' },
  api: { color: 'var(--color-pass)', icon: Braces, label: 'API' },
  db: { color: 'var(--color-flaky)', icon: Database, label: 'Database' },
}

function SourceBadge({ source }: { source: RunSource }) {
  const meta = SOURCE_META[source]
  const Icon = meta.icon
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs"
      style={{
        color: meta.color,
        backgroundColor: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      <Icon size={11} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

function reportPath(source: RunSource, runId: string): string {
  if (source === 'mobile') return `/app/mobile/executions/${runId}/report`
  if (source === 'api') return `/app/api-testing/executions/${runId}/report`
  if (source === 'db') return `/app/db-testing/executions/${runId}/report`
  return `/app/execution/${runId}/report`
}

/**
 * Statuses arrive lower-cased from `/dashboard/recent-executions`, unlike every
 * other endpoint. `completed` is the terminal success state for autonomous runs,
 * so it maps to pass alongside `passed`.
 */
function toStatus(raw: string): Status {
  const status = raw.toLowerCase()
  if (status === 'passed' || status === 'completed') return 'pass'
  if (status === 'failed' || status === 'blocked') return 'fail'
  if (status === 'running' || status === 'queued' || status === 'pending') return 'running'
  return 'blocked'
}

/** Small "CI · abc1234" tag for a row that came from routes/ci.ts's
 *  /trigger or /simulate — absent (and this renders nothing) on every
 *  normal run, so existing rows look exactly as they always have. */
function CiTag({ commitSha }: { commitSha?: string | null }) {
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
      style={{ color: 'var(--color-accent)', backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
      title="Triggered by a CI pipeline"
    >
      <GitBranch size={9} aria-hidden="true" />
      CI{commitSha ? ` · ${commitSha.slice(0, 7)}` : ''}
    </span>
  )
}

/** "Jira · OCQ-142" tag for a run a bug raised in Jira triggered (see
 *  routes/jiraIntake.ts). Absent -> renders nothing, like CiTag above. */
function JiraTag({ issueKey }: { issueKey?: string | null }) {
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
      style={{ color: 'var(--color-accent)', backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
      title="Raised as a bug in Jira"
    >
      <Bug size={9} aria-hidden="true" />
      Jira{issueKey ? ` · ${issueKey}` : ''}
    </span>
  )
}

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function RecentExecutionsSection({ items }: { items: RecentExecutionItem[] }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(batchId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  return (
    <div className="rounded-md border border-line bg-paper-alt">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-sans text-sm font-semibold text-ink">Recent executions</h2>
        <p className="mt-0.5 text-xs text-muted">Select a run to open its report.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {['Source', 'Test', 'Browser', 'Project', 'Status', 'Duration', 'Started'].map((header) => (
                <th
                  key={header}
                  className={`px-3 py-2 text-left font-mono text-xs text-muted uppercase ${
                    header === 'Duration' ? 'text-right' : ''
                  }`}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              // Runs from one Excel upload collapse into a single expandable
              // folder row instead of listing every scenario separately.
              if (item.type === 'folder') {
                const isOpen = expanded.has(item.batchId)
                const folderSource = toRunSource(item.source)
                return (
                  <Fragment key={item.batchId}>
                    <tr
                      onClick={() => toggle(item.batchId)}
                      className="cursor-pointer border-b border-line bg-paper hover:bg-sand"
                    >
                      <td className="px-3 py-2.5">
                        <SourceBadge source={folderSource} />
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          {isOpen ? (
                            <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
                          ) : (
                            <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-muted" />
                          )}
                          {isOpen ? (
                            <FolderOpen size={15} aria-hidden="true" className="shrink-0 text-flaky" />
                          ) : (
                            <Folder size={15} aria-hidden="true" className="shrink-0 text-flaky" />
                          )}
                          <span className="font-medium text-ink">{item.name}</span>
                          <span className="rounded-full bg-sand px-2 py-0.5 font-mono text-xs text-ink-soft">
                            {item.count} case{item.count === 1 ? '' : 's'}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5" />
                      <td className="px-3 py-2.5 text-ink-soft">{item.projectName}</td>
                      <td className="px-3 py-2.5">
                        <StatusBadge
                          status={item.failed === 0 ? 'pass' : 'fail'}
                          label={`${item.passed}/${item.count} passed`}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-soft">
                        {item.totalDuration}s
                      </td>
                      <td className="px-3 py-2.5 text-ink-soft">{formatWhen(item.startedAt)}</td>
                    </tr>

                    {isOpen &&
                      item.executions.map((run) => (
                        <tr
                          key={run.id}
                          onClick={() => navigate(reportPath(folderSource, run.run_id))}
                          className="cursor-pointer border-b border-line hover:bg-paper"
                        >
                          <td className="px-3 py-2" />
                          <td className="py-2 pr-3 pl-12">
                            <span className="block text-ink">{run.testName}</span>
                            <span className="block font-mono text-xs text-muted">{run.run_id}</span>
                          </td>
                          <td className="px-3 py-2 text-ink-soft capitalize">{run.browser}</td>
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2">
                            <StatusBadge status={toStatus(run.status)} label={run.status} />
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-ink-soft">
                            {run.duration}s
                          </td>
                          <td className="px-3 py-2 text-ink-soft">{formatWhen(run.startedAt)}</td>
                        </tr>
                      ))}
                  </Fragment>
                )
              }

              const rowSource = toRunSource(item.source)
              return (
                <tr
                  key={item.id}
                  onClick={() => navigate(reportPath(rowSource, item.run_id))}
                  className="cursor-pointer border-b border-line last:border-b-0 hover:bg-paper"
                >
                  <td className="px-3 py-2.5">
                    <SourceBadge source={rowSource} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center text-ink">
                      <span className="font-medium">{item.testName}</span>
                      {item.triggeredBy === 'ci' && <CiTag commitSha={item.commitSha} />}
                      {item.triggeredBy === 'jira' && <JiraTag issueKey={item.jiraSourceIssueKey} />}
                    </span>
                    <span className="block font-mono text-xs text-muted">{item.run_id}</span>
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft capitalize">{item.browser}</td>
                  <td className="px-3 py-2.5 text-ink-soft">{item.projectName}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={toStatus(item.status)} label={item.status} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-soft">
                    {item.duration}s
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">{formatWhen(item.startedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
