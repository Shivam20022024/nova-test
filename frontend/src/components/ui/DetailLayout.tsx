import type { ReactNode } from 'react'
import { Card } from './Card'
import { Tabs } from './Tabs'
import type { TabItem } from './Tabs'

type DetailLayoutProps = {
  eyebrow?: ReactNode
  title: string
  meta?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  banner?: ReactNode
  children?: ReactNode
  tabs?: TabItem[]
  activeTab?: string
  onTabChange?: (id: string) => void
  tabContent?: ReactNode
}

export function DetailLayout({
  eyebrow,
  title,
  meta,
  badges,
  actions,
  banner,
  children,
  tabs,
  activeTab,
  onTabChange,
  tabContent,
}: DetailLayoutProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
        <div className="min-w-0">
          {eyebrow && <p className="font-mono text-xs text-muted">{eyebrow}</p>}
          <h1 className="mt-1 font-sans text-2xl font-semibold text-ink">{title}</h1>
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
              {meta}
            </div>
          )}
          {badges && <div className="mt-3 flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {banner}

      {children}

      {tabs && tabs.length > 0 && (
        <Card className="p-0">
          <Tabs tabs={tabs} activeId={activeTab ?? tabs[0].id} onChange={onTabChange ?? (() => {})} className="px-5" />
          <div className="p-5">{tabContent}</div>
        </Card>
      )}
    </div>
  )
}
