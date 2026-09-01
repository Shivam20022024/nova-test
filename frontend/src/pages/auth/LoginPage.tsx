import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AtSign } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Logo } from '../../components/ui/Logo'
import { useAuth } from '../../contexts/AuthContext'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()

    if (!email.trim()) {
      setError('Enter your email address.')
      return
    }
    if (!emailPattern.test(email.trim())) {
      setError('Enter a valid email address.')
      return
    }
    if (!password) {
      setError('Enter your password.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      // No navigate() here: signing in updates the Supabase session, and the
      // RedirectIfAuthenticated guard forwards to the intended destination.
    } catch (err) {
      setError((err as Error).message)
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

      <div className="relative w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center text-lg text-ink">
          <Logo size={30} />
        </Link>

        <Card className="p-8">
          <h1 className="font-sans text-xl font-semibold text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-ink-soft">Sign in to your quality command center.</p>

          <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              icon={<AtSign size={15} aria-hidden="true" />}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={error ?? undefined}
            />

            <Button type="submit" disabled={submitting} className="mt-2 justify-center">
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-ink-soft">New to NovaTest AI?</p>
        <Button
          href="/create-account"
          variant="outline"
          marker={false}
          className="mt-3 w-full justify-center"
        >
          Create account
        </Button>
      </div>
    </div>
  )
}
