import { useId } from 'react'

type ConfidenceRingProps = {
  score: number
  tier: string
  size?: number
  /** Ring/tier color. Defaults to the brand accent (Command Center's usage). */
  color?: string
  /** Light end of the gradient. Defaults to a 65%-white tint of `color`. */
  softColor?: string
}

export function ConfidenceRing({ score, tier, size = 176, color, softColor }: ConfidenceRingProps) {
  const strokeWidth = size * 0.09
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - clamped / 100)
  const ringColor = color ?? 'var(--color-accent)'
  const ringSoftColor = softColor ?? (color ? `color-mix(in srgb, ${color} 35%, white)` : 'var(--color-accent-soft)')
  const gradientId = `confidence-ring-gradient-${useId()}`

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={ringSoftColor} />
            <stop offset="100%" stopColor={ringColor} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-ink font-sans"
          style={{ fontSize: size * 0.24, fontWeight: 700 }}
        >
          {clamped}
        </text>
        <text
          x="50%"
          y="63%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-muted font-mono"
          style={{ fontSize: size * 0.075 }}
        >
          / 100
        </text>
      </svg>
      <p className="mt-1 font-mono text-sm font-medium" style={{ color: color ?? 'var(--color-accent-deep)' }}>
        {tier}
      </p>
    </div>
  )
}
