import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Input } from '../../../../components/ui/Input'
import { Modal } from '../../../../components/ui/Modal'
import { Select } from '../../../../components/ui/Select'
import { Textarea } from '../../../../components/ui/Textarea'
import { api } from '../../../../lib/api'
import type { TestCase, TestSuite } from '../../../../lib/types'
import { useToast } from '../../../../contexts/ToastContext'

/**
 * Actions the execution agent understands. Kept in step with the `validActions`
 * list in `backend-node/src/agents/ExecutionAgent.ts` — anything outside it is
 * logged as an unsupported step and skipped at run time.
 */
const WEB_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'hover',
  'wait',
  'assertVisible',
  'assertText',
  'assertNotVisible',
  'screenshot',
] as const

const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

type WebStep = { action: string; selector: string; value: string }
type ApiStep = { method: string; url: string; expectedStatus: string }

function emptyWebStep(): WebStep {
  return { action: 'goto', selector: '', value: '' }
}

function emptyApiStep(): ApiStep {
  return { method: 'GET', url: '', expectedStatus: '200' }
}

/** Rebuilds the modal's editable step rows from steps already stored on a test case. */
function toWebSteps(rawSteps: unknown[]): WebStep[] {
  if (rawSteps.length === 0) return [emptyWebStep()]
  return rawSteps.map((raw) => {
    const step = raw as Record<string, unknown>
    return {
      action: typeof step.action === 'string' ? step.action : 'goto',
      selector: typeof step.selector === 'string' ? step.selector : '',
      value: typeof step.value === 'string' ? step.value : '',
    }
  })
}

function toApiSteps(rawSteps: unknown[]): ApiStep[] {
  if (rawSteps.length === 0) return [emptyApiStep()]
  return rawSteps.map((raw) => {
    const step = raw as { method?: string; url?: string; assertions?: Array<{ expected?: unknown }> }
    const status = step.assertions?.[0]?.expected
    return {
      method: step.method ?? 'GET',
      url: step.url ?? '',
      expectedStatus: status != null ? String(status) : '',
    }
  })
}

type CreateTestModalProps = {
  open: boolean
  onClose: () => void
  suite: TestSuite
  /** When set, the modal edits this test case instead of creating a new one. */
  editingTest?: TestCase | null
  onSaved: (test: TestCase) => void
}

export function CreateTestModal({ open, onClose, suite, editingTest, onSaved }: CreateTestModalProps) {
  const { triggerToast } = useToast()
  const isApi = suite.type === 'API'
  const isEditing = editingTest != null

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [webSteps, setWebSteps] = useState<WebStep[]>([emptyWebStep()])
  const [apiSteps, setApiSteps] = useState<ApiStep[]>([emptyApiStep()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed the form whenever the modal opens, either blank for a new test
  // case or populated from the case being edited.
  useEffect(() => {
    if (!open) return
    setError(null)
    if (editingTest) {
      setName(editingTest.name)
      setDescription(editingTest.intent ?? '')
      const rawSteps = Array.isArray(editingTest.steps) ? editingTest.steps : []
      setWebSteps(toWebSteps(rawSteps))
      setApiSteps(toApiSteps(rawSteps))
    } else {
      setName('')
      setDescription('')
      setWebSteps([emptyWebStep()])
      setApiSteps([emptyApiStep()])
    }
  }, [open, editingTest])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Enter a test case name.')
      return
    }

    // `step_index` is carried over from the previous frontend: the execution
    // plan is order-sensitive and this keeps ordering explicit in the payload.
    const steps = isApi
      ? apiSteps
          .filter((step) => step.url.trim())
          .map((step) => ({
            method: step.method,
            url: step.url.trim(),
            assertions: step.expectedStatus.trim()
              ? [{ type: 'status', operator: 'equals', expected: Number(step.expectedStatus) }]
              : [],
          }))
      : webSteps
          .filter((step) => step.action)
          .map((step, index) => ({
            action: step.action,
            selector: step.selector.trim(),
            value: step.value.trim(),
            step_index: index,
          }))

    if (steps.length === 0) {
      setError('Add at least one step.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      const saved = isEditing
        ? await api.updateTestCase(
            suite.id,
            editingTest.id,
            name.trim(),
            steps,
            description.trim() || undefined,
          )
        : await api.createTestCase(suite.id, name.trim(), steps, description.trim() || undefined)
      triggerToast(isEditing ? `Test case "${saved.name}" updated.` : `Test case "${saved.name}" created.`)
      onSaved(saved)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEditing ? `Edit ${editingTest.name}` : `New test case in ${suite.name}`}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Textarea
          label="Intent"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          helperText="What this test is meant to prove. Optional."
        />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-ink">Steps</p>
            <Button
              variant="outline"
              marker={false}
              className="px-2.5 py-1 text-xs"
              onClick={() =>
                isApi
                  ? setApiSteps((prev) => [...prev, emptyApiStep()])
                  : setWebSteps((prev) => [...prev, emptyWebStep()])
              }
            >
              <Plus size={13} aria-hidden="true" />
              Add step
            </Button>
          </div>

          <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {isApi
              ? apiSteps.map((step, index) => (
                  <div key={index} className="flex items-end gap-2 rounded-md border border-line p-2">
                    <div className="w-28 shrink-0">
                      <Select
                        label="Method"
                        value={step.method}
                        onChange={(event) =>
                          setApiSteps((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, method: event.target.value } : s,
                            ),
                          )
                        }
                      >
                        {API_METHODS.map((method) => (
                          <option key={method} value={method}>
                            {method}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Input
                        label="URL"
                        value={step.url}
                        onChange={(event) =>
                          setApiSteps((prev) =>
                            prev.map((s, i) => (i === index ? { ...s, url: event.target.value } : s)),
                          )
                        }
                      />
                    </div>
                    <div className="w-24 shrink-0">
                      <Input
                        label="Status"
                        value={step.expectedStatus}
                        onChange={(event) =>
                          setApiSteps((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, expectedStatus: event.target.value } : s,
                            ),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setApiSteps((prev) => prev.filter((_, i) => i !== index))}
                      aria-label={`Remove step ${index + 1}`}
                      className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-fail/10 hover:text-fail"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))
              : webSteps.map((step, index) => (
                  <div key={index} className="flex items-end gap-2 rounded-md border border-line p-2">
                    <div className="w-32 shrink-0">
                      <Select
                        label="Action"
                        value={step.action}
                        onChange={(event) =>
                          setWebSteps((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, action: event.target.value } : s,
                            ),
                          )
                        }
                      >
                        {WEB_ACTIONS.map((action) => (
                          <option key={action} value={action}>
                            {action}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Input
                        label={step.action === 'goto' ? 'URL' : 'Selector'}
                        value={step.selector}
                        onChange={(event) =>
                          setWebSteps((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, selector: event.target.value } : s,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="w-28 shrink-0">
                      <Input
                        label="Value"
                        value={step.value}
                        onChange={(event) =>
                          setWebSteps((prev) =>
                            prev.map((s, i) => (i === index ? { ...s, value: event.target.value } : s)),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setWebSteps((prev) => prev.filter((_, i) => i !== index))}
                      aria-label={`Remove step ${index + 1}`}
                      className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-fail/10 hover:text-fail"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
          </div>
        </div>

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
            {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Create test case'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
