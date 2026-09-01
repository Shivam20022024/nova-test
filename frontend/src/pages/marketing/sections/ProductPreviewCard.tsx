import { Card } from '../../../components/ui/Card'
import { DuotonePanel } from '../../../components/ui/DuotonePanel'
import { TrendBarChart } from '../../../components/charts/TrendBarChart'
import { commandCenterPreview } from '../../../content/commandCenterPreview'
import { previewExecutionsTrend } from '../../../content/marketingPreview'

export function ProductPreviewCard() {
  const [passed, runTime, confidence] = commandCenterPreview.metrics

  return (
    <Card className="p-6 text-left md:p-10">
      <p className="font-serif text-2xl text-ink md:text-3xl">{commandCenterPreview.greeting}</p>
      <p className="mt-1 text-ink-soft">{commandCenterPreview.subGreeting}</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-md border border-line p-5">
          <p className="font-mono text-xs tracking-wide text-muted uppercase">{passed.label}</p>
          <p className="mt-6 font-serif text-4xl text-ink">
            {passed.value}
            <span className="ml-2 font-mono text-sm text-pass">{passed.meta}</span>
          </p>
        </div>

        <div className="rounded-md border border-line p-5">
          <p className="font-mono text-xs tracking-wide text-muted uppercase">{runTime.label}</p>
          <p className="mt-6 font-serif text-4xl text-ink">
            {runTime.value}
            <span className="ml-2 font-mono text-sm text-pass">{runTime.meta}</span>
          </p>
        </div>

        <div className="relative overflow-hidden rounded-md bg-accent-soft p-5">
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center rounded-full bg-accent px-3 py-1 font-mono text-xs text-accent-ink">
              {confidence.meta}
            </span>
            <DuotonePanel seed={1} className="h-12 w-12 shrink-0 rounded-md" />
          </div>
          <p className="mt-6 font-serif text-4xl text-ink">
            {confidence.value}
            <span className="text-lg text-ink-soft">{confidence.metaTop}</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">Release confidence</p>
        </div>
      </div>

      <div className="mt-10">
        <p className="font-mono text-xs tracking-wide text-muted uppercase">
          Test executions trend
        </p>
        <TrendBarChart data={previewExecutionsTrend} height={200} />
      </div>
    </Card>
  )
}
