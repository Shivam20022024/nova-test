import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import novalantisLogoUrl from '../../assets/novalantis-logo.jpg'
import { PDF_COLORS, PDF_MARGIN, pdfDecisionPalette } from './pdfDesignSystem'
import { buildMobileExecutiveSummary, mobileQualityScorecard } from './mobileReportData'
import type {
  MobileApplication,
  MobileDevice,
  MobileEvidenceItem,
  MobileExecution,
  MobileHealingRecord,
  MobileTest,
} from '../../lib/types'

export type MobileReportData = {
  execution: MobileExecution
  test: MobileTest | null
  application?: MobileApplication | null
  device?: MobileDevice | null
  evidence: MobileEvidenceItem[]
  healing: MobileHealingRecord[]
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * Raw JSON dump of everything the report page shows - the mobile equivalent
 * of Web Testing's `generateReportJson` in reportExport.js, minus the
 * normalization step (there's no AI-generated report object to normalize;
 * this is the engine's own recorded data as-is).
 */
export function downloadMobileReportJson(data: MobileReportData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  triggerBrowserDownload(blob, `NovaTest_Mobile_Execution_${data.execution.id}.json`)
}

let cachedLogoDataUrl: string | null = null
async function getNovalantisLogoDataUrl(): Promise<string | null> {
  if (cachedLogoDataUrl) return cachedLogoDataUrl
  try {
    const res = await fetch(novalantisLogoUrl)
    const blob = await res.blob()
    cachedLogoDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    return cachedLogoDataUrl
  } catch (err) {
    console.warn('Failed to load Novalantis logo for PDF export:', err)
    return null
  }
}

/** Same never-throw contract as web's fetchImageDataUrl: evidence lives on
 *  Supabase Storage, which can be briefly unreachable or CORS-blocked - a
 *  missing screenshot must degrade to "not embedded", never break the PDF. */
async function fetchImageDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

type RGB = readonly [number, number, number]

/**
 * A thin, stateful drawing layer over jsPDF - the same primitives web's PDF
 * builds by hand in reportExport.js (numbered section titles, KPI card grid,
 * page-break-aware cursor, vector status dot instead of a Unicode glyph
 * jsPDF's built-in font can't render), packaged as a small class so the
 * mutable cursor position (`this.y`) doesn't need to live as a bare closure
 * variable. Local to this file rather than shared with reportExport.js: that
 * file's version is proven in production and not worth the regression risk
 * of a wholesale refactor for what is, underneath, the same handful of
 * primitives drawn with the same shared PDF_COLORS.
 */
class PdfLayout {
  doc: jsPDF
  pageWidth: number
  pageHeight: number
  margin: number
  contentWidth: number
  y: number
  sectionCounter = 0

  constructor(doc: jsPDF) {
    this.doc = doc
    this.pageWidth = doc.internal.pageSize.width
    this.pageHeight = doc.internal.pageSize.height
    this.margin = PDF_MARGIN
    this.contentWidth = this.pageWidth - this.margin * 2
    this.y = this.margin
  }

  private setColor(fn: (r: number, g: number, b: number) => jsPDF, rgb: RGB) {
    fn.call(this.doc, rgb[0], rgb[1], rgb[2])
  }

  ensureSpace(needed: number) {
    if (this.y + needed > this.pageHeight - 22) {
      this.doc.addPage()
      this.y = this.margin + 4
    }
  }

  statusDot(x: number, y: number, color: RGB, r = 1.3) {
    this.setColor(this.doc.setFillColor.bind(this.doc), color)
    this.doc.circle(x, y, r, 'F')
  }

  sectionTitle(title: string) {
    this.sectionCounter += 1
    this.ensureSpace(16)
    this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.brandIndigo)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(9)
    this.doc.text(String(this.sectionCounter).padStart(2, '0'), this.margin, this.y)

    this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.ink)
    this.doc.setFontSize(13)
    this.doc.text(title, this.margin + 9, this.y)

    this.y += 3.5
    this.setColor(this.doc.setDrawColor.bind(this.doc), PDF_COLORS.hairline)
    this.doc.setLineWidth(0.4)
    this.doc.line(this.margin, this.y, this.margin + this.contentWidth, this.y)
    this.y += 7
  }

  bodyText(text: string, opts: { size?: number; color?: RGB; bold?: boolean; lineHeight?: number } = {}) {
    const { size = 9, color = PDF_COLORS.inkSoft, bold = false, lineHeight = 4.2 } = opts
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal')
    this.doc.setFontSize(size)
    this.setColor(this.doc.setTextColor.bind(this.doc), color)
    const lines = this.doc.splitTextToSize(text, this.contentWidth) as string[]
    this.ensureSpace(lines.length * lineHeight + 2)
    this.doc.text(lines, this.margin, this.y)
    this.y += lines.length * lineHeight
  }

  kpiCardGrid(items: Array<{ label: string; value: string | number; color?: RGB; sub?: string }>) {
    const gap = 5
    const cardW = (this.contentWidth - gap * 3) / 4
    const cardH = 24
    this.ensureSpace(cardH + 4)
    items.forEach((item, idx) => {
      const col = idx % 4
      if (col === 0 && idx > 0) this.y += cardH + gap
      const x = this.margin + col * (cardW + gap)
      this.setColor(this.doc.setFillColor.bind(this.doc), PDF_COLORS.panelBg)
      this.setColor(this.doc.setDrawColor.bind(this.doc), PDF_COLORS.hairline)
      this.doc.setLineWidth(0.3)
      this.doc.roundedRect(x, this.y, cardW, cardH, 2, 2, 'FD')

      this.doc.setFont('helvetica', 'bold')
      this.doc.setFontSize(6.5)
      this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.inkMuted)
      this.doc.text(item.label.toUpperCase(), x + 4, this.y + 6)

      this.doc.setFont('helvetica', 'bold')
      this.doc.setFontSize(15)
      this.setColor(this.doc.setTextColor.bind(this.doc), item.color ?? PDF_COLORS.ink)
      this.doc.text(String(item.value), x + 4, this.y + 16)

      if (item.sub) {
        this.doc.setFont('helvetica', 'normal')
        this.doc.setFontSize(6.5)
        this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.inkMuted)
        this.doc.text(item.sub, x + 4, this.y + 21)
      }
    })
    this.y += cardH + 8
  }
}

/**
 * Branded, multi-section PDF structurally parallel to Web Testing's
 * generateReportPdf (reportExport.js): cover page with logo + release
 * decision hero + KPI strip + table of contents, then a running header/
 * footer, section-numbered body, and embedded evidence images rather than
 * bare links. No AI narrative section (mobile has none to render) - the
 * executive summary is the same deterministic text the on-screen report
 * shows, built by mobileReportData.ts so the two never drift apart.
 */
export async function downloadMobileReportPdf(data: MobileReportData): Promise<void> {
  const { execution, test, application, device, evidence, healing } = data
  const steps = execution.step_results ?? []
  const screenshots = evidence.filter((e) => e.artifact_type === 'SCREENSHOT').slice(0, 6)
  const scorecard = mobileQualityScorecard({ steps, healing, evidence })
  const summaryText = buildMobileExecutiveSummary({ execution, test, application, device, steps, healing })

  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const layout = new PdfLayout(doc)
  const c = PDF_COLORS
  const margin = layout.margin
  const contentWidth = layout.contentWidth

  const setColor = (fn: (r: number, g: number, b: number) => jsPDF, rgb: RGB) => fn.call(doc, rgb[0], rgb[1], rgb[2])

  const testName = test?.name ?? `Mobile execution #${execution.id}`
  const isPassed = execution.status === 'PASSED'
  const palette = pdfDecisionPalette(isPassed ? 'PASSED' : 'FAILED')
  const hasHealing = healing.length > 0
  const hasScreenshots = screenshots.length > 0

  const tocEntries = [
    'Executive Summary',
    'Release Decision',
    'Quality Scorecard',
    'Device & Application Details',
    'Step-by-Step Execution',
    hasHealing && 'Self-Healing Results',
    hasScreenshots && 'Evidence',
    'Technical Appendix',
  ].filter(Boolean) as string[]

  /* ══════════ COVER PAGE ══════════ */
  const logoDataUrl = await getNovalantisLogoDataUrl()

  setColor(doc.setFillColor.bind(doc), c.ink)
  doc.rect(0, 0, layout.pageWidth, 64, 'F')

  const logoW = 34
  const logoH = 12.3
  if (logoDataUrl) {
    setColor(doc.setFillColor.bind(doc), c.white)
    doc.roundedRect(margin, 15, logoW + 3, logoH + 3, 2, 2, 'F')
    doc.addImage(logoDataUrl, 'JPEG', margin + 1.5, 16.5, logoW, logoH)
  } else {
    setColor(doc.setFillColor.bind(doc), c.brandIndigo)
    doc.roundedRect(margin, 16, 10, 10, 2, 2, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    setColor(doc.setTextColor.bind(doc), c.white)
    doc.text('N', margin + 3.2, 23.2)
  }

  const brandTextX = margin + logoW + 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  setColor(doc.setTextColor.bind(doc), c.white)
  doc.text('NovaTest AI', brandTextX, 21.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  doc.text('ENTERPRISE QA PLATFORM', brandTextX, 26)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(24)
  setColor(doc.setTextColor.bind(doc), c.white)
  doc.text('Mobile Test Intelligence Report', margin, 46)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  const generatedAt = new Date().toLocaleString()
  doc.text(`Execution #${execution.id} - Generated ${generatedAt}`, margin, 54)

  layout.y = 76

  // Identity card
  const identityTop = layout.y
  let identityCursor = identityTop + 9
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  const titleLines = doc.splitTextToSize(testName, contentWidth - 10).slice(0, 1)
  doc.setFontSize(8.5)
  const appDeviceLine = `${application?.package_name ?? 'Unknown app'} - ${device?.model ?? device?.serial ?? 'Unknown device'}${device?.android_version ? ` (Android ${device.android_version})` : ''}`
  const identityH = 15 + 7

  setColor(doc.setFillColor.bind(doc), c.panelBg)
  setColor(doc.setDrawColor.bind(doc), c.hairline)
  doc.roundedRect(margin, identityTop, contentWidth, identityH, 2, 2, 'FD')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  setColor(doc.setTextColor.bind(doc), c.ink)
  doc.text(titleLines, margin + 5, identityCursor)
  identityCursor += 6

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  setColor(doc.setTextColor.bind(doc), c.inkSoft)
  doc.text(appDeviceLine, margin + 5, identityCursor)

  layout.y = identityTop + identityH + 8

  // Decision hero
  const decisionTitle = isPassed ? 'AI RELEASE DECISION: PASSED' : 'AI RELEASE DECISION: FAILED - INVESTIGATE'
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  const decisionTitleLines = doc.splitTextToSize(decisionTitle, contentWidth - 18)
  doc.setFontSize(8)
  const heroDetail = `Step Pass Rate: ${scorecard.stepPassRate}% - Evidence Coverage: ${scorecard.evidenceCoverage}% - Self-Healed: ${healing.length}`
  const heroDetailLines = doc.splitTextToSize(heroDetail, contentWidth - 12)
  const heroH = 10 + decisionTitleLines.length * 6 + 6 + heroDetailLines.length * 4 + 4

  const heroTop = layout.y
  setColor(doc.setFillColor.bind(doc), palette.bg)
  setColor(doc.setDrawColor.bind(doc), palette.border)
  doc.setLineWidth(0.6)
  doc.roundedRect(margin, heroTop, contentWidth, heroH, 2, 2, 'FD')

  layout.statusDot(margin + 8, heroTop + 10, palette.accent, 2.2)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  setColor(doc.setTextColor.bind(doc), palette.text)
  doc.text(decisionTitleLines, margin + 14, heroTop + 10)
  let heroCursor = heroTop + 10 + decisionTitleLines.length * 6 + 2

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  setColor(doc.setTextColor.bind(doc), c.inkSoft)
  doc.text(heroDetailLines, margin + 6, heroCursor)

  layout.y = heroTop + heroH + 8

  // KPI strip
  layout.kpiCardGrid([
    { label: 'Steps', value: steps.length, color: c.ink },
    { label: 'Passed', value: steps.filter((s) => s.status === 'PASSED' || s.status === 'HEALED').length, color: c.emerald },
    { label: 'Failed', value: steps.filter((s) => s.status === 'FAILED' || s.status === 'BLOCKED').length, color: c.rose },
    { label: 'Duration', value: execution.duration_ms != null ? `${(execution.duration_ms / 1000).toFixed(1)}s` : '-', color: c.ink },
  ])

  // Run details + TOC columns
  setColor(doc.setDrawColor.bind(doc), c.hairline)
  doc.setLineWidth(0.3)
  doc.line(margin, layout.y, margin + contentWidth, layout.y)
  layout.y += 7

  const colGap = 10
  const colW = (contentWidth - colGap) / 2
  const columnsTop = layout.y

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  doc.text('RUN DETAILS', margin, columnsTop)

  const runDetailRows: Array<[string, string]> = [
    ['Application', application?.package_name ?? 'Unknown'],
    ['Device', device?.model ?? device?.serial ?? 'Unknown'],
    ['Started At', execution.started_at ? new Date(execution.started_at).toLocaleString() : '-'],
    ['Self-Healed Locators', String(healing.length)],
    ['Environment', execution.environment ?? 'DEV'],
  ]
  const maxRows = Math.max(runDetailRows.length, tocEntries.length)
  const availableRowsH = layout.pageHeight - 24 - (columnsTop + 6)
  const rowStep = Math.max(4, Math.min(5.5, availableRowsH / maxRows))

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  runDetailRows.forEach(([label, value], idx) => {
    const rowY = columnsTop + 6 + idx * rowStep
    setColor(doc.setTextColor.bind(doc), c.inkMuted)
    doc.text(label, margin, rowY)
    setColor(doc.setTextColor.bind(doc), c.ink)
    doc.setFont('helvetica', 'bold')
    const valueLines = doc.splitTextToSize(String(value), colW - 40)
    doc.text(valueLines[0], margin + 40, rowY)
    doc.setFont('helvetica', 'normal')
  })

  const tocX = margin + colW + colGap
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  doc.text('IN THIS REPORT', tocX, columnsTop)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  tocEntries.forEach((entry, idx) => {
    const rowY = columnsTop + 6 + idx * rowStep
    setColor(doc.setTextColor.bind(doc), c.brandIndigo)
    doc.setFont('helvetica', 'bold')
    doc.text(String(idx + 1).padStart(2, '0'), tocX, rowY)
    setColor(doc.setTextColor.bind(doc), c.ink)
    doc.setFont('helvetica', 'normal')
    doc.text(entry, tocX + 8, rowY)
  })

  /* ══════════ BODY PAGES ══════════ */
  doc.addPage()
  layout.y = margin + 4

  layout.sectionTitle('Executive Summary')
  layout.bodyText(summaryText, { size: 9.5 })

  layout.sectionTitle('Release Decision')
  layout.bodyText(
    isPassed
      ? 'This execution passed all recorded steps. No blocking issues were identified.'
      : `This execution did not complete successfully (status: ${execution.status}). Review the failed step and any self-healing attempts below before promoting this build.`,
    { bold: true, color: palette.text, size: 10 },
  )

  layout.sectionTitle('Quality Scorecard')
  layout.kpiCardGrid([
    { label: 'Step Pass Rate', value: `${scorecard.stepPassRate}%`, color: c.brandIndigo },
    { label: 'Healing Recovery', value: scorecard.healingRecoveryRate != null ? `${scorecard.healingRecoveryRate}%` : 'N/A', color: c.brandCyan },
    { label: 'Evidence Coverage', value: `${scorecard.evidenceCoverage}%`, color: c.emerald },
  ])

  layout.sectionTitle('Device & Application Details')
  autoTable(doc, {
    startY: layout.y,
    margin: { left: margin, right: margin },
    head: [['Field', 'Value']],
    body: [
      ['Application', application?.package_name ?? '-'],
      ['Version', application?.versions?.[0]?.version_name ?? '-'],
      ['SDK range', `${application?.versions?.[0]?.min_sdk ?? '?'}-${application?.versions?.[0]?.target_sdk ?? '?'}`],
      ['Device', device?.model ?? device?.serial ?? '-'],
      ['Android version', `${device?.android_version ?? '-'} (API ${device?.api_level ?? '?'})`],
      ['Environment', `${execution.environment ?? 'DEV'}${device?.is_emulator ? ' - emulator' : ''}`],
    ],
    styles: { fontSize: 8.5, textColor: [...c.inkSoft] },
    headStyles: { fillColor: [...c.panelBg], textColor: [...c.ink], fontStyle: 'bold' },
  })
  layout.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10

  layout.sectionTitle('Step-by-Step Execution')
  autoTable(doc, {
    startY: layout.y,
    margin: { left: margin, right: margin },
    head: [['#', 'Action', 'Locator', 'Status', 'Duration']],
    body: steps.map((step) => [
      String(step.step_index),
      step.action,
      step.resolved_locator?.value ?? step.locator?.value ?? '-',
      step.status,
      step.duration_ms != null ? `${step.duration_ms}ms` : '-',
    ]),
    styles: { fontSize: 8, textColor: [...c.inkSoft], valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: [...c.panelBg], textColor: [...c.ink], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 26 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 20 },
      4: { cellWidth: 20 },
    },
    didParseCell: (cellData) => {
      if (cellData.column.index === 3 && cellData.section === 'body') {
        const status = String(cellData.cell.raw)
        if (status === 'PASSED' || status === 'HEALED') cellData.cell.styles.textColor = [...c.emeraldDark]
        else if (status === 'FAILED' || status === 'BLOCKED') cellData.cell.styles.textColor = [...c.roseDark]
      }
    },
  })
  layout.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10

  if (hasHealing) {
    layout.sectionTitle('Self-Healing Results')
    autoTable(doc, {
      startY: layout.y,
      margin: { left: margin, right: margin },
      head: [['Step', 'Original locator', 'Replacement', 'Confidence', 'Status']],
      body: healing.map((h) => [
        String(h.step_index),
        h.original_locator?.value ?? '-',
        h.replacement_locator?.value ?? h.candidate_locators?.[0]?.locator?.value ?? '-',
        h.confidence != null ? `${Math.round(h.confidence)}%` : '-',
        h.status,
      ]),
      styles: { fontSize: 8, textColor: [...c.inkSoft], valign: 'top', overflow: 'linebreak' },
      headStyles: { fillColor: [...c.panelBg], textColor: [...c.ink], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 'auto' },
        3: { cellWidth: 22 },
        4: { cellWidth: 22 },
      },
    })
    layout.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
  }

  if (hasScreenshots) {
    layout.sectionTitle('Evidence')
    const thumbW = (contentWidth - 5 * 2) / 3
    const thumbH = thumbW * (16 / 9)
    const dataUrls = await Promise.all(screenshots.map((s) => fetchImageDataUrl(s.url)))
    layout.ensureSpace(thumbH + 10)
    dataUrls.forEach((dataUrl, idx) => {
      const col = idx % 3
      if (col === 0 && idx > 0) layout.y += thumbH + 8
      const x = margin + col * (thumbW + 5)
      if (dataUrl) {
        try {
          doc.addImage(dataUrl, 'PNG', x, layout.y, thumbW, thumbH)
        } catch {
          // Corrupt/unsupported image data - leave the slot blank rather than fail the export.
        }
      }
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(6.5)
      setColor(doc.setTextColor.bind(doc), c.inkMuted)
      doc.text(`step ${screenshots[idx]?.step_index ?? '-'}`, x, layout.y + thumbH + 3)
    })
    layout.y += thumbH + 10
  }

  layout.sectionTitle('Technical Appendix')
  autoTable(doc, {
    startY: layout.y,
    margin: { left: margin, right: margin },
    head: [['Field', 'Value']],
    body: [
      ['Execution ID', String(execution.id)],
      ['Execution UID', execution.execution_uid ?? '-'],
      ['Raw status', execution.status],
      ['Started', execution.started_at ?? '-'],
      ['Completed', execution.completed_at ?? '-'],
      ['Recorded steps', String(steps.length)],
    ],
    styles: { fontSize: 8.5, textColor: [...c.inkSoft] },
    headStyles: { fillColor: [...c.panelBg], textColor: [...c.ink], fontStyle: 'bold' },
  })

  /* ══════════ RUNNING HEADER/FOOTER (skip cover page) ══════════ */
  const pageCount = doc.getNumberOfPages()
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i)
    setColor(doc.setDrawColor.bind(doc), c.hairline)
    doc.setLineWidth(0.3)
    doc.line(margin, 12, layout.pageWidth - margin, 12)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    setColor(doc.setTextColor.bind(doc), c.inkMuted)
    doc.text('NOVATEST AI - MOBILE TEST INTELLIGENCE REPORT', margin, 9)
    doc.text(`Page ${i - 1} of ${pageCount - 1}`, layout.pageWidth - margin, 9, { align: 'right' })
  }

  doc.save(`NovaTest_Mobile_Execution_${execution.id}.pdf`)
}
