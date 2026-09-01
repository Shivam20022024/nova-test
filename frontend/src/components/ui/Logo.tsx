type LogoProps = {
  size?: number
  withWordmark?: boolean
  className?: string
}

export function Logo({ size = 28, withWordmark = true, className = '' }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="9" fill="var(--color-ink)" />
        <path
          d="M11 21V11L21 21V11"
          fill="none"
          stroke="white"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="22.5" cy="9.5" r="1.6" fill="var(--color-accent)" />
      </svg>
      {withWordmark && (
        <span className="font-mono font-bold tracking-tight">
          NovaTest <span style={{ color: 'var(--color-accent)' }}>AI</span>
        </span>
      )}
    </span>
  )
}
