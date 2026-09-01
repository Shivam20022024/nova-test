import { ChevronDown, Check, CircleHelp, LogOut, Menu, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Dropdown } from '../ui/Dropdown'
import { Logo } from '../ui/Logo'
import { environments, useAppShell } from '../../app/providers'
import { useAuth } from '../../contexts/AuthContext'
import { ALL_PROJECTS, useData } from '../../contexts/DataContext'

/** Two initials for the avatar, from the display name or the email local part. */
function initialsFor(name: string, email: string): string {
  const source = name.trim() || email.split('@')[0] || ''
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function Topbar() {
  const { environment, setEnvironment, openMobileNav } = useAppShell()
  const { projects, activeProject, setActiveProject } = useData()
  const { currentUser, logout } = useAuth()
  const navigate = useNavigate()

  const metadata = (currentUser?.user_metadata ?? {}) as { full_name?: string; role?: string }
  const email = currentUser?.email ?? ''
  const displayName = metadata.full_name?.trim() || email.split('@')[0] || 'Signed in'
  const role = metadata.role || 'QA Engineer'

  // "All Projects" is a real selection: the dashboard endpoints treat a missing
  // projectId as "across every project", so it is offered alongside the rest.
  const options = [ALL_PROJECTS, ...projects]

  return (
    <header className="relative border-b border-line bg-paper-alt print:hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(90deg, color-mix(in srgb, var(--color-accent-soft) 35%, transparent) 0%, transparent 45%)',
        }}
      />
      <div className="relative flex h-16 items-center gap-4 px-4 md:px-6">
        <button
          type="button"
          onClick={openMobileNav}
          aria-label="Open navigation"
          className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink lg:hidden"
        >
          <Menu aria-hidden="true" size={19} />
        </button>

        <Link to="/app/command-center" className="shrink-0 text-lg text-ink">
          <Logo size={26} />
        </Link>

        <div className="hidden items-center gap-3 sm:flex">
          <div className="h-6 w-px bg-line" />

          <Dropdown
            ariaLabel="Select project"
            trigger={() => (
              <span className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-ink hover:bg-paper">
                {activeProject?.name ?? 'No project'}
                <ChevronDown aria-hidden="true" size={14} className="text-muted" />
              </span>
            )}
          >
            {({ close }) => (
              <div className="w-56 py-1">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setActiveProject(option)
                      close()
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-paper"
                  >
                    <span className="truncate">{option.name}</span>
                    {option.id === activeProject?.id && (
                      <Check aria-hidden="true" size={14} className="shrink-0 text-accent" />
                    )}
                  </button>
                ))}
                <div className="mt-1 border-t border-line pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      close()
                      navigate('/app/projects')
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-soft hover:bg-paper hover:text-ink"
                  >
                    <Plus aria-hidden="true" size={14} />
                    Manage projects
                  </button>
                </div>
              </div>
            )}
          </Dropdown>

          <Dropdown
            ariaLabel="Select environment"
            trigger={() => (
              <span className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm text-ink hover:bg-paper">
                {environment}
                <ChevronDown aria-hidden="true" size={14} className="text-muted" />
              </span>
            )}
          >
            {({ close }) => (
              <div className="w-40 py-1">
                {environments.map((env) => (
                  <button
                    key={env}
                    type="button"
                    onClick={() => {
                      setEnvironment(env)
                      close()
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ink hover:bg-paper"
                  >
                    {env}
                    {env === environment && (
                      <Check aria-hidden="true" size={14} className="text-accent" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Dropdown
            align="right"
            ariaLabel="Help"
            trigger={() => (
              <span
                title="Help"
                className="flex h-9 w-9 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
              >
                <CircleHelp aria-hidden="true" size={17} />
              </span>
            )}
          >
            {({ close }) => (
              <div className="w-56 py-1">
                <p className="px-3 py-1.5 font-mono text-xs tracking-wide text-muted uppercase">
                  Help
                </p>
                <a
                  href="https://novalantis.com/contact-us/"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="block px-3 py-2 text-sm text-ink-soft hover:bg-paper hover:text-ink"
                >
                  Contact support
                </a>
              </div>
            )}
          </Dropdown>

          <Dropdown
            align="right"
            ariaLabel="Account menu"
            trigger={() => (
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono text-xs font-medium text-paper"
              >
                {initialsFor(displayName, email)}
              </span>
            )}
          >
            {({ close }) => (
              <div className="w-60">
                <div className="border-b border-line px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-ink">{displayName}</p>
                  <p className="truncate text-xs text-muted">{email}</p>
                  <p className="mt-1 font-mono text-xs tracking-wide text-muted uppercase">{role}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    void logout().then(() => navigate('/login', { replace: true }))
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink-soft hover:bg-paper hover:text-ink"
                >
                  <LogOut aria-hidden="true" size={15} />
                  Sign out
                </button>
              </div>
            )}
          </Dropdown>
        </div>
      </div>
    </header>
  )
}
