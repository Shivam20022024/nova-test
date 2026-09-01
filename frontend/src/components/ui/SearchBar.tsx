import { Search } from 'lucide-react'
import type { InputHTMLAttributes } from 'react'

type SearchBarProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className' | 'type'>

export function SearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  className = '',
  ...rest
}: SearchBarProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-line bg-paper-alt px-3 py-2 text-sm text-ink focus-within:border-accent ${className}`.trim()}
    >
      <Search size={15} aria-hidden="true" className="shrink-0 text-muted" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full bg-transparent placeholder:text-muted focus:outline-none"
        {...rest}
      />
    </div>
  )
}
