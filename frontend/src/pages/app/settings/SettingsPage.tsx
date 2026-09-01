import { LogOut, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { PageHeader } from '../../../components/ui/PageHeader'
import { useAuth } from '../../../contexts/AuthContext'
import { useData } from '../../../contexts/DataContext'

/**
 * Only settings with somewhere real to live are shown.
 *
 * The original design had eight sections (Project, Environment, Execution,
 * Notifications, AI, Policies, Appearance, API Keys). The backend has no
 * settings model behind any of them, so rather than render controls that
 * silently discard input, this page covers the account and points at the
 * places where real configuration actually happens.
 *
 * Appearance is absent for the same reason: the design system defines a light
 * palette only, so a theme switcher would change nothing.
 */
export default function SettingsPage() {
  const { currentUser, logout } = useAuth()
  const { activeProject } = useData()
  const navigate = useNavigate()

  const metadata = (currentUser?.user_metadata ?? {}) as { full_name?: string; role?: string }

  return (
    <div>
      <PageHeader title="Settings" description="Your account and where things are configured." />

      <div className="grid max-w-3xl gap-6">
        <Card className="p-6">
          <div className="flex items-center gap-3 border-b border-line pb-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-accent-deep">
              <User size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="font-sans text-base font-semibold text-ink">Account</h2>
              <p className="text-xs text-muted">Managed through your Supabase identity.</p>
            </div>
          </div>

          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="font-mono text-xs tracking-wide text-muted uppercase">Name</dt>
              <dd className="mt-1 text-sm break-words text-ink">
                {metadata.full_name || 'Not set'}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs tracking-wide text-muted uppercase">Email</dt>
              <dd className="mt-1 text-sm break-words text-ink">{currentUser?.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs tracking-wide text-muted uppercase">Platform role</dt>
              <dd className="mt-1 text-sm text-ink">{metadata.role || 'QA Engineer'}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs tracking-wide text-muted uppercase">Active project</dt>
              <dd className="mt-1 text-sm break-words text-ink">
                {activeProject?.name ?? 'None selected'}
              </dd>
            </div>
          </dl>

          <div className="mt-5 border-t border-line pt-4">
            <Button
              variant="outline"
              marker={false}
              onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
            >
              <LogOut size={15} aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-sans text-base font-semibold text-ink">Configuration lives elsewhere</h2>
          <p className="mt-1 text-sm text-ink-soft">
            These are the settings the platform actually stores.
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            <li className="flex items-center justify-between gap-3 rounded-md border border-line p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Projects and test suites</p>
                <p className="text-xs text-muted">Create, rename and delete workspaces.</p>
              </div>
              <Button href="/app/projects" variant="outline" marker={false}>
                Open
              </Button>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-md border border-line p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Jira integration</p>
                <p className="text-xs text-muted">Credentials and automatic bug filing, per project.</p>
              </div>
              <Button href="/app/integrations" variant="outline" marker={false}>
                Open
              </Button>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}
