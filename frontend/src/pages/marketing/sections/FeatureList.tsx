import { Button } from '../../../components/ui/Button'
import { DuotonePanel } from '../../../components/ui/DuotonePanel'
import { ScrollReveal } from '../../../components/ui/ScrollReveal'
import { featureList } from '../../../content/featureList'

export function FeatureList() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24 md:px-10">
      <ScrollReveal>
        <h2 className="mx-auto max-w-3xl text-center font-serif text-4xl leading-tight text-ink md:text-5xl">
          Everything you need to test, heal, and ship with confidence.
        </h2>
      </ScrollReveal>

      <div className="mt-16 grid gap-10 lg:grid-cols-2 lg:gap-16">
        <ScrollReveal distance={64}>
          <div className="relative overflow-hidden rounded-card">
            <DuotonePanel seed={2} className="aspect-4/5 w-full" />
            <div className="absolute right-6 bottom-6 left-6 rounded-md bg-paper-alt p-5 shadow-float sm:right-auto sm:w-64">
              <p className="font-mono text-xs tracking-wide text-muted uppercase">Avg run time</p>
              <p className="mt-3 font-serif text-3xl text-ink">
                4m 12s
                <span className="ml-2 font-mono text-sm text-pass">↓12.4%</span>
              </p>
            </div>
          </div>
        </ScrollReveal>

        <div className="flex flex-col">
          {featureList.map((item, index) => (
            <ScrollReveal key={item.number} delay={index * 90}>
              <div className="border-b border-line py-7 first:pt-0 last:border-b-0">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="font-serif text-2xl text-ink">{item.title}</h3>
                  <span className="font-mono text-sm text-muted">{item.number}</span>
                </div>
                <p className="mt-2 text-ink-soft">{item.description}</p>
              </div>
            </ScrollReveal>
          ))}

          <div className="pt-8">
            <Button href="/login" variant="outline">
              Explore features
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
