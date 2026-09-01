import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../../../components/ui/Button'
import { Chip } from '../../../../components/ui/Chip'
import { Input } from '../../../../components/ui/Input'
import { Modal } from '../../../../components/ui/Modal'
import { Select } from '../../../../components/ui/Select'
import { Textarea } from '../../../../components/ui/Textarea'
import { BROWSERS, DEVICES } from '../../../../config/execution'
import type { TestSuite } from '../../../../lib/types'

export type RunConfig = {
  testName: string
  baseUrl: string
  suiteId: string
  browsers: string[]
  devices: string[]
  steps: unknown[]
}

type RunTestsModalProps = {
  open: boolean
  onClose: () => void
  suites: TestSuite[]
  defaultSuiteId: string | null
  submitting: boolean
  onSubmitRun: (config: RunConfig) => void
}

/**
 * Mirrors what `POST /executions/run-multi-test` accepts: a name, a base URL,
 * a suite, the browser/device matrix, and the step array.
 *
 * The original design also offered priority, concurrency, retry policy,
 * evidence policy, healing toggle and a quality gate. None of those exist in
 * the run payload or anywhere in the worker, so they are not offered here.
 */
export function RunTestsModal({
  open,
  onClose,
  suites,
  defaultSuiteId,
  submitting,
  onSubmitRun,
}: RunTestsModalProps) {
  const [testName, setTestName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [suiteId, setSuiteId] = useState(defaultSuiteId ?? '')
  const [browsers, setBrowsers] = useState<string[]>(['chromium'])
  const [devices, setDevices] = useState<string[]>(['Desktop'])
  const [stepsText, setStepsText] = useState('[]')
  const [error, setError] = useState<string | null>(null)

  function toggle(list: string[], setList: (next: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()

    if (!testName.trim()) {
      setError('Give this run a name.')
      return
    }
    if (browsers.length === 0) {
      setError('Select at least one browser — the backend rejects an empty list.')
      return
    }
    if (devices.length === 0) {
      setError('Select at least one device.')
      return
    }

    let steps: unknown[]
    try {
      const parsed = JSON.parse(stepsText || '[]')
      if (!Array.isArray(parsed)) throw new Error('Steps must be a JSON array.')
      steps = parsed
    } catch (err) {
      setError(`Steps are not valid JSON: ${(err as Error).message}`)
      return
    }

    setError(null)
    onSubmitRun({
      testName: testName.trim(),
      baseUrl: baseUrl.trim(),
      suiteId,
      browsers,
      devices,
      steps,
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="Run tests">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          label="Run name"
          value={testName}
          onChange={(event) => setTestName(event.target.value)}
        />

        <Input
          label="Target base URL"
          type="url"
          spellCheck={false}
          placeholder="https://your-staging-site.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />

        <Select
          label="Suite"
          value={suiteId}
          onChange={(event) => setSuiteId(event.target.value)}
          helperText="Runs are recorded against this suite."
        >
          {suites.length === 0 && <option value="">No suites in this project</option>}
          {suites.map((suite) => (
            <option key={suite.id} value={suite.id}>
              {suite.name} ({suite.type})
            </option>
          ))}
        </Select>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Browsers</p>
          <div className="flex flex-wrap gap-2">
            {BROWSERS.map((browser) => (
              <Chip
                key={browser.id}
                active={browsers.includes(browser.id)}
                onClick={() => toggle(browsers, setBrowsers, browser.id)}
              >
                {browser.label}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            One execution is queued per browser.
          </p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Devices</p>
          <div className="flex flex-wrap gap-2">
            {DEVICES.map((device) => (
              <Chip
                key={device.id}
                active={devices.includes(device.id)}
                onClick={() => toggle(devices, setDevices, device.id)}
              >
                {device.label}
              </Chip>
            ))}
          </div>
        </div>

        <Textarea
          label="Steps (JSON array)"
          rows={6}
          spellCheck={false}
          value={stepsText}
          onChange={(event) => setStepsText(event.target.value)}
          helperText="Playwright action objects. Leave as [] to let the agent plan the run."
        />

        {error && (
          <p role="alert" className="text-sm text-fail">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" marker={false} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Queueing…' : 'Run tests'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
