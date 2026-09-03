import { useState } from 'react'
import { useMobileTest } from '../../../contexts/MobileTestContext'
import { CompatibilityPanel } from './components/CompatibilityPanel'
import { LiveExecutionPanel } from './components/LiveExecutionPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

/** Mobile-only: run one saved test across several devices at once — for
 *  checking the same app/test behaves the same way across Android versions,
 *  manufacturers, or screen sizes. Has no Web Testing equivalent. */
export default function MobileCompatibilityPage() {
  const { tests, devices, loading } = useMobileTest()
  const [watching, setWatching] = useState<number | null>(null)

  return (
    <MobileVerticalPage
      title="Compatibility"
      description="Run one saved test on several devices at the same time and get a single per-device pass/fail report."
    >
      {watching != null && (
        <div className="mb-6">
          <LiveExecutionPanel executionId={watching} onClose={() => setWatching(null)} />
        </div>
      )}
      <CompatibilityPanel
        tests={tests}
        devices={devices}
        loading={loading}
        onWatch={(id) => {
          setWatching(id)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />
    </MobileVerticalPage>
  )
}
