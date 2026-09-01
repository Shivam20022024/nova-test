import { Button } from '../../../components/ui/Button'
import { ProductPreviewCard } from './ProductPreviewCard'

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[560px] md:h-[680px]"
        style={{
          background:
            'linear-gradient(180deg, var(--color-accent-soft) 0%, color-mix(in srgb, var(--color-accent-soft) 45%, var(--color-paper)) 60%, var(--color-paper) 100%)',
        }}
      />

      <div className="relative mx-auto max-w-4xl px-6 pt-16 pb-28 text-center md:pt-24 md:pb-40">
        <h1 className="font-serif text-5xl leading-[1.05] tracking-tight text-ink sm:text-6xl md:text-7xl">
          Autonomous QA, built
          <br />
          for engineering teams.
        </h1>
        <p className="mx-auto mt-8 max-w-2xl font-serif text-lg text-ink-soft md:text-xl">
          Understand your app, generate tests, execute at scale, and heal failures
          automatically — with evidence behind every release decision.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Button href="https://novalantis.com/contact-us/">Request a demo</Button>
          <Button href="/login" variant="outline">
            Explore the platform
          </Button>
        </div>
      </div>

      <div className="relative mx-auto -mt-20 max-w-5xl px-4 pb-24 sm:px-6 md:-mt-28">
        <ProductPreviewCard />
      </div>
    </section>
  )
}
