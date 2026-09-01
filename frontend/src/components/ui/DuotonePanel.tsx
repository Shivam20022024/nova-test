const NOISE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"

type DuotonePanelProps = {
  className?: string
  seed?: number
}

/**
 * Abstract duotone gradient panel standing in for photography — no real
 * photo assets exist yet, so this fills the "duotone photography" slot
 * from the marketing visual system without fabricating a fake image.
 */
export function DuotonePanel({ className = '', seed = 0 }: DuotonePanelProps) {
  const rotate = 8 + seed * 32

  return (
    <div className={`relative overflow-hidden bg-ink ${className}`}>
      <div
        className="absolute -inset-1/4"
        style={{
          background:
            'radial-gradient(60% 60% at 30% 18%, var(--color-accent-soft) 0%, transparent 60%), radial-gradient(55% 55% at 78% 62%, var(--color-accent) 0%, transparent 65%), radial-gradient(70% 70% at 45% 105%, #0c0a13 0%, transparent 70%)',
          transform: `rotate(${rotate}deg)`,
        }}
      />
      <div
        className="absolute inset-0 opacity-30 mix-blend-overlay"
        style={{ backgroundImage: `url("${NOISE_URL}")` }}
      />
    </div>
  )
}
