import { ShieldCheck } from 'lucide-react'
import { Button } from './Button'

type ApprovalBannerProps = {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  pending?: boolean
}

export function ApprovalBanner({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  pending = false,
}: ApprovalBannerProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent bg-accent-soft p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-deep" />
        <div>
          <p className="text-sm font-medium text-accent-deep">{title}</p>
          <p className="mt-0.5 text-sm text-accent-deep">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="outline" marker={false} onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button marker={false} onClick={onConfirm} disabled={pending}>
          {pending ? 'Requesting…' : confirmLabel}
        </Button>
      </div>
    </div>
  )
}
