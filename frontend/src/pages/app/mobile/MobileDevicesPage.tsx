import { useMobileTest } from '../../../contexts/MobileTestContext'
import { DevicesPanel } from './components/DevicesPanel'
import { MobileVerticalPage } from './MobileVerticalPage'

/** Step 2 of Application Testing: confirm a real device or emulator is
 *  reachable before authoring or running anything against it. */
export default function MobileDevicesPage() {
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
        onSelect={setDeviceId}
      />
    </MobileVerticalPage>
  )
}
