import type { HTMLAttributes, ReactNode } from 'react'

type CardProps = {
  children: ReactNode
  className?: string
} & HTMLAttributes<HTMLDivElement>

export function Card({ children, className = '', ...rest }: CardProps) {
  return (
    <div
      className={`rounded-card bg-paper-alt shadow-float print:rounded-none print:border print:border-line print:shadow-none print:break-inside-avoid ${className}`.trim()}
      {...rest}
    >
      {children}
    </div>
  )
}
