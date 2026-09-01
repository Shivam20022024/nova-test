/**
 * Client-side pre-parse of a free-text scenario, carried over from the previous
 * frontend (`services/ScenarioParser.js`).
 *
 * This is a rough first pass, not the real parser: the backend's
 * ScenarioParserAgent does the authoritative work server-side. Its only job is
 * to turn the textarea into the `customScenario` array the autonomous endpoint
 * expects, and to substitute a few dynamic values so scenarios that say
 * "a future date" or "a random email" get fresh data on every run.
 */
export type ParsedScenarioStep = {
  type: string
  description?: string
  target?: string
  value?: string
  strategy?: string
  expected?: string
}

function futureDate(): string {
  return new Date(Date.now() + 86_400_000 * 7).toISOString().split('T')[0]
}

function randomEmail(): string {
  return `test_${Math.floor(Math.random() * 100_000)}@example.com`
}

export function parseScenarioText(rawText: string): ParsedScenarioStep[] {
  if (!rawText || !rawText.trim()) return []

  const steps: ParsedScenarioStep[] = []

  for (const rawLine of rawText.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    // Comment lines are for the author, not the runner.
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue

    const line = trimmed.replace(/^-\s*/, '')
    const lower = line.toLowerCase()

    if (lower.includes('search') && lower.includes('in')) {
      const match = line.match(/search (?:for )?(.*) in (.*)/i)
      steps.push(
        match
          ? { type: 'search', target: match[1], value: match[2], description: line }
          : { type: 'search', value: line, description: line },
      )
    } else if (lower.includes('future date') || lower.includes('future check-in')) {
      steps.push({
        type: 'date_selection',
        strategy: 'dynamic_future',
        value: futureDate(),
        description: line,
      })
    } else if (lower.includes('random email')) {
      steps.push({ type: 'fill', strategy: 'random_email', value: randomEmail(), description: line })
    } else if (lower.includes('valid user')) {
      steps.push({ type: 'fill', strategy: 'valid_user', value: 'testuser', description: line })
    } else if (lower.includes('invalid password')) {
      steps.push({
        type: 'fill',
        strategy: 'invalid_password',
        value: 'invalid_password_123!',
        description: line,
      })
    } else if (lower.includes('verify') || lower.includes('assert')) {
      steps.push({ type: 'assertion', expected: 'results_visible', description: line })
    } else if (
      lower.includes('click') ||
      lower.includes('select') ||
      lower.includes('open') ||
      lower.includes('apply')
    ) {
      steps.push({ type: 'click', description: line })
    } else if (lower.includes('navigate') || lower.includes('return')) {
      steps.push({ type: 'navigate', description: line })
    } else {
      steps.push({ type: 'generic_action', description: line })
    }
  }

  return steps
}
