import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AtSign, Building2 } from 'lucide-react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Logo } from '../../components/ui/Logo'
import { PhoneInput } from '../../components/ui/PhoneInput'
import type { PhoneInputHandle } from '../../components/ui/PhoneInput'
import { Select } from '../../components/ui/Select'
import { useAuth } from '../../contexts/AuthContext'

/**
 * Carried over from the previous frontend: the chosen role is stored in
 * Supabase `user_metadata.role` and read back by the app shell.
 */
const PLATFORM_ROLES = ['Administrator', 'QA Engineer', 'Product Owner', 'Viewer (Read Only)']

type FieldErrors = {
  fullName?: string
  email?: string
  phone?: string
  password?: string
  confirmPassword?: string
}

const fieldOrder: (keyof FieldErrors)[] = ['fullName', 'email', 'phone', 'password', 'confirmPassword']

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function CreateAccountPage() {
  const navigate = useNavigate()
  const { signup } = useAuth()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState(PLATFORM_ROLES[1])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [phone, setPhone] = useState<PhoneValue>()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const fieldRefs = useRef<Record<keyof FieldErrors, { focus: () => void } | null>>({
    fullName: null,
    email: null,
    phone: null,
    password: null,
    confirmPassword: null,
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()

    const nextErrors: FieldErrors = {}
    if (!fullName.trim()) nextErrors.fullName = 'Enter your full name.'
    if (!email.trim()) nextErrors.email = 'Enter your email.'
    else if (!emailPattern.test(email.trim())) nextErrors.email = 'Enter a valid email address.'
    if (!phone) nextErrors.phone = 'Enter your phone number.'
    else if (!isValidPhoneNumber(phone)) nextErrors.phone = 'Enter a valid phone number.'
    if (!password) nextErrors.password = 'Choose a password.'
    else if (password.length < 8) nextErrors.password = 'Password must be at least 8 characters.'
    if (!confirmPassword) nextErrors.confirmPassword = 'Confirm your password.'
    else if (confirmPassword !== password) nextErrors.confirmPassword = 'Passwords do not match.'

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      const firstInvalidField = fieldOrder.find((field) => nextErrors[field])
      if (firstInvalidField) fieldRefs.current[firstInvalidField]?.focus()
      return
    }

    setErrors({})
    setSubmitError(null)
    setSubmitting(true)
    try {
      await signup(email.trim(), password, fullName.trim(), role)
      // Supabase may require email confirmation before a session exists, so we
      // cannot assume the user is signed in here. Send them to the login page,
      // where an already-active session is forwarded on automatically.
      navigate('/login', { replace: true })
    } catch (err) {
      setSubmitError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-paper px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-1/2 h-96 w-[140%] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: 'var(--color-accent-soft)' }}
      />

      <div className="relative w-full max-w-md">
        <Link to="/" className="mb-8 flex justify-center text-lg text-ink">
          <Logo size={30} />
        </Link>

        <Card className="p-8">
          <h1 className="font-sans text-xl font-semibold text-ink">Create your account</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Set up your quality command center.
          </p>

          <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
            <Input
              ref={(el) => { fieldRefs.current.fullName = el }}
              label="Full name"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              error={errors.fullName}
            />
            <Input
              ref={(el) => { fieldRefs.current.email = el }}
              label="Email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              icon={<AtSign size={15} aria-hidden="true" />}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={errors.email}
            />
            <Input
              label="Company / organization"
              type="text"
              autoComplete="organization"
              icon={<Building2 size={15} aria-hidden="true" />}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              helperText="Optional."
            />
            <PhoneInput
              ref={(el: PhoneInputHandle | null) => { fieldRefs.current.phone = el }}
              label="Phone number"
              defaultCountry="US"
              value={phone}
              onChange={setPhone}
              error={errors.phone}
            />
            <Input
              ref={(el) => { fieldRefs.current.password = el }}
              label="Password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={errors.password}
              helperText={errors.password ? undefined : 'At least 8 characters.'}
            />
            <Input
              ref={(el) => { fieldRefs.current.confirmPassword = el }}
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              error={errors.confirmPassword}
            />

            <Select
              label="Platform role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {PLATFORM_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>

            {submitError && (
              <p role="alert" className="text-sm text-fail">
                {submitError}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="mt-2 justify-center">
              {submitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-ink-soft">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-ink hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
