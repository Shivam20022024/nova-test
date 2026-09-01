import { useState } from 'react'
import type { FormEvent } from 'react'
import useSWR from 'swr'
import { AppWindow, ChevronDown, ChevronRight, FolderKanban, Radar } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { api } from '../../../lib/api'
import type { DiscoveredFlow } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'

type StepLike = {
  action?: string
  selector?: string
  url?: string
  value?: string
  contains?: string
  [key: string]: unknown
}

function FlowCard({ flow }: { flow: DiscoveredFlow }) {
  const [open, setOpen] = useState(false)
  const steps = Array.isArray(flow.generated_steps) ? (flow.generated_steps as StepLike[]) : []

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? (
          <ChevronDown size={15} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
        ) : (
          <ChevronRight size={15} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-sm font-semibold text-ink">{flow.name}</span>
          {flow.description && (
            <span className="mt-0.5 block text-xs text-ink-soft">{flow.description}</span>
          )}
        </span>
        <span className="shrink-0 rounded-full bg-sand px-2.5 py-0.5 font-mono text-xs text-ink-soft">
          {flow.flow_type || 'FLOW'}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted">{steps.length} steps</span>
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
          {steps.length === 0 ? (
            <li className="text-sm text-muted">No steps recorded for this flow.</li>
          ) : (
            steps.map((step, index) => (
              <li key={index} className="flex gap-2 font-mono text-xs">
                <span className="shrink-0 text-muted">{index + 1}</span>
                <span className="min-w-0 break-all text-ink">
                  {[step.action, step.url || step.selector, step.value || step.contains]
                    .filter(Boolean)
                    .join(' · ') || 'step'}
                </span>
              </li>
            ))
          )}
        </ol>
      )}
    </Card>
  )
}

export default function ApplicationPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()
  const [baseUrl, setBaseUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)

  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : null

  const { data, error, isLoading, mutate } = useSWR<DiscoveredFlow[]>(
    projectId ? ['discovered-flows', projectId] : null,
    () => api.getDiscoveredFlows(projectId as string),
  )

  async function discover(event: FormEvent) {
    event.preventDefault()
    if (!projectId) return
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      setUrlError('Enter a full URL including http:// or https://')
      return
    }
    setUrlError(null)
    setDiscovering(true)
    try {
      // This drives a real browser crawl server-side, so it can take a while.
      const flows = await api.generateDiscoveredFlows(projectId, baseUrl)
      await mutate()
      triggerToast(`Discovery finished — ${flows.length} flow${flows.length === 1 ? '' : 's'} found.`)
    } catch (err) {
      triggerToast(`Discovery failed: ${(err as Error).message}`, true)
    } finally {
      setDiscovering(false)
    }
  }

  if (!projectId) {
    return (
      <div>
        <PageHeader
          title="Application"
          description="AppGraph — the flows NovaTest AI has discovered in your application."
        />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Discovered flows are stored per project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  const flows = data ?? []

  return (
    <div>
      <PageHeader
        title="Application"
        description="AppGraph — crawl your application and keep a map of the flows worth testing."
      />

      <Card className="mb-6 p-5">
        <form onSubmit={discover} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Input
              label="Application URL"
              type="url"
              spellCheck={false}
              placeholder="https://your-staging-site.com"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              error={urlError ?? undefined}
              helperText="A real browser crawls this page, so discovery can take a minute."
            />
          </div>
          <Button type="submit" disabled={discovering} className="mb-1.5">
            <Radar size={15} aria-hidden="true" />
            {discovering ? 'Discovering…' : 'Run discovery'}
          </Button>
        </form>
      </Card>

      {error ? (
        <ErrorState
          title="Could not load discovered flows"
          description={(error as Error).message}
          action={
            <Button marker={false} onClick={() => void mutate()}>
              Try again
            </Button>
          }
        />
      ) : isLoading || discovering ? (
        <div aria-hidden="true" className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-card" />
          ))}
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          title="No flows discovered yet"
          description="Point discovery at your application above. NovaTest AI will crawl it and map the flows it finds."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-xs text-muted">
            {flows.length} flow{flows.length === 1 ? '' : 's'} discovered
          </p>
          {flows.map((flow) => (
            <FlowCard key={flow.id} flow={flow} />
          ))}
        </div>
      )}
    </div>
  )
}
