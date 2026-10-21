import useSWR from 'swr'
import { Link } from 'react-router-dom'
import { Braces } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { ErrorState } from '../../../components/ui/ErrorState'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import type { Status } from '../../../components/ui/StatusBadge'
import { DataTable } from '../../../components/tables/DataTable'
import type { DataTableColumn } from '../../../components/tables/DataTable'
import { useData, isAllProjects } from '../../../contexts/DataContext'
import { api } from '../../../lib/api'
import type { ApiExecutionSummary } from '../../../lib/types'

const STATUS_MAP: Record<string, Status> = { QUEUED: 'blocked', RUNNING: 'running', PASSED: 'pass', FAILED: 'fail' }

export default function ApiExecutionsPage() {
  const { activeProject } = useData()
  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : undefined

  const executions = useSWR<ApiExecutionSummary[]>(
    projectId ? ['api-executions', projectId] : null,
    () => api.apiTesting.listExecutions(projectId as string),
    { refreshInterval: 5000 },
  )

  const columns: DataTableColumn<ApiExecutionSummary>[] = [
    {
      key: 'name',
      header: 'Test',
      render: (r) => (
        <Link to={`/app/api-testing/executions/${r.id}/report`} className="font-medium text-ink hover:text-accent-deep hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={STATUS_MAP[r.status] ?? 'blocked'} label={r.status} /> },
    {
      key: 'durationMs',
      header: 'Duration',
      align: 'right',
      render: (r) => <span className="font-mono text-xs text-muted">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</span>,
    },
    {
      key: 'createdAt',
      header: 'Started',
      render: (r) => <span className="font-mono text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>,
    },
    {
      key: 'report',
      header: '',
      align: 'right',
      render: (r) => (
        <Link to={`/app/api-testing/executions/${r.id}/report`} className="font-mono text-xs text-accent hover:underline">
          Report →
        </Link>
      ),
    },
  ]

  if (!projectId) {
    return (
      <div>
        <PageHeader title="API Executions" description="Past API test runs." />
        <EmptyState
          icon={Braces}
          title="Select a product"
          description="Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="API Executions"
        description={`Past API test runs for ${activeProject!.name}.`}
        actions={<Button href="/app/api-testing">New API test</Button>}
      />

      {executions.error ? (
        <ErrorState
          title="Could not load executions"
          description={(executions.error as Error).message}
          action={<Button marker={false} onClick={() => void executions.mutate()}>Try again</Button>}
        />
      ) : executions.isLoading ? (
        <Skeleton className="h-64 w-full rounded-card" />
      ) : (executions.data ?? []).length === 0 ? (
        <EmptyState
          icon={Braces}
          title="No API test runs yet"
          description="Build or generate an API test and run it — it will show up here."
          action={<Button href="/app/api-testing">New API test</Button>}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable columns={columns} rows={executions.data ?? []} getRowKey={(r) => r.id} />
        </Card>
      )}
    </div>
  )
}
