import { Outlet } from 'react-router-dom'
import { MarketingNav } from '../components/navigation/MarketingNav'

export default function MarketingLayout() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <MarketingNav />
      <Outlet />
    </div>
  )
}
