import type { ReactNode } from 'react'
import { FolderKanban } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { useMobileTest } from '../../../contexts/MobileTestContext'

type Props = {
  title: string
  description: string
  children: ReactNode
}

/**
 * Shared shell for the five standalone Application Testing pages (Apps,
 * Devices, Author, Executions, Compatibility) — each needs the same "no
 * project selected" / "engine unreachable" guards and the same Refresh
 * action, since they all read from the one MobileTestProvider above them.
 */
export function MobileVerticalPage({ title, description, children }: Props) {
  const { projectId, loading, unavailable, reload } = useMobileTest()

  if (!projectId) {
    return (
      <div>
        <PageHeader title={title} description={description} />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Apps, tests and runs belong to a project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  if (unavailable) {
    return (
      <div>
        <PageHeader title={title} description={description} />
        <EmptyState
          icon={FolderKanban}
          title="The mobile testing engine is not reachable"
          description={`${unavailable}. It runs as its own service — check that the backend is started, then refresh.`}
          action={<Button marker={false} onClick={() => void reload()}>Try again</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button variant="outline" marker={false} onClick={() => void reload()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      {children}
    </div>
  )
}
