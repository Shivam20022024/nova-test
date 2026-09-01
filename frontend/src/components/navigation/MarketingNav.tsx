import { Link } from 'react-router-dom'
import { Button } from '../ui/Button'
import { Logo } from '../ui/Logo'

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 md:px-10">
        <Link to="/" className="text-xl text-ink">
          <Logo size={30} />
        </Link>

        <Button href="/login" marker={false}>
          Get started →
        </Button>
      </div>
    </header>
  )
}
