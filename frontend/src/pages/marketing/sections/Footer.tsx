import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Mail, MapPin, Phone } from 'lucide-react'
import { Modal } from '../../../components/ui/Modal'

const internalRoutes: Record<string, string> = {
  'Command Center': '/app/command-center',
  AutoHeal: '/app/healing',
  EvidenceGraph: '/app/evidence',
}

const externalLinks: Record<string, string> = {
  LinkedIn: 'https://www.linkedin.com/company/novalantis/',
  X: 'https://x.com/infoNovalantis',
  Facebook: 'https://www.facebook.com/share/1AXeCM9p8d/',
}

const columns = [
  { heading: 'Product', links: ['Command Center', 'AutoHeal', 'EvidenceGraph'] },
  { heading: 'Journal', links: ['Insights', 'Strategy'] },
  { heading: 'Company', links: ['About', 'Careers'] },
  { heading: 'Legal', links: ['Privacy', 'Terms'] },
  { heading: 'Social', links: ['LinkedIn', 'X', 'Facebook'] },
]

const phoneNumbers = ['78368 57658', '91424 18268']
const email = 'info@novalantis.com'
const addressLine = 'Sector 27, Greater Noida, Uttar Pradesh, 201310, India'
const mapsUrl = 'https://www.google.com/maps?q=Sector+27,+Greater+Noida,+Uttar+Pradesh,+201310,+India'

export function Footer() {
  const [comingSoon, setComingSoon] = useState<string | null>(null)

  return (
    <footer
      className="bg-grain overflow-hidden text-accent-ink"
      style={{
        background:
          'linear-gradient(180deg, var(--color-accent) 0%, var(--color-accent-deep) 55%, var(--color-ink) 100%)',
      }}
    >
      <div className="mx-auto max-w-6xl px-6 pt-20 md:px-10">
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 border-b border-accent-ink/15 pb-16 sm:grid-cols-3 lg:grid-cols-6">
          {columns.map((col) => (
            <div key={col.heading}>
              <p className="font-mono text-xs tracking-wide text-accent-ink uppercase">
                {col.heading}
              </p>
              <ul className="mt-4 flex flex-col gap-3">
                {col.links.map((link) => {
                  const internalTo = internalRoutes[link]
                  const externalHref = externalLinks[link]
                  return (
                    <li key={link}>
                      {internalTo ? (
                        <Link
                          to={internalTo}
                          className="text-sm text-accent-ink underline-offset-4 hover:underline"
                        >
                          {link}
                        </Link>
                      ) : externalHref ? (
                        <a
                          href={externalHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-accent-ink underline-offset-4 hover:underline"
                        >
                          {link}
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setComingSoon(link)}
                          className="text-left text-sm text-accent-ink underline-offset-4 hover:underline"
                        >
                          {link}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}

          <div className="col-span-2 sm:col-span-1">
            <p className="font-mono text-xs tracking-wide text-accent-ink uppercase">Contact</p>
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex gap-2.5">
                <Phone aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-accent-ink/70" />
                <div className="flex flex-col gap-1">
                  {phoneNumbers.map((number) => (
                    <a
                      key={number}
                      href={`tel:${number.replace(/\s/g, '')}`}
                      className="font-mono text-sm text-accent-ink hover:underline"
                    >
                      {number}
                    </a>
                  ))}
                </div>
              </div>

              <a href={`mailto:${email}`} className="flex items-center gap-2.5 text-sm text-accent-ink hover:underline">
                <Mail aria-hidden="true" size={15} className="shrink-0 text-accent-ink/70" />
                {email}
              </a>

              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex gap-2.5"
              >
                <MapPin aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-accent-ink/70" />
                <span>
                  <span className="flex items-center gap-1 text-sm font-medium text-accent-ink group-hover:underline">
                    Greater Noida
                    <ArrowUpRight aria-hidden="true" size={13} />
                  </span>
                  <span className="mt-0.5 block text-sm text-accent-ink/70">{addressLine}</span>
                </span>
              </a>
            </div>
          </div>
        </div>
      </div>
      <p className="px-4 pt-6 pb-8 text-center font-sans text-[clamp(2rem,7vw,5.5rem)] leading-none font-bold tracking-tight text-accent-ink/95 select-none">
        NovaTest AI
      </p>

      <Modal open={comingSoon !== null} onClose={() => setComingSoon(null)} title={comingSoon ?? ''}>
        <p className="text-ink-soft">This page isn't part of the UI preview yet — check back soon.</p>
      </Modal>
    </footer>
  )
}
