import { Button } from '../../../components/ui/Button'
import { ScrollReveal } from '../../../components/ui/ScrollReveal'

export function ClosingCta() {
  return (
    <section className="relative overflow-hidden bg-paper py-28">
      <div
        aria-hidden
        className="absolute top-0 left-1/2 h-72 w-[140%] -translate-x-1/2 rounded-full opacity-70 blur-3xl"
        style={{ background: 'var(--color-accent-soft)' }}
      />
      <ScrollReveal className="relative mx-auto max-w-2xl px-6 text-center">
        <h2 className="font-serif text-3xl text-ink md:text-4xl">
          Ready to ship with evidence behind every release?
        </h2>
        <div className="mt-8 flex justify-center">
          <Button href="https://novalantis.com/contact-us/">Request a demo</Button>
        </div>
      </ScrollReveal>
    </section>
  )
}
