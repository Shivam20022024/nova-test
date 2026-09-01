import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'

type Variant = 'solid' | 'outline'
type Tone = 'dark' | 'light'

type ButtonProps = {
  variant?: Variant
  tone?: Tone
  marker?: boolean
  href?: string
  className?: string
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

const base =
  'inline-flex items-center gap-2.5 rounded-sm px-5 py-3 font-mono text-sm tracking-tight transition-colors'

const variants: Record<`${Variant}-${Tone}`, string> = {
  'solid-dark': 'bg-ink text-paper hover:bg-ink-soft',
  'solid-light': 'bg-paper text-ink hover:bg-white',
  'outline-dark': 'border border-ink text-ink hover:bg-ink hover:text-paper',
  'outline-light': 'border border-paper/50 text-paper hover:bg-paper hover:text-ink',
}

export function Button({
  variant = 'solid',
  tone = 'dark',
  marker = true,
  href,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const classes = `${base} ${variants[`${variant}-${tone}`]} ${className}`.trim()
  const content = (
    <>
      {marker && (
        <span aria-hidden className="text-[0.55em] leading-none">
          ▪
        </span>
      )}
      {children}
    </>
  )

  if (href) {
    if (/^https?:\/\//.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
          {content}
        </a>
      )
    }

    return (
      <Link to={href} className={classes}>
        {content}
      </Link>
    )
  }

  return (
    <button type="button" className={classes} {...rest}>
      {content}
    </button>
  )
}
