import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { FileUp, Sparkles } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Card } from '../../../../components/ui/Card'
import { Select } from '../../../../components/ui/Select'
import { Textarea } from '../../../../components/ui/Textarea'
import { api } from '../../../../lib/api'
import { isAllProjects, useData } from '../../../../contexts/DataContext'
import { useToast } from '../../../../contexts/ToastContext'
import type { MobileApplication, MobileBatchJob, MobileDevice, Release } from '../../../../lib/types'

type Props = {
  applications: MobileApplication[]
  devices: MobileDevice[]
  aiEnabled: boolean
  applicationId: number | null
  deviceId: number | null
  onChanged: () => void
  /** Called instead of onChanged whenever a run actually started, so the
   *  caller can jump straight to watching it live — the same one-click
   *  "author it and land on the live run" experience as One-Click Test. */
  onRun: (suiteId: number) => void
}

/**
 * The three ways tests get into the system, in one place because they answer
 * the same question — "what should this app be tested for?" — and differ only
 * in what you already have written down.
 */
export function AuthorPanel({ applications, devices, aiEnabled, applicationId, deviceId, onChanged, onRun }: Props) {
  const { triggerToast } = useToast()
  const { activeProject } = useData()
  const docRef = useRef<HTMLInputElement>(null)
  const trackerRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<MobileBatchJob | null>(null)
  // The plan-review moment: what a just-generated test is actually going to
  // do, in plain English, before the reviewer jumps to watching it run.
  const [lastPlan, setLastPlan] = useState<{ lines: string[]; warnings: string[]; suiteId: number | null } | null>(null)
  // Optional: tag this run with a release checkpoint, same as One-Click Test.
  const [releaseId, setReleaseId] = useState('')
  const releases = useSWR<Release[]>(
    activeProject && !isAllProjects(activeProject) ? ['releases', activeProject.id] : null,
    () => api.listReleases(activeProject!.id),
  )

  const app = applications.find((a) => a.id === applicationId)
  const device = devices.find((d) => d.id === deviceId)
  const ready = !!app

  // A tracker can hold hundreds of rows, so generation runs as a background job
  // and this polls it. Stops as soon as the job reports COMPLETED.
  useEffect(() => {
    if (!job || job.status === 'COMPLETED') return
    const timer = setInterval(() => {
      api.mobile
        .getBatchJob(job.id)
        .then((fresh) => {
          setJob(fresh)
          if (fresh.status === 'COMPLETED') {
            triggerToast(`Generated ${fresh.created.length} tests from ${fresh.filename}.`)
            if (fresh.suite_id != null) onRun(fresh.suite_id)
            else onChanged()
          }
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [job, onChanged, onRun, triggerToast])

  async function generate(file?: File) {
    if (!objective.trim() && !file) {
      triggerToast('Describe what to test, or attach a document.', true)
      return
    }
    setBusy('generate')
    try {
      const result = await api.mobile.generateTest({
        text: objective.trim() || undefined,
        file,
        applicationId: applicationId ?? undefined,
        deviceId: deviceId ?? undefined,
        releaseId: releaseId || undefined,
      })
      if (!result.automatable) {
        triggerToast(`Saved, but flagged as not automatable: ${result.not_automatable_reason}`, true)
      } else {
        triggerToast(
          result.suite_id
            ? `Generated ${result.steps.length} steps and started a run.`
            : `Generated ${result.steps.length} steps. Pick a device to run it.`,
        )
      }
      setObjective('')
      // Show the plan before jumping to the live run — the run has already
      // started server-side (auto-run is unchanged), this only delays when
      // the reviewer's own view navigates away, so what's about to execute
      // is legible instead of a black box.
      setLastPlan({ lines: result.plan_summary, warnings: result.warnings, suiteId: result.suite_id })
      if (result.suite_id == null) onChanged()
    } catch (error) {
      triggerToast(`Generation failed: ${(error as Error).message}`, true)
    } finally {
      setBusy(null)
    }
  }

  async function importFiles(files: FileList) {
    setBusy('import')
    try {
      const result = await api.mobile.importTests(
        Array.from(files), deviceId ?? undefined, applicationId ?? undefined,
      )
      if (result.errors.length) {
        triggerToast(`Imported ${result.created.length}; ${result.errors.length} file(s) failed.`, true)
      } else {
        triggerToast(`Imported ${result.created.length} tests.`)
      }
      if (result.suite_id != null) onRun(result.suite_id)
      else onChanged()
    } catch (error) {
      triggerToast(`Import failed: ${(error as Error).message}`, true)
    } finally {
      setBusy(null)
    }
  }

  async function generateBatch(file: File) {
    setBusy('batch')
    try {
      setJob(await api.mobile.generateTestsBatch(file, applicationId ?? undefined, deviceId ?? undefined))
      triggerToast('Reading the sheet. Each row becomes its own test.')
    } catch (error) {
      triggerToast(`Could not start batch generation: ${(error as Error).message}`, true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!ready && (
        <p className="rounded-md border border-line bg-sand/50 p-4 text-sm text-ink-soft">
          Select an application on the <span className="font-medium text-ink">Apps</span> tab first — generated
          tests are grounded in that app's real screens, and ungrounded tests invent elements that do not exist.
        </p>
      )}

      {lastPlan && (
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-sans text-base font-semibold text-ink">Generated plan</h2>
              <p className="mt-1 text-sm text-ink-soft">
                {lastPlan.suiteId != null
                  ? 'Already running on the device — here is exactly what it will do.'
                  : 'Saved as a draft. Pick a device to run it.'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {lastPlan.suiteId != null && (
                <Button onClick={() => onRun(lastPlan.suiteId!)}>View live run</Button>
              )}
              <Button variant="outline" onClick={() => setLastPlan(null)}>Dismiss</Button>
            </div>
          </div>
          <ol className="mt-4 space-y-1 text-sm text-ink-soft">
            {lastPlan.lines.map((line, i) => (
              <li key={i} className={line.includes('review before running') ? 'text-amber-700' : undefined}>
                {line}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card className="p-6">
        <h2 className="font-sans text-base font-semibold text-ink">Describe a scenario</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Plain English, or attach a requirements document. Steps are grounded in{' '}
          {app ? <span className="font-mono text-ink">{app.package_name}</span> : 'the selected app'}
          {device ? <> and run on <span className="font-mono text-ink">{device.model ?? device.serial}</span> immediately.</> : ' and saved as a draft.'}
        </p>

        <div className="mt-5">
          <Textarea
            label="Objective"
            rows={4}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={'Log in with a valid account and verify the dashboard loads'}
            disabled={!aiEnabled}
            helperText={aiEnabled ? undefined : 'AI generation is off — set OPENAI_API_KEY on the backend to enable it.'}
          />
        </div>

        <div className="mt-4 max-w-xs">
          <Select
            label="Release (optional)"
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            helperText="Tag this run for later comparison."
          >
            <option value="">No release</option>
            {(releases.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>

        <input ref={docRef} type="file" accept=".pdf,.docx,.xlsx,.txt" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void generate(f) }} />

        <div className="mt-4 flex flex-wrap gap-3">
          <Button marker={false} disabled={!aiEnabled || busy === 'generate'} onClick={() => void generate()}>
            <Sparkles size={15} aria-hidden="true" />
            {busy === 'generate' ? 'Generating…' : 'Generate test'}
          </Button>
          <Button variant="outline" marker={false} disabled={!aiEnabled || busy === 'generate'}
                  onClick={() => docRef.current?.click()}>
            Attach a document
          </Button>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="flex flex-col p-6">
          <h2 className="font-sans text-base font-semibold text-ink">Import a test sheet</h2>
          <p className="mt-1 flex-1 text-sm text-ink-soft">
            A QA tracker in CSV or XLSX — Test Case, Steps, Expected Result. Column names can vary. Every row
            becomes its own test, generated and grounded individually.
          </p>
          <input ref={trackerRef} type="file" accept=".csv,.xlsx" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void generateBatch(f) }} />
          <Button className="mt-4 self-start" variant="outline" marker={false}
                  disabled={!aiEnabled || busy === 'batch'} onClick={() => trackerRef.current?.click()}>
            <FileUp size={15} aria-hidden="true" />
            {busy === 'batch' ? 'Starting…' : 'Choose sheet'}
          </Button>

          {job && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-xs text-ink">{job.filename}</span>
                <span className="shrink-0 font-mono text-xs text-muted">
                  {job.processed}/{job.total_rows}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full transition-[width] duration-300"
                  style={{
                    width: `${job.total_rows ? (job.processed / job.total_rows) * 100 : 0}%`,
                    backgroundColor: job.status === 'COMPLETED' ? 'var(--color-pass)' : 'var(--color-running)',
                  }}
                />
              </div>
              {job.not_automatable_rows > 0 && (
                <p className="mt-2 font-mono text-xs text-muted">
                  {job.not_automatable_rows} row(s) flagged as not automatable
                </p>
              )}
            </div>
          )}
        </Card>

        <Card className="flex flex-col p-6">
          <h2 className="font-sans text-base font-semibold text-ink">Import exact steps</h2>
          <p className="mt-1 flex-1 text-sm text-ink-soft">
            CSV or JSON already written in this engine's step format. Mapped one to one with no AI involved —
            use this when the steps are already decided and must not be reinterpreted.
          </p>
          <input ref={importRef} type="file" accept=".csv,.json" multiple className="hidden"
            onChange={(e) => { const f = e.target.files; e.target.value = ''; if (f?.length) void importFiles(f) }} />
          <Button className="mt-4 self-start" variant="outline" marker={false}
                  disabled={busy === 'import'} onClick={() => importRef.current?.click()}>
            <FileUp size={15} aria-hidden="true" />
            {busy === 'import' ? 'Importing…' : 'Choose files'}
          </Button>
        </Card>
      </div>
    </div>
  )
}
