import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, FolderKanban, Link2, Loader2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { api } from '../../../lib/api'
import type { JiraHealth } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'

/**
 * Jira is the only integration the backend implements. The original design
 * listed thirteen (Slack, GitHub, Jenkins, BrowserStack and so on); none of
 * them have any server-side counterpart, so they are not shown.
 *
 * When a run fails, the worker files a bug automatically using this config.
 */
type JiraForm = {
  baseUrl: string
  email: string
  apiToken: string
  projectKey: string
  issueType: string
  isActive: boolean
}

const EMPTY_FORM: JiraForm = {
  baseUrl: '',
  email: '',
  apiToken: '',
  projectKey: '',
  issueType: 'Bug',
  isActive: true,
}

/** The API returns the stored token masked; sending it back unchanged keeps it. */
const MASKED_TOKEN = '********'

function HealthRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span className="text-ink-soft">{label}</span>
      <span className="flex items-center gap-1.5 font-medium text-ink">
        {ok ? (
          <CircleCheck size={14} aria-hidden="true" className="text-pass" />
        ) : (
          <CircleX size={14} aria-hidden="true" className="text-fail" />
        )}
        {value}
      </span>
    </div>
  )
}

export default function IntegrationsPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()

  const [form, setForm] = useState<JiraForm>(EMPTY_FORM)
  const [health, setHealth] = useState<JiraHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [configured, setConfigured] = useState(false)

  const projectId = activeProject && !isAllProjects(activeProject) ? activeProject.id : null

  useEffect(() => {
    if (!projectId) {
      setForm(EMPTY_FORM)
      setHealth(null)
      setConfigured(false)
      return
    }

    let cancelled = false
    setLoading(true)
    Promise.all([
      api.getJiraConfig(projectId).catch(() => null),
      api.getJiraHealth(projectId).catch(() => null),
    ])
      .then(([config, healthResult]) => {
        if (cancelled) return
        if (config) {
          setConfigured(true)
          setForm({
            baseUrl: config.baseUrl ?? '',
            email: config.email ?? '',
            apiToken: config.apiToken ?? '',
            projectKey: config.projectKey ?? '',
            issueType: config.issueType || 'Bug',
            isActive: config.isActive,
          })
        } else {
          setConfigured(false)
          setForm(EMPTY_FORM)
        }
        setHealth(healthResult)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  function update<K extends keyof JiraForm>(key: K, value: JiraForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function refreshHealth(id: string) {
    const result = await api.getJiraHealth(id).catch(() => null)
    setHealth(result)
  }

  async function save() {
    if (!projectId) return
    setSaving(true)
    try {
      await api.saveJiraConfig({ projectId, ...form })
      setConfigured(true)
      triggerToast('Jira configuration saved.')
      await refreshHealth(projectId)
    } catch (error) {
      triggerToast(`Save failed: ${(error as Error).message}`, true)
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    if (!projectId) return
    setTesting(true)
    try {
      const result = await api.testJiraConnection({ projectId, ...form })
      if (result.success) triggerToast('Connected to Jira successfully.')
      else triggerToast('Jira rejected the connection.', true)
      await refreshHealth(projectId)
    } catch (error) {
      triggerToast(`Connection failed: ${(error as Error).message}`, true)
    } finally {
      setTesting(false)
    }
  }

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Integrations" description="Connect NovaTest AI to your other tools." />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Integrations are configured per project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  const canSubmit = form.baseUrl.trim() !== '' && form.apiToken.trim() !== ''

  return (
    <div>
      <PageHeader
        title="Integrations"
        description={`Connected tools for ${activeProject?.name}.`}
      />

      {loading ? (
        <Skeleton className="h-96 w-full rounded-card" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-6">
            <div className="flex items-center gap-3 border-b border-line pb-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent-deep">
                <Link2 size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="font-sans text-base font-semibold text-ink">Jira</h2>
                <p className="text-xs text-muted">
                  Files a bug automatically when a run fails, with screenshots, trace and report attached.
                </p>
              </div>
              <span
                className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 font-mono text-xs ${
                  configured && form.isActive
                    ? 'bg-pass/10 text-pass'
                    : 'bg-sand text-ink-soft'
                }`}
              >
                {configured ? (form.isActive ? 'Active' : 'Disabled') : 'Not configured'}
              </span>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Input
                label="Jira base URL"
                placeholder="https://your-domain.atlassian.net"
                spellCheck={false}
                value={form.baseUrl}
                onChange={(event) => update('baseUrl', event.target.value)}
              />
              <Input
                label="Account email"
                type="email"
                spellCheck={false}
                value={form.email}
                onChange={(event) => update('email', event.target.value)}
              />
              <Input
                label="API token"
                type="password"
                value={form.apiToken}
                onChange={(event) => update('apiToken', event.target.value)}
                helperText={
                  form.apiToken === MASKED_TOKEN
                    ? 'Saved token is hidden. Leave as-is to keep it.'
                    : undefined
                }
              />
              <Input
                label="Project key"
                placeholder="QA"
                spellCheck={false}
                value={form.projectKey}
                onChange={(event) => update('projectKey', event.target.value)}
              />
              <Input
                label="Issue type"
                placeholder="Bug"
                value={form.issueType}
                onChange={(event) => update('issueType', event.target.value)}
              />
            </div>

            <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => update('isActive', event.target.checked)}
                className="accent-accent"
              />
              Enable automatic bug filing for failed runs
            </label>

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button
                variant="outline"
                marker={false}
                disabled={testing || !canSubmit}
                onClick={() => void testConnection()}
              >
                {testing && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
                Test connection
              </Button>
              <Button
                className="ml-auto"
                disabled={saving || !canSubmit}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save configuration'}
              </Button>
            </div>
          </Card>

          <Card className="h-fit p-5">
            <h2 className="font-sans text-sm font-semibold text-ink">Health check</h2>
            {health ? (
              <div className="mt-3 divide-y divide-line">
                <HealthRow
                  label="Reachable"
                  ok={health.jiraConnected}
                  value={health.jiraConnected ? 'Yes' : 'No'}
                />
                <HealthRow
                  label="Authentication"
                  ok={health.authenticationStatus === 'Valid'}
                  value={health.authenticationStatus}
                />
                <HealthRow
                  label="Project verified"
                  ok={health.projectVerified}
                  value={health.projectVerified ? 'Yes' : 'No'}
                />
                {health.availableProjects && health.availableProjects.length > 0 && (
                  <div className="py-2">
                    <p className="text-sm text-ink-soft">Available projects</p>
                    <p className="mt-1 font-mono text-xs break-words text-ink">
                      {health.availableProjects.map((project) => project.key).join(', ')}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">
                Save a configuration and run a connection test to see health here.
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
