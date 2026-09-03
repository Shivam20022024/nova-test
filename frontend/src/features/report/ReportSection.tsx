import type { ReactNode } from 'react'

/**
 * Shared section chrome for both execution report pages — a serif title
 * under a top hairline, breaking cleanly across a printed/PDF-exported page.
 * Extracted from the web report so the mobile report reads as the same
 * document type, not a differently-styled one.
 */
export function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-8 print:break-inside-avoid">
      <h2 className="font-serif text-xl text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}
