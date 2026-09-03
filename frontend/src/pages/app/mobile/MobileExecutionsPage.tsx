import { useState } from 'react'
import { Tabs } from '../../../components/ui/Tabs'
import { useMobileTest } from '../../../contexts/MobileTestContext'
import { LiveExecutionPanel } from './components/LiveExecutionPanel'
import { RunsPanel } from './components/RunsPanel'
import { SuitesPanel } from './components/SuitesPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

const TABS = [
  { id: 'suites', label: 'Suites' },
  { id: 'runs', label: 'Runs' },
]

/** Step 4 of Application Testing: everything that has run or is running,
 *  grouped by suite (a batch authored/imported together) or as a flat
 *  recent-runs list — the mobile equivalent of Web Testing's Executions
 *  page. */
export default function MobileExecutionsPage() {
  const { suites, executions, loading } = useMobileTest()
  const [tab, setTab] = useState('suites')
  const [watching, setWatching] = useState<number | null>(null)

  function watch(id: number) {
    setWatching(id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <MobileVerticalPage
      title="Executions"
      description="Every suite and run for this project, however it was started."
    >
      {watching != null && (
        <div className="mb-6">
          <LiveExecutionPanel executionId={watching} onClose={() => setWatching(null)} />
        </div>
      )}

      <Tabs tabs={TABS} activeId={tab} onChange={setTab} className="mb-6" />

      {tab === 'suites' && <SuitesPanel suites={suites} loading={loading} onWatch={watch} />}
      {tab === 'runs' && (
        <RunsPanel executions={executions} loading={loading} activeId={watching} onWatch={watch} />
      )}
    </MobileVerticalPage>
  )
}
