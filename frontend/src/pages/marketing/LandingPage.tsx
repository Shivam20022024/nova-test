import { BuiltFor } from './sections/BuiltFor'
import { CaseStudy } from './sections/CaseStudy'
import { ClosingCta } from './sections/ClosingCta'
import { FeatureList } from './sections/FeatureList'
import { Footer } from './sections/Footer'
import { Hero } from './sections/Hero'
import { Testimonial } from './sections/Testimonial'

export default function LandingPage() {
  return (
    <>
      <Hero />
      <FeatureList />
      <BuiltFor />
      <CaseStudy />
      <Testimonial />
      <ClosingCta />
      <Footer />
    </>
  )
}
