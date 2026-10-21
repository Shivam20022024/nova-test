import {
  AppWindow,
  BarChart3,
  Braces,
  ChevronDown,
  Code2,
  Database,
  FlaskConical,
  FolderKanban,
  GitCompare,
  Layers,
  LayoutDashboard,
  Milestone,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAppShell } from '../../app/providers'
import { Logo } from '../ui/Logo'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { navGroups } from '../../config/navigation'
import type { NavIconKey } from '../../config/navigation'

const icons: Record<NavIconKey, LucideIcon> = {
  'command-center': LayoutDashboard,
  projects: FolderKanban,
  application: AppWindow,
  'one-click-test': Zap,
  'code-generator': Code2,
  tests: FlaskConical,
  releases: Milestone,
  executions: PlayCircle,
  'mobile-apps': Package,
  'mobile-devices': Smartphone,
  'mobile-author': Sparkles,
  'mobile-executions': PlayCircle,
  compatibility: Layers,
  'api-testing': Braces,
  'api-executions': PlayCircle,
  'db-connections': Plug,
  'db-testing': Database,
  'db-executions': PlayCircle,
  healing: Wand2,
  traceability: Network,
  reports: BarChart3,
  'release-readiness': ShieldCheck,
  'release-comparison': GitCompare,
  integrations: Plug,
  settings: SettingsIcon,
}

function useActiveHref() {
  const { pathname } = useLocation()
  const allHrefs = navGroups.flatMap((group) =>
    group.items.map((item) => item.href),
  )
  const matches = allHrefs.filter(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  )
  if (matches.length === 0) return null
  return matches.reduce((longest, href) => (href.length > longest.length ? href : longest))
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar, mobileNavOpen, closeMobileNav } = useAppShell()
  const activeHref = useActiveHref()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const collapsed = isDesktop && sidebarCollapsed

  // Labeled sections (Web Testing, Mobile Application Testing, ...) start
  // collapsed — their items only show once the section header is clicked.
  // The section holding the current page starts open, so navigating in
  // never hides the page you're already on.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const group of navGroups) {
      if (!group.label) continue
      initial[group.label] = group.items.some((item) => item.href === activeHref)
    }
    return initial
  })
  const toggleGroup = (label: string) =>
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))

  return (
    <>
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeMobileNav}
          className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col border-r border-line bg-paper-alt transition-transform duration-200 print:hidden lg:static lg:z-auto lg:translate-x-0 lg:transition-[width] lg:duration-150 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'lg:w-16' : 'lg:w-64'}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
          <Logo size={22} className="text-sm text-ink" />
          <button
            type="button"
            onClick={closeMobileNav}
            aria-label="Close navigation"
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </div>

        <nav
          className="flex-1 overflow-y-auto px-3 py-4"
          onClick={() => {
            if (collapsed) toggleSidebar()
          }}
        >
          {navGroups.map((group, groupIndex) => {
            // The ungrouped top section (Command Center/Projects/Releases)
            // has no label and always stays visible — only labeled sections
            // are collapsible.
            const isOpen = collapsed || !group.label || !!openGroups[group.label]
            return (
            <div key={group.label ?? `group-${groupIndex}`} className={groupIndex > 0 ? 'mt-6' : ''}>
              {group.label && !collapsed && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleGroup(group.label as string)
                  }}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-2 px-3 pb-2 text-left font-mono text-sm font-medium tracking-wide text-ink uppercase hover:text-ink-soft"
                >
                  <span className="text-left">{group.label}</span>
                  <ChevronDown
                    aria-hidden="true"
                    size={13}
                    className={`shrink-0 transition-transform duration-150 ${isOpen ? '' : '-rotate-90'}`}
                  />
                </button>
              )}
              {isOpen && (
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const Icon = icons[item.icon]
                  const isActive = item.href === activeHref

                  const content = (
                    <span
                      className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-base transition-colors ${
                        group.label ? '' : 'font-mono'
                      } ${
                        isActive
                          ? 'bg-selected font-medium text-accent-deep'
                          : 'text-ink hover:bg-paper'
                      } ${collapsed ? 'justify-center' : ''}`}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </span>
                  )

                  return (
                    <li key={item.label}>
                      <Link to={item.href} onClick={closeMobileNav}>
                        {content}
                      </Link>
                    </li>
                  )
                })}
              </ul>
              )}
            </div>
            )
          })}
        </nav>

        <div className="border-t border-line p-3">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden w-full items-center gap-3 rounded-md px-3 py-2 text-base text-ink transition-colors hover:bg-paper lg:flex ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
