import { FileCheck2, TrendingUp, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ScrollReveal } from '../../../components/ui/ScrollReveal'
import { builtForCards } from '../../../content/builtForCards'
import type { BuiltForCard } from '../../../content/builtForCards'

const icons: Record<BuiltForCard['icon'], LucideIcon> = {
  evidence: FileCheck2,
  systems: Workflow,
  progress: TrendingUp,
}

export function BuiltFor() {
  return (
    <section className="bg-grain bg-sand">
      <div className="mx-auto max-w-6xl px-6 py-24 md:px-10">
        <ScrollReveal>
          <h2 className="text-center font-serif text-4xl leading-tight text-ink md:text-5xl">
            Built for confidence
            <br />
            <span className="font-medium">Designed for speed</span>
          </h2>
        </ScrollReveal>

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {builtForCards.map((card, index) => {
            const Icon = icons[card.icon]
            return (
              <ScrollReveal key={card.title} delay={index * 100}>
                <div className="rounded-card bg-paper-alt p-8 shadow-float">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
                    <Icon size={20} className="text-accent-deep" strokeWidth={1.75} />
                  </div>
                  <h3 className="mt-6 font-sans text-lg font-semibold text-ink">{card.title}</h3>
                  <p className="mt-3 text-ink-soft">{card.description}</p>
                </div>
              </ScrollReveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}
