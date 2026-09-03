/**
 * Sidebar structure. Every entry here points at a screen backed by a real
 * endpoint on `backend-node` — nothing is listed that cannot load data.
 *
 * Web Testing and Application Testing are two equally-weighted verticals,
 * each ordered to match the sequence a run actually goes through (discover
 * the app / upload the build -> author tests -> configure the environment ->
 * execute -> review results). Dashboard, AutoHeal and Reports sit outside
 * both verticals because they're cross-cutting: you check them across every
 * run regardless of which vertical produced it, so splitting them per
 * vertical would mean checking two places for "did anything fail."
 */
export type NavIconKey =
  | 'command-center'
  | 'projects'
  | 'application'
  | 'one-click-test'
  | 'code-generator'
  | 'tests'
  | 'releases'
  | 'executions'
  | 'mobile-apps'
  | 'mobile-devices'
  | 'mobile-author'
  | 'mobile-executions'
  | 'compatibility'
  | 'healing'
  | 'reports'
  | 'release-readiness'
  | 'release-comparison'
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
    items: [
      { label: 'Command Center', href: '/app/command-center', icon: 'command-center' },
      { label: 'Projects', href: '/app/projects', icon: 'projects' },
    ],
  },
  {
    label: 'Web Testing',
    items: [
      { label: 'App Discovery', href: '/app/application', icon: 'application' },
      { label: 'Author Tests', href: '/app/one-click-test', icon: 'one-click-test' },
      { label: 'Code Generator', href: '/app/code-generator', icon: 'code-generator' },
      { label: 'Test Suites', href: '/app/tests', icon: 'tests' },
      { label: 'Releases', href: '/app/releases', icon: 'releases' },
      { label: 'Executions', href: '/app/execution', icon: 'executions' },
    ],
  },
  {
    label: 'Application Testing',
    items: [
      { label: 'Apps', href: '/app/mobile/apps', icon: 'mobile-apps' },
      { label: 'Devices', href: '/app/mobile/devices', icon: 'mobile-devices' },
      { label: 'Author Tests', href: '/app/mobile/author', icon: 'mobile-author' },
      { label: 'Executions', href: '/app/mobile/executions', icon: 'mobile-executions' },
      { label: 'Compatibility', href: '/app/mobile/compatibility', icon: 'compatibility' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'AutoHeal', href: '/app/healing', icon: 'healing' },
      { label: 'Reports', href: '/app/reports', icon: 'reports' },
      { label: 'Release Readiness', href: '/app/reports/release-readiness', icon: 'release-readiness' },
      { label: 'Compare Releases', href: '/app/reports/release-comparison', icon: 'release-comparison' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Integrations', href: '/app/integrations', icon: 'integrations' },
      { label: 'Settings', href: '/app/settings', icon: 'settings' },
    ],
  },
]
