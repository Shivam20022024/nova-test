import { CompassIcon } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'

type NotFoundPageProps = {
  homeHref?: string
  homeLabel?: string
}

export default function NotFoundPage({
  homeHref = '/',
  homeLabel = 'Back to home',
}: NotFoundPageProps) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <EmptyState
        icon={CompassIcon}
        title="Page not found"
        description="The page you're looking for doesn't exist or may have moved."
        action={
          <Button href={homeHref} variant="outline" marker={false}>
            {homeLabel}
          </Button>
        }
      />
    </div>
  )
}
