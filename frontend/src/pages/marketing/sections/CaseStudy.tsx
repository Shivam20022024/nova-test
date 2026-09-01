import { useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { DuotonePanel } from '../../../components/ui/DuotonePanel'
import { Modal } from '../../../components/ui/Modal'
import { ScrollReveal } from '../../../components/ui/ScrollReveal'

export function CaseStudy() {
  const [open, setOpen] = useState(false)

  return (
    <section className="mx-auto max-w-6xl px-6 py-24 md:px-10">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <ScrollReveal>
          <div>
            <p className="font-mono text-xs tracking-wide text-muted uppercase">Case study</p>
            <h2 className="mt-4 font-serif text-3xl leading-tight text-ink md:text-4xl">
              Why Customers choose NovaTest AI
            </h2>
            <p className="mt-5 text-lg text-ink-soft">
              With fragmented test suites and slow manual QA, Novalantis turned to NovaTest AI to
              automate their regression workflow. The result? Faster releases, fewer flaky tests,
              and 34% more coverage.
            </p>
            <div className="mt-8">
              <Button variant="outline" onClick={() => setOpen(true)}>
                Read case study
              </Button>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={120} distance={64} className="lg:order-last">
          <DuotonePanel seed={3} className="aspect-4/3 w-full rounded-card" />
        </ScrollReveal>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Why Customers choose NovaTest AI"
      >
        <p className="text-ink-soft">
          With fragmented test suites and slow manual QA, Novalantis turned to NovaTest AI to
          automate their regression workflow.
        </p>
        <div className="mt-6 grid grid-cols-3 gap-4">
          <div>
            <p className="font-serif text-2xl text-ink">Faster</p>
            <p className="mt-1 text-sm text-ink-soft">Release cycles</p>
          </div>
          <div>
            <p className="font-serif text-2xl text-ink">Fewer</p>
            <p className="mt-1 text-sm text-ink-soft">Flaky tests</p>
          </div>
          <div>
            <p className="font-serif text-2xl text-ink">+34%</p>
            <p className="mt-1 text-sm text-ink-soft">Test coverage</p>
          </div>
        </div>
      </Modal>
    </section>
  )
}
