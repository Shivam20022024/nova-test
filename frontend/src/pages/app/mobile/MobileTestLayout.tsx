import { Outlet } from 'react-router-dom'
import { MobileTestProvider } from '../../../contexts/MobileTestContext'

/** Mounts the shared app/device selection + data once above every
 *  Application Testing route, so it survives navigating between them. */
export default function MobileTestLayout() {
  return (
    <MobileTestProvider>
      <Outlet />
    </MobileTestProvider>
  )
}
