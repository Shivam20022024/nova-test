import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BugPlay, CircleCheck, CircleX, Copy, FolderKanban, GitBranch, Link2, Loader2, PlayCircle, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Skeleton } from '../../../components/ui/Skeleton'
import { API_BASE, api } from '../../../lib/api'
import type { JiraHealth, JiraIntakeConfig, JiraIntakeIssue } from '../../../lib/types'
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

type IntakeForm = {
  enabled: boolean
  triggerLabel: string
  defaultTargetUrl: string
  testUsername: string
  testPassword: string
  browsers: string
  pollIntervalMinutes: string
  postResultComment: 'always' | 'on_failure' | 'off'
  addTestedLabel: boolean
  minConfidence: 'medium' | 'high'
}

const EMPTY_INTAKE: IntakeForm = {
  enabled: false,
  triggerLabel: 'novatest-run',
  defaultTargetUrl: '',
  testUsername: '',
  testPassword: '',
  browsers: 'chromium',
  pollIntervalMinutes: '5',
  postResultComment: 'always',
  addTestedLabel: true,
  minConfidence: 'medium',
}

function intakeFormFromConfig(c: JiraIntakeConfig): IntakeForm {
  return {
    enabled: c.enabled,
    triggerLabel: c.triggerLabel,
    defaultTargetUrl: c.defaultTargetUrl ?? '',
    testUsername: c.testUsername ?? '',
    testPassword: c.hasPassword ? MASKED_TOKEN : '',
    browsers: (c.defaultBrowsers ?? ['chromium']).join(', '),
    pollIntervalMinutes: String(c.pollIntervalMinutes ?? 5),
    postResultComment: c.postResultComment,
    addTestedLabel: c.addTestedLabel,
    minConfidence: c.minConfidence,
  }
}

const INTAKE_STATUS_TONE: Record<string, string> = {
  done: 'text-pass',
  running: 'text-running',
  analyzing: 'text-running',
  queued: 'text-muted',
  skipped: 'text-flaky',
  error: 'text-fail',
}

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

function CodeBlock({ code, onCopy }: { code: string; onCopy: () => void }) {
  return (
    <div className="relative">
      <pre className="max-h-56 overflow-auto rounded-md border border-line bg-ink p-4 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap text-paper">
        {code}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        title="Copy"
        aria-label="Copy"
        className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-md text-paper/70 hover:bg-white/10 hover:text-paper"
      >
        <Copy size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

export default function IntegrationsPage() {
  const { activeProject } = useData()
  const { triggerToast } = useToast()
  const navigate = useNavigate()

  const [form, setForm] = useState<JiraForm>(EMPTY_FORM)
  const [health, setHealth] = useState<JiraHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [configured, setConfigured] = useState(false)

  const [ciConfigured, setCiConfigured] = useState<boolean | null>(null)
  const [simulating, setSimulating] = useState(false)

  const [intake, setIntake] = useState<IntakeForm>(EMPTY_INTAKE)
  const [intakeConfigured, setIntakeConfigured] = useState(false)
  const [intakeLoading, setIntakeLoading] = useState(false)
  const [intakeSaving, setIntakeSaving] = useState(false)
  const [polling, setPolling] = useState(false)
  const [intakeIssues, setIntakeIssues] = useState<JiraIntakeIssue[]>([])
  const [intakeLastPolledAt, setIntakeLastPolledAt] = useState<string | null>(null)

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

  // CI/CD is a platform-level integration (one shared key, not per-project),
  // so its health check runs once regardless of which project is active.
  useEffect(() => {
    let cancelled = false
    api
      .getCiHealth()
      .then((result) => {
        if (!cancelled) setCiConfigured(result.configured)
      })
      .catch(() => {
        if (!cancelled) setCiConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Jira Intake config + recent processed issues, loaded per project.
  const [intakeReload, setIntakeReload] = useState(0)
  useEffect(() => {
    if (!projectId) {
      setIntake(EMPTY_INTAKE)
      setIntakeConfigured(false)
      setIntakeIssues([])
      setIntakeLastPolledAt(null)
      return
    }
    let cancelled = false
    setIntakeLoading(true)
    Promise.all([
      api.jiraIntake.getConfig(projectId).catch(() => null),
      api.jiraIntake.listIssues(projectId).catch(() => [] as JiraIntakeIssue[]),
    ])
      .then(([config, issues]) => {
        if (cancelled) return
        if (config) {
          setIntakeConfigured(true)
          setIntake(intakeFormFromConfig(config))
          setIntakeLastPolledAt(config.lastPolledAt)
        } else {
          setIntakeConfigured(false)
          setIntake(EMPTY_INTAKE)
          setIntakeLastPolledAt(null)
        }
        setIntakeIssues(issues)
      })
      .finally(() => {
        if (!cancelled) setIntakeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, intakeReload])

  function updateIntake<K extends keyof IntakeForm>(key: K, value: IntakeForm[K]) {
    setIntake((prev) => ({ ...prev, [key]: value }))
  }

  async function saveIntake() {
    if (!projectId) return
    setIntakeSaving(true)
    try {
      const browsers = intake.browsers
        .split(',')
        .map((b) => b.trim().toLowerCase())
        .filter(Boolean)
      await api.jiraIntake.saveConfig({
        projectId,
        enabled: intake.enabled,
        triggerLabel: intake.triggerLabel.trim() || 'novatest-run',
        defaultTargetUrl: intake.defaultTargetUrl.trim() || null,
        testUsername: intake.testUsername.trim() || null,
        ...(intake.testPassword && intake.testPassword !== MASKED_TOKEN ? { testPassword: intake.testPassword } : {}),
        defaultBrowsers: browsers.length > 0 ? browsers : ['chromium'],
        pollIntervalMinutes: Number(intake.pollIntervalMinutes) || 5,
        postResultComment: intake.postResultComment,
        addTestedLabel: intake.addTestedLabel,
        minConfidence: intake.minConfidence,
      })
      setIntakeConfigured(true)
      triggerToast('Jira Intake settings saved.')
      setIntakeReload((n) => n + 1)
    } catch (error) {
      triggerToast(`Save failed: ${(error as Error).message}`, true)
    } finally {
      setIntakeSaving(false)
    }
  }

  async function checkJiraNow() {
    if (!projectId) return
    setPolling(true)
    try {
      const summary = await api.jiraIntake.pollNow(projectId)
      const bits: string[] = []
      if (summary.queued) bits.push(`${summary.queued} run${summary.queued === 1 ? '' : 's'} started`)
      if (summary.skipped) bits.push(`${summary.skipped} skipped`)
      if (summary.errors) bits.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`)
      triggerToast(
        summary.found === 0
          ? 'No new labelled issues found in Jira.'
          : `Checked Jira: ${bits.join(', ') || `${summary.found} found`}.`,
        summary.errors > 0,
      )
      setIntakeReload((n) => n + 1)
    } catch (error) {
      triggerToast(`Check failed: ${(error as Error).message}`, true)
    } finally {
      setPolling(false)
    }
  }

  async function simulateCiPush() {
    if (!projectId) return
    setSimulating(true)
    try {
      const result = await api.simulateCiTrigger({ project_id: projectId, browsers: ['chromium'] })
      triggerToast(`CI run queued (commit ${result.source.commitSha}) — opening Command Center…`)
      navigate('/app/command-center')
    } catch (error) {
      triggerToast(`Simulated CI trigger failed: ${(error as Error).message}`, true)
    } finally {
      setSimulating(false)
    }
  }

  async function copySnippet(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      triggerToast('Copied to clipboard.')
    } catch {
      triggerToast('Could not copy to clipboard.', true)
    }
  }

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

      {!loading && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-6">
            <div className="flex items-center gap-3 border-b border-line pb-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent-deep">
                <GitBranch size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="font-sans text-base font-semibold text-ink">CI/CD Pipeline</h2>
                <p className="text-xs text-muted">
                  Trigger a test run from any pipeline (GitHub Actions, Jenkins, GitLab CI…) and get a pass/fail
                  answer back before the build continues.
                </p>
              </div>
              <span
                className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 font-mono text-xs ${
                  ciConfigured ? 'bg-pass/10 text-pass' : 'bg-sand text-ink-soft'
                }`}
              >
                {ciConfigured === null ? 'Checking…' : ciConfigured ? 'Configured' : 'Not configured'}
              </span>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Trigger endpoint</p>
                <CodeBlock
                  code={`curl -X POST ${API_BASE}/api/v1/ci/trigger \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $NOVATEST_CI_KEY" \\
  -d '{
    "project_id": "${projectId ?? 'YOUR_PROJECT_ID'}",
    "browsers": ["chromium"],
    "source": { "branch": "main", "commitSha": "$GITHUB_SHA" }
  }'`}
                  onCopy={() =>
                    void copySnippet(
                      `curl -X POST ${API_BASE}/api/v1/ci/trigger -H "Content-Type: application/json" -H "x-api-key: $NOVATEST_CI_KEY" -d '{"project_id":"${projectId ?? 'YOUR_PROJECT_ID'}","browsers":["chromium"],"source":{"branch":"main","commitSha":"$GITHUB_SHA"}}'`,
                    )
                  }
                />
              </div>

              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">GitHub Actions step</p>
                <CodeBlock
                  code={`- name: Run NovaTest suite
  run: |
    curl -sf -X POST \${{ secrets.NOVATEST_URL }}/api/v1/ci/trigger \\
      -H "Content-Type: application/json" \\
      -H "x-api-key: \${{ secrets.NOVATEST_CI_KEY }}" \\
      -d '{"project_id":"${projectId ?? 'YOUR_PROJECT_ID'}","browsers":["chromium"],"source":{"branch":"\${{ github.ref_name }}","commitSha":"\${{ github.sha }}"}}'`}
                  onCopy={() =>
                    void copySnippet(
                      `- name: Run NovaTest suite\n  run: |\n    curl -sf -X POST \${{ secrets.NOVATEST_URL }}/api/v1/ci/trigger \\\n      -H "Content-Type: application/json" \\\n      -H "x-api-key: \${{ secrets.NOVATEST_CI_KEY }}" \\\n      -d '{"project_id":"${projectId ?? 'YOUR_PROJECT_ID'}","browsers":["chromium"],"source":{"branch":"\${{ github.ref_name }}","commitSha":"\${{ github.sha }}"}}'`,
                    )
                  }
                />
              </div>

              <p className="text-xs text-muted">
                By default the trigger call waits for the run to finish and returns one clear{' '}
                <code className="rounded bg-sand px-1 py-0.5 font-mono">passed</code> /{' '}
                <code className="rounded bg-sand px-1 py-0.5 font-mono">failed</code> answer — fail your pipeline
                step on anything but <code className="rounded bg-sand px-1 py-0.5 font-mono">passed</code>.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button variant="outline" marker={false} disabled={simulating} onClick={() => void simulateCiPush()}>
                {simulating ? (
                  <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                ) : (
                  <PlayCircle size={14} aria-hidden="true" />
                )}
                {simulating ? 'Triggering…' : 'Simulate a CI push'}
              </Button>
              <span className="text-xs text-muted">
                Fires a real trigger for {activeProject?.name} with a fake commit — no repo needed.
              </span>
            </div>
          </Card>

          <Card className="h-fit p-5">
            <h2 className="font-sans text-sm font-semibold text-ink">How it works</h2>
            <ol className="mt-3 space-y-3 text-sm text-ink-soft">
              <li className="flex gap-2">
                <span className="font-mono text-xs text-muted">1</span>
                Your pipeline calls the trigger endpoint on push, tagging the run with its commit and branch.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-xs text-muted">2</span>
                NovaTest queues and runs the test the same way a manual "Run" click would.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-xs text-muted">3</span>
                The call blocks until the run finishes, then returns pass/fail to gate the build.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-xs text-muted">4</span>
                The run shows up in Command Center and Executions with a CI badge, same place as every other run.
              </li>
            </ol>
          </Card>
        </div>
      )}

      {!loading && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-6">
            <div className="flex items-center gap-3 border-b border-line pb-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent-deep">
                <BugPlay size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="font-sans text-base font-semibold text-ink">Jira Intake — bugs become tests</h2>
                <p className="text-xs text-muted">
                  When someone raises a bug in Jira with the trigger label, NovaTest reads it (and its linked user
                  stories), generates a test, runs it, and comments the result back on the issue.
                </p>
              </div>
              <span
                className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 font-mono text-xs ${
                  intakeConfigured && intake.enabled ? 'bg-pass/10 text-pass' : 'bg-sand text-ink-soft'
                }`}
              >
                {intakeConfigured ? (intake.enabled ? 'Active' : 'Disabled') : 'Not configured'}
              </span>
            </div>

            {intakeLoading ? (
              <Skeleton className="mt-5 h-64 w-full rounded-card" />
            ) : (
              <>
                <label className="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={intake.enabled}
                    onChange={(event) => updateIntake('enabled', event.target.checked)}
                    className="accent-accent"
                  />
                  Watch this project's Jira for labelled bugs and run tests automatically
                </label>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Input
                    label="Trigger label"
                    spellCheck={false}
                    value={intake.triggerLabel}
                    onChange={(event) => updateIntake('triggerLabel', event.target.value)}
                    helperText="Add this label to a Jira issue to have it tested."
                  />
                  <Input
                    label="App base URL (fallback)"
                    placeholder="https://app.example.com"
                    spellCheck={false}
                    value={intake.defaultTargetUrl}
                    onChange={(event) => updateIntake('defaultTargetUrl', event.target.value)}
                    helperText="Used when the bug text has no URL of its own."
                  />
                  <Input
                    label="Test username (optional)"
                    spellCheck={false}
                    value={intake.testUsername}
                    onChange={(event) => updateIntake('testUsername', event.target.value)}
                  />
                  <Input
                    label="Test password (optional)"
                    type="password"
                    value={intake.testPassword}
                    onChange={(event) => updateIntake('testPassword', event.target.value)}
                    helperText={intake.testPassword === MASKED_TOKEN ? 'Saved password is hidden. Leave as-is to keep it.' : undefined}
                  />
                  <Input
                    label="Browsers"
                    spellCheck={false}
                    value={intake.browsers}
                    onChange={(event) => updateIntake('browsers', event.target.value)}
                    helperText="Comma-separated, e.g. chromium, firefox."
                  />
                  <Input
                    label="Check Jira every (minutes)"
                    value={intake.pollIntervalMinutes}
                    onChange={(event) => updateIntake('pollIntervalMinutes', event.target.value)}
                  />
                  <Select
                    label="Post result back to Jira"
                    value={intake.postResultComment}
                    onChange={(event) => updateIntake('postResultComment', event.target.value as IntakeForm['postResultComment'])}
                  >
                    <option value="always">Always (pass or fail)</option>
                    <option value="on_failure">Only when the run fails</option>
                    <option value="off">Never</option>
                  </Select>
                  <Select
                    label="Minimum AI confidence to run"
                    value={intake.minConfidence}
                    onChange={(event) => updateIntake('minConfidence', event.target.value as IntakeForm['minConfidence'])}
                  >
                    <option value="medium">Medium — run unless the bug is very vague</option>
                    <option value="high">High — only run clearly-detailed bugs</option>
                  </Select>
                </div>

                <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={intake.addTestedLabel}
                    onChange={(event) => updateIntake('addTestedLabel', event.target.checked)}
                    className="accent-accent"
                  />
                  Add a <code className="mx-1 rounded bg-sand px-1 py-0.5 font-mono text-xs">novatest-tested</code> label to the issue after each run
                </label>

                <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                  <Button
                    variant="outline"
                    marker={false}
                    disabled={polling || !intakeConfigured || !intake.enabled}
                    onClick={() => void checkJiraNow()}
                  >
                    {polling ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <RefreshCw size={14} aria-hidden="true" />}
                    {polling ? 'Checking…' : 'Check Jira now'}
                  </Button>
                  {intakeLastPolledAt && (
                    <span className="text-xs text-muted">
                      Last checked {new Date(intakeLastPolledAt).toLocaleString()}
                    </span>
                  )}
                  <Button className="ml-auto" disabled={intakeSaving} onClick={() => void saveIntake()}>
                    {intakeSaving ? 'Saving…' : 'Save settings'}
                  </Button>
                </div>
              </>
            )}
          </Card>

          <Card className="h-fit p-5">
            <h2 className="font-sans text-sm font-semibold text-ink">Issues from Jira</h2>
            {intakeIssues.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                No Jira issues processed yet. Label a bug and use "Check Jira now".
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {intakeIssues.slice(0, 8).map((issue) => (
                  <li key={issue.id} className="flex items-start justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="font-mono text-xs text-ink">{issue.issueKey}</span>
                      {issue.reason && issue.status !== 'done' && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted">{issue.reason}</p>
                      )}
                    </div>
                    <span className={`shrink-0 font-mono text-xs ${INTAKE_STATUS_TONE[issue.status] ?? 'text-muted'}`}>
                      {issue.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
