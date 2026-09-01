import { DuotonePanel } from '../../../components/ui/DuotonePanel'
import { ScrollReveal } from '../../../components/ui/ScrollReveal'

export function Testimonial() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0">
        <DuotonePanel seed={4} className="h-full w-full" />
      </div>
      <ScrollReveal className="relative mx-auto max-w-4xl px-6 py-28 text-center text-paper md:py-36">
        <p className="font-serif text-3xl leading-snug md:text-4xl">
          "We finally moved past flaky scripts and manual triage. Now we have real evidence to
          guide every release."
        </p>
      </ScrollReveal>
    </section>
  )
}
