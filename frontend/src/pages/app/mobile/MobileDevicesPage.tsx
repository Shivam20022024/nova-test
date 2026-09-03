import { useNavigate } from 'react-router-dom'
import { useMobileTest } from '../../../contexts/MobileTestContext'
import { DevicesPanel } from './components/DevicesPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

/** Step 2 of Application Testing: confirm a real device or emulator is
 *  reachable before authoring or running anything against it. Picking one
 *  moves straight to Author, the same flow Apps uses to move on to here. */
export default function MobileDevicesPage() {
  const navigate = useNavigate()
  const { devices, loading, capabilities, deviceId, setDeviceId, reload } = useMobileTest()

  return (
    <MobileVerticalPage
      title="Devices"
      description="Physical phones and emulators, discovered live over adb."
    >
      <DevicesPanel
        devices={devices}
        loading={loading}
        emulatorAutoStart={!!capabilities?.features.emulator_auto_start}
        onChanged={() => void reload()}
        selectedId={deviceId}
        onSelect={(id) => {
          setDeviceId(id)
          navigate('/app/mobile/author')
        }}
      />
    </MobileVerticalPage>
  )
}
