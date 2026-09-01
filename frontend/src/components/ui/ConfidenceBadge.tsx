type Tier = 'low' | 'medium' | 'high'

type ConfidenceBadgeProps = {
  score: number
  /** positive: a high score is good (confidence). negative: a high score is bad (risk). */
  polarity?: 'positive' | 'negative'
  label?: string
  showScore?: boolean
}

function tierFor(score: number, polarity: 'positive' | 'negative'): Tier {
  if (polarity === 'positive') {
    if (score >= 85) return 'high'
    if (score >= 60) return 'medium'
    return 'low'
  }
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

const positiveColor: Record<Tier, string> = {
  high: 'var(--color-pass)',
  medium: 'var(--color-flaky)',
  low: 'var(--color-fail)',
}

// Risk badges invert the color mapping: a "high" tier means high risk, which reads as bad.
const negativeColor: Record<Tier, string> = {
  high: 'var(--color-fail)',
  medium: 'var(--color-flaky)',
  low: 'var(--color-pass)',
}

const tierLabel: Record<Tier, string> = { high: 'High', medium: 'Medium', low: 'Low' }

export function ConfidenceBadge({
  score,
  polarity = 'positive',
  label,
  showScore = true,
}: ConfidenceBadgeProps) {
  const tier = tierFor(score, polarity)
  const color = polarity === 'positive' ? positiveColor[tier] : negativeColor[tier]
  const text =
    label ??
    (polarity === 'positive'
      ? `${showScore ? `${score} · ` : ''}${tierLabel[tier]} Confidence`
      : `${showScore ? `${score} · ` : ''}${tierLabel[tier]} Risk`)

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs font-medium whitespace-nowrap"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, white)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {text}
    </span>
  )
}
