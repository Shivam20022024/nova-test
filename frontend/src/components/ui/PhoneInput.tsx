import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import PhoneNumberInput from 'react-phone-number-input'
import type { Country, Value } from 'react-phone-number-input'
import { ChevronDown } from 'lucide-react'
import { SearchBar } from './SearchBar'
import 'react-phone-number-input/style.css'

export type PhoneInputHandle = {
  focus: () => void
}

type PhoneInputProps = {
  label: string
  error?: string
  helperText?: string
  value?: Value
  onChange: (value?: Value) => void
  defaultCountry?: Country
  placeholder?: string
}

type CountryOption = { value?: Country; label: string }

function CountrySelect({
  value,
  onChange,
  options,
  iconComponent: Icon,
  disabled,
  readOnly,
}: {
  value?: Country
  onChange: (value?: Country) => void
  options: CountryOption[]
  iconComponent: ComponentType<{ country?: Country }>
  disabled?: boolean
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = query.trim()
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        disabled={disabled || readOnly}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Country"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon country={value} />
        <ChevronDown size={13} aria-hidden="true" className="country-select-chevron text-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Country"
          className="absolute top-full left-0 z-30 mt-2 w-64 rounded-md border border-line bg-paper-alt shadow-float"
        >
          <div className="border-b border-line p-2">
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Search countries…"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted">No countries found.</p>
            )}
            {filtered.map((option) => (
              <button
                key={option.value ?? 'ZZ'}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                  setQuery('')
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-paper ${
                  option.value === value ? 'bg-accent-soft text-accent-deep' : 'text-ink'
                }`}
              >
                <Icon country={option.value} />
                <span className="truncate">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export const PhoneInput = forwardRef<PhoneInputHandle, PhoneInputProps>(function PhoneInput(
  { label, error, helperText, value, onChange, defaultCountry, placeholder },
  ref,
) {
  const generatedId = useId()
  const inputId = `phone-${generatedId}`
  const helperId = `${inputId}-helper`
  const containerRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => containerRef.current?.querySelector('input')?.focus(),
  }))

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div ref={containerRef}>
        <PhoneNumberInput
          id={inputId}
          international
          addInternationalOption={false}
          countrySelectComponent={CountrySelect}
          defaultCountry={defaultCountry}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error || helperText ? helperId : undefined}
          className={error ? 'phone-input--error' : undefined}
        />
      </div>
      {(error || helperText) && (
        <p id={helperId} className={`text-xs ${error ? 'text-fail' : 'text-muted'}`}>
          {error ?? helperText}
        </p>
      )}
    </div>
  )
})
