import { useRef, useState } from 'react'
import useSWR from 'swr'
import { FileUp, FolderKanban, Play, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Chip } from '../../../components/ui/Chip'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { AUTONOMOUS_FEATURES, BROWSERS, TEST_DEPTHS } from '../../../config/execution'
import { api } from '../../../lib/api'
import type { ExcelTestCase, Release } from '../../../lib/types'
import { isAllProjects, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'
import { parseScenarioText } from './scenarioParser'
import { RunStartedCard } from './RunStartedCard'

const DEFAULT_FEATURES: Record<string, boolean> = Object.fromEntries(
  AUTONOMOUS_FEATURES.map((feature) => [feature.key, true]),
)

export default function OneClickTestPage() {
  const { activeProject, activeSuite } = useData()
  const { triggerToast } = useToast()

  // The execution just started from this page — its status + step results are
  // shown inline (RunStartedCard), with a link to the full execution page.
  const [startedRun, setStartedRun] = useState<{ id: string; extra: number } | null>(null)

  const [targetUrl, setTargetUrl] = useState('')
  const [scenarioText, setScenarioText] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [depth, setDepth] = useState<string>(TEST_DEPTHS[2])
  const [browsers, setBrowsers] = useState<string[]>(['chromium'])
  const [features, setFeatures] = useState<Record<string, boolean>>(DEFAULT_FEATURES)
  const [submitting, setSubmitting] = useState(false)

  // Excel batch import
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [excelCases, setExcelCases] = useState<ExcelTestCase[]>([])
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set())
  const [excelUrl, setExcelUrl] = useState('')
  const [urlAutoDetected, setUrlAutoDetected] = useState<boolean | null>(null)

  // Optional: tag this run with a release checkpoint. Left unselected,
  // nothing about how the run works changes — this is purely a label.
  const [releaseId, setReleaseId] = useState('')
  const [sprintId, setSprintId] = useState('')
  const releases = useSWR<Release[]>(
    activeProject && !isAllProjects(activeProject) ? ['releases', activeProject.id] : null,
    () => api.listReleases(activeProject!.id),
  )
  // Sprints for the chosen release (optional — no release picked, no sprints).
  const sprints = useSWR(releaseId ? ['release-sprints', releaseId] : null, () => api.listReleaseSprints(releaseId))

  // The two paths are mutually exclusive, exactly as in the previous frontend:
  // an Excel batch runs the imported cases, a scenario runs the AI pipeline.
  const isExcelMode = selectedCaseIds.size > 0
  const isScenarioMode = scenarioText.trim().length > 0

  function toggleBrowser(id: string) {
    setBrowsers((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]))
  }

  async function importExcel() {
    if (!file) return
    setImporting(true)
    try {
      const result = await api.importExcel(file)
      const cases = result.testcases ?? []
      setExcelCases(cases)
      setSelectedCaseIds(new Set(cases.map((testCase) => testCase.id)))
      if (result.detectedUrl) {
        setExcelUrl(result.detectedUrl)
        setUrlAutoDetected(true)
        triggerToast(`Imported ${cases.length} cases — target URL detected.`)
      } else {
        setExcelUrl('')
        setUrlAutoDetected(false)
        triggerToast('Imported, but no target URL was found in the sheet. Enter one below.', true)
      }
    } catch (error) {
      triggerToast(`Import failed: ${(error as Error).message}`, true)
    } finally {
      setImporting(false)
    }
  }

  async function run() {
    if (!activeProject || isAllProjects(activeProject)) {
      triggerToast('Select a specific project first.', true)
      return
    }
    if (browsers.length === 0) {
      triggerToast('Select at least one browser.', true)
      return
    }
    if (!releaseId || !sprintId) {
      triggerToast('Select a release and sprint before running.', true)
      return
    }

    setSubmitting(true)
    try {
      if (isExcelMode) {
        if (!excelUrl.trim()) {
          triggerToast('A target URL is required to run the Excel batch.', true)
          return
        }
        const result = await api.runMultiTest({
          test_name: 'Excel Batch Execution',
          base_url: excelUrl.trim(),
          excel_testcase_ids: Array.from(selectedCaseIds),
          browsers,
          devices: ['Desktop'],
          project_id: activeProject.id,
          suite_id: activeSuite?.id ?? null,
          release_id: releaseId || null,
          sprint_id: sprintId || null,
        })
        triggerToast(`Queued ${result.executionIds.length} runs from the Excel batch.`)
        if (result.executionIds[0]) {
          setStartedRun({ id: result.executionIds[0], extra: Math.max(0, result.executionIds.length - 1) })
        }
        return
      }

      if (!targetUrl.trim()) {
        triggerToast('Enter the URL you want tested.', true)
        return
      }

      const parsed = parseScenarioText(scenarioText)
      const result = await api.triggerAutonomousQA({
        targetUrl: targetUrl.trim(),
        credentials: { username, password },
        depth,
        features,
        browsers,
        projectId: activeProject.id,
        customScenario: parsed.length > 0 ? parsed : null,
        rawScenario: scenarioText.trim() || null,
        enableAiEyes: features.aiEyes,
        releaseId: releaseId || null,
        sprintId: sprintId || null,
      })
      triggerToast('Autonomous run queued.')
      if (result.executionIds[0]) {
        setStartedRun({ id: result.executionIds[0], extra: Math.max(0, result.executionIds.length - 1) })
      }
    } catch (error) {
      triggerToast(`Could not start the run: ${(error as Error).message}`, true)
    } finally {
      setSubmitting(false)
    }
  }

  if (!activeProject || isAllProjects(activeProject)) {
    return (
      <div>
        <PageHeader
          title="Author Tests"
          description="Describe what you want tested and let the agent pipeline handle the rest."
        />
        <EmptyState
          icon={FolderKanban}
          title="Select a project"
          description="Runs are recorded against a project. Choose one from the project menu in the top bar."
          action={<Button href="/app/projects">Go to projects</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Author Tests"
        description="Point it at a URL and describe the scenario, or upload a sheet of existing test cases."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="border-b border-line pb-3 font-sans text-base font-semibold text-ink">
            Describe the test
          </h2>

          <div className="mt-5 flex flex-col gap-4">
            <Input
              label="Target URL"
              type="url"
              spellCheck={false}
              placeholder="https://your-staging-site.com"
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              disabled={isExcelMode}
            />

            <Textarea
              label="Scenario"
              rows={7}
              spellCheck={false}
              placeholder={
                'Describe the scenarios to run, one per line or numbered.\n\n1. Sign in with a valid account\n2. Add a product to the cart and verify the badge count'
              }
              value={scenarioText}
              onChange={(event) => setScenarioText(event.target.value)}
              disabled={isExcelMode}
              helperText={
                isExcelMode
                  ? 'Disabled while Excel cases are selected — clear the selection to write a scenario.'
                  : 'Leave blank to let the agent explore the site on its own.'
              }
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Test username"
                autoComplete="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                helperText="Optional."
                disabled={isExcelMode}
              />
              <Input
                label="Test password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                helperText="Optional."
                disabled={isExcelMode}
              />
            </div>

            <Select
              label="Depth"
              value={depth}
              onChange={(event) => setDepth(event.target.value)}
              disabled={isExcelMode}
            >
              {TEST_DEPTHS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>

            <Select
              label="Release"
              value={releaseId}
              onChange={(event) => {
                setReleaseId(event.target.value)
                setSprintId('')
              }}
              helperText="Required — create new ones from the Releases page."
            >
              <option value="">Select a release…</option>
              {(releases.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>

            <Select
              label="Sprint"
              value={sprintId}
              onChange={(event) => setSprintId(event.target.value)}
              disabled={!releaseId}
              helperText={releaseId ? 'Required — attributes this run to a sprint for traceability.' : 'Pick a release first.'}
            >
              <option value="">Select a sprint…</option>
              {(sprints.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="flex items-center gap-2 border-b border-line pb-3 font-sans text-base font-semibold text-ink">
            <FileUp size={17} aria-hidden="true" className="text-accent" />
            Excel test repository
          </h2>

          <div className="mt-5 flex flex-col gap-4">
            <div className={isScenarioMode ? 'pointer-events-none opacity-50' : ''}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(event) => {
                  const selected = event.target.files?.[0]
                  if (selected && !selected.name.endsWith('.xlsx')) {
                    triggerToast('Only .xlsx files are supported.', true)
                    return
                  }
                  setFile(selected ?? null)
                  event.target.value = ''
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  marker={false}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose file
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  {file ? file.name : 'No file selected'}
                </span>
                <Button marker={false} disabled={!file || importing} onClick={() => void importExcel()}>
                  {importing ? 'Importing…' : 'Import'}
                </Button>
              </div>
              {isScenarioMode && (
                <p className="mt-2 text-xs text-muted">
                  Disabled while a scenario is written — clear it to use an Excel batch instead.
                </p>
              )}
            </div>

            {excelCases.length > 0 && (
              <div className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">
                    {selectedCaseIds.size} of {excelCases.length} selected
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedCaseIds(new Set(excelCases.map((c) => c.id)))}
                      className="text-xs text-accent hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCaseIds(new Set())}
                      className="text-xs text-ink-soft hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <ul className="mt-2 max-h-44 overflow-y-auto">
                  {excelCases.map((testCase) => (
                    <li key={testCase.id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-paper">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-accent"
                          checked={selectedCaseIds.has(testCase.id)}
                          onChange={(event) => {
                            setSelectedCaseIds((prev) => {
                              const next = new Set(prev)
                              if (event.target.checked) next.add(testCase.id)
                              else next.delete(testCase.id)
                              return next
                            })
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate text-ink-soft">{testCase.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 border-t border-line pt-3">
                  <Input
                    label="Target URL for this batch"
                    type="url"
                    spellCheck={false}
                    value={excelUrl}
                    onChange={(event) => {
                      setExcelUrl(event.target.value)
                      setUrlAutoDetected(null)
                    }}
                    helperText={
                      urlAutoDetected === true
                        ? 'Auto-detected from the spreadsheet.'
                        : urlAutoDetected === false
                          ? 'No URL was found in the sheet — enter one before running.'
                          : undefined
                    }
                  />
                </div>
              </div>
            )}

            {excelCases.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setExcelCases([])
                  setSelectedCaseIds(new Set())
                  setFile(null)
                  setExcelUrl('')
                  setUrlAutoDetected(null)
                }}
                className="flex items-center gap-1.5 self-start text-xs text-ink-soft hover:text-ink"
              >
                <X size={13} aria-hidden="true" />
                Discard import
              </button>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-6 p-6">
        <div>
          <p className="mb-2 text-sm font-medium text-ink">Browsers</p>
          <div className="flex flex-wrap gap-2">
            {BROWSERS.map((browser) => (
              <Chip
                key={browser.id}
                active={browsers.includes(browser.id)}
                onClick={() => toggleBrowser(browser.id)}
              >
                {browser.label}
              </Chip>
            ))}
          </div>
        </div>

        {!isExcelMode && (
          <div className="mt-5">
            <p className="mb-2 text-sm font-medium text-ink">Agent capabilities</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {AUTONOMOUS_FEATURES.map((feature) => (
                <label
                  key={feature.key}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm transition-colors ${
                    features[feature.key]
                      ? 'border-accent bg-selected'
                      : 'border-line hover:bg-paper'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-accent"
                    checked={features[feature.key] ?? false}
                    onChange={(event) =>
                      setFeatures((prev) => ({ ...prev, [feature.key]: event.target.checked }))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{feature.label}</span>
                    <span className="block text-xs text-muted">{feature.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end border-t border-line pt-5">
          <Button onClick={() => void run()} disabled={submitting || !releaseId || !sprintId}>
            <Play size={15} aria-hidden="true" />
            {submitting
              ? 'Queueing…'
              : isExcelMode
                ? `Run ${selectedCaseIds.size} imported case${selectedCaseIds.size === 1 ? '' : 's'}`
                : startedRun
                  ? 'Run again'
                  : 'Run test'}
          </Button>
        </div>
      </Card>

      {startedRun && (
        <RunStartedCard
          key={startedRun.id}
          executionId={startedRun.id}
          extraCount={startedRun.extra}
          fallback={{
            testName: isExcelMode
              ? 'Excel Batch Execution'
              : scenarioText.trim().split('\n')[0]?.slice(0, 80) || 'Autonomous run',
            browser: browsers[0],
            targetUrl: isExcelMode ? excelUrl.trim() : targetUrl.trim(),
          }}
          onDismiss={() => setStartedRun(null)}
        />
      )}
    </div>
  )
}
