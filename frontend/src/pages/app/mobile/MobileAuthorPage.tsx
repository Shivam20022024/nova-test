import { useNavigate } from 'react-router-dom'
import { useMobileTest } from '../../../contexts/MobileTestContext'
import { AuthorPanel } from './components/AuthorPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

/** Step 3 of Application Testing: describe a scenario, attach a requirements
 *  document, or import an existing test sheet. A run that has a device
 *  starts immediately and lands on its live view, the same one-click
 *  experience as Web Testing's One-Click Test. */
export default function MobileAuthorPage() {
  const navigate = useNavigate()
  const { applications, devices, capabilities, applicationId, deviceId, reload } = useMobileTest()

  return (
    <MobileVerticalPage
      title="Author Tests"
      description="Describe what to test in plain English, attach a document, or import a CSV/XLSX test sheet."
    >
      <AuthorPanel
        applications={applications}
        devices={devices}
        aiEnabled={!!capabilities?.features.ai_gateway}
        applicationId={applicationId}
        deviceId={deviceId}
        onChanged={() => void reload()}
        onRun={(suiteId) => navigate(`/app/mobile/executions/${suiteId}`)}
      />
    </MobileVerticalPage>
  )
}
