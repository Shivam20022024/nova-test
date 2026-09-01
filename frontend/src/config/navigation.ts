/**
 * Sidebar structure. Every entry here points at a screen backed by a real
 * endpoint on `backend-node` — nothing is listed that cannot load data.
 */
export type NavIconKey =
  | 'command-center'
  | 'one-click-test'
  | 'code-generator'
  | 'projects'
  | 'application'
  | 'tests'
  | 'mobile'
  | 'executions'
  | 'healing'
  | 'reports'
  | 'integrations'
  | 'settings'

export type NavItem = {
  label: string
  href: string
  icon: NavIconKey
}

export type NavGroup = {
  label: string | null
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: null,
    items: [{ label: 'Command Center', href: '/app/command-center', icon: 'command-center' }],
  },
  {
    label: 'Create',
    items: [
      { label: 'One-Click Test', href: '/app/one-click-test', icon: 'one-click-test' },
      { label: 'Code Generator', href: '/app/code-generator', icon: 'code-generator' },
    ],
  },
  {
    label: 'Quality',
    items: [
      { label: 'Projects', href: '/app/projects', icon: 'projects' },
      { label: 'Application', href: '/app/application', icon: 'application' },
      { label: 'Tests', href: '/app/tests', icon: 'tests' },
      { label: 'Mobile', href: '/app/mobile', icon: 'mobile' },
      { label: 'Executions', href: '/app/execution', icon: 'executions' },
      { label: 'AutoHeal', href: '/app/healing', icon: 'healing' },
    ],
  },
  {
    label: 'Intelligence',
    items: [{ label: 'Reports', href: '/app/reports', icon: 'reports' }],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Integrations', href: '/app/integrations', icon: 'integrations' },
      { label: 'Settings', href: '/app/settings', icon: 'settings' },
    ],
  },
]
