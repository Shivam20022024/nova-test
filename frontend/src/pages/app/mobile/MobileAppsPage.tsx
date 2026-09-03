import { useNavigate } from 'react-router-dom'
import { useMobileTest } from '../../../contexts/MobileTestContext'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

/** Step 1 of Application Testing: upload the Android build everything else
 *  hangs off — tests, devices, runs, and evidence are all grounded in the
 *  app selected here. Picking one moves straight to Devices, the same
 *  one-directional flow as picking a device moves on to Author. */
export default function MobileAppsPage() {
  const navigate = useNavigate()
  const { projectId, applications, devices, loading, applicationId, setApplicationId, reload } = useMobileTest()

  return (
    <MobileVerticalPage
      title="Apps"
      description="Upload an Android build. Its identifier, version, permissions and UI toolkit are read from the binary itself."
    >
      <ApplicationsPanel
        applications={applications}
        devices={devices}
        loading={loading}
        projectId={projectId!}
        onChanged={() => void reload()}
        selectedId={applicationId}
        onSelect={(id) => {
          setApplicationId(id)
          navigate('/app/mobile/devices')
        }}
      />
    </MobileVerticalPage>
  )
}
