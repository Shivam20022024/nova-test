import { useState } from 'react'
import { Code2, Copy, Download, Play, Terminal } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { api } from '../../../lib/api'
import { useToast } from '../../../contexts/ToastContext'

/**
 * Frameworks the generator can emit. Only Playwright can be run in the backend
 * sandbox — `/ai/execute-raw-code` rejects anything else outright — so the run
 * button explains why it is disabled for the other two rather than failing.
 */
const FRAMEWORKS = [
  { id: 'playwright', label: 'Playwright (TypeScript)', extension: 'spec.ts', runnable: true },
  { id: 'cypress', label: 'Cypress (JavaScript)', extension: 'cy.js', runnable: false },
  { id: 'selenium', label: 'Selenium (Python)', extension: 'py', runnable: false },
] as const

type FrameworkId = (typeof FRAMEWORKS)[number]['id']

export default function CodeGeneratorPage() {
  const { triggerToast } = useToast()

  const [url, setUrl] = useState('')
  const [instructions, setInstructions] = useState('')
  const [framework, setFramework] = useState<FrameworkId>('playwright')
  const [generating, setGenerating] = useState(false)
  const [code, setCode] = useState('')
  const [executing, setExecuting] = useState(false)
  const [output, setOutput] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const activeFramework = FRAMEWORKS.find((item) => item.id === framework)!

  async function generate() {
    let valid = true
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setUrlError('Enter a full URL including http:// or https://')
      valid = false
    } else {
      setUrlError(null)
    }
    if (!instructions.trim()) {
      setInstructionsError('Describe what the test should do.')
      valid = false
    } else {
      setInstructionsError(null)
    }
    if (!valid) return

    setGenerating(true)
    setCode('')
    setOutput('')
    try {
      const result = await api.generateRawCode(url, instructions, framework)
      setCode(result.code || '')
      triggerToast('Test script generated.')
    } catch (error) {
      triggerToast(`Generation failed: ${(error as Error).message}`, true)
    } finally {
      setGenerating(false)
    }
  }

  async function execute() {
    if (!code) return
    setExecuting(true)
    setOutput('Executing in sandbox…\n')
    try {
      const result = await api.executeRawCode(code, framework)
      setOutput((prev) => prev + result.output)
      if (result.success) triggerToast('Sandbox run completed.')
      else triggerToast('Sandbox run finished with errors.', true)
    } catch (error) {
      setOutput((prev) => `${prev}\nExecution error: ${(error as Error).message}`)
      triggerToast(`Sandbox run failed: ${(error as Error).message}`, true)
    } finally {
      setExecuting(false)
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      triggerToast('Code copied to clipboard.')
    } catch {
      triggerToast('Could not copy to clipboard.', true)
    }
  }

  function downloadCode() {
    const blob = new Blob([code], { type: 'text/plain' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `test.${activeFramework.extension}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(href)
  }

  return (
    <div>
      <PageHeader
        title="Code Generator"
        description="Describe a test in plain English and get runnable automation code."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="h-fit p-6">
          <h2 className="flex items-center gap-2 border-b border-line pb-3 font-sans text-base font-semibold text-ink">
            <Code2 size={17} aria-hidden="true" className="text-accent" />
            Instructions
          </h2>

          <div className="mt-5 flex flex-col gap-4">
            <Input
              label="Target application URL"
              type="url"
              spellCheck={false}
              placeholder="https://your-staging-site.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              error={urlError ?? undefined}
            />

            <Textarea
              label="What should the test do?"
              rows={6}
              placeholder="Sign in as a premium user, add a pair of shoes to the cart, and verify the total is $50."
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              error={instructionsError ?? undefined}
            />

            <Select
              label="Framework"
              value={framework}
              onChange={(event) => setFramework(event.target.value as FrameworkId)}
            >
              {FRAMEWORKS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>

            <Button onClick={() => void generate()} disabled={generating} className="justify-center">
              {generating ? 'Generating…' : 'Generate code'}
            </Button>
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <h2 className="font-sans text-base font-semibold text-ink">Generated code</h2>
              {code && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void copyCode()}
                    title="Copy code"
                    aria-label="Copy code"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
                  >
                    <Copy size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={downloadCode}
                    title={`Download test.${activeFramework.extension}`}
                    aria-label="Download code"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
                  >
                    <Download size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {code ? (
              <>
                <pre className="mt-4 max-h-96 overflow-auto rounded-md border border-line bg-ink p-4 font-mono text-xs leading-relaxed text-paper">
                  {code}
                </pre>
                <div className="mt-4">
                  <Button
                    onClick={() => void execute()}
                    disabled={executing || !activeFramework.runnable}
                    title={
                      activeFramework.runnable
                        ? undefined
                        : `Sandbox execution supports Playwright only — ${activeFramework.label} can be downloaded and run locally.`
                    }
                    className="justify-center"
                  >
                    <Play size={15} aria-hidden="true" />
                    {executing
                      ? 'Running…'
                      : activeFramework.runnable
                        ? 'Run in sandbox'
                        : 'Sandbox supports Playwright only'}
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState
                className="border-0 py-10"
                icon={Code2}
                title="Nothing generated yet"
                description="Describe your test on the left, then generate the code."
              />
            )}
          </Card>

          {output && (
            <Card className="p-6">
              <h2 className="flex items-center gap-2 border-b border-line pb-3 font-sans text-base font-semibold text-ink">
                <Terminal size={17} aria-hidden="true" className="text-accent" />
                Sandbox output
              </h2>
              <pre className="mt-4 max-h-72 overflow-auto rounded-md border border-line bg-ink p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-paper">
                {output}
              </pre>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
