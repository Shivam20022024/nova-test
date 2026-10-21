import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import novalantisLogoUrl from '../../assets/novalantis-logo.jpg'
import { PDF_COLORS, PDF_MARGIN, pdfDecisionPalette } from './pdfDesignSystem'
import type { ApiExecutionDetail } from '../../lib/types'
import { apiDbQualityScorecard, buildApiExecutiveSummary } from './apiDbReportData'

/**
 * Single API-test execution report — structurally a smaller sibling of
 * mobileReportExport.ts (own PdfLayout, same PDF_COLORS/PDF_MARGIN, cover
 * page + KPI strip + step table + appendix), raw detail object in, PDF/JSON
 * out, no normalizer. ApiExecutionDetail is already self-contained (unlike
 * mobile's cross-table application/device/evidence/healing joins), so there
 * is no fan-out fetch to assemble here.
 */

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

export function downloadApiReportJson(execution: ApiExecutionDetail): void {
  const blob = new Blob([JSON.stringify(execution, null, 2)], { type: 'application/json;charset=utf-8' })
  triggerBrowserDownload(blob, `NovaTest_API_Execution_${execution.id}.json`)
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
  } catch {
    return null
  }
}

type RGB = readonly [number, number, number]

class PdfLayout {
  doc: jsPDF
  pageWidth: number
  pageHeight: number
  margin: number
  contentWidth: number
  y: number

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

  statusDot(x: number, y: number, color: RGB, r = 1.3) {
    this.setColor(this.doc.setFillColor.bind(this.doc), color)
    this.doc.circle(x, y, r, 'F')
  }

  sectionTitle(title: string, counter: number) {
    this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.brandIndigo)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(9)
    this.doc.text(String(counter).padStart(2, '0'), this.margin, this.y)
    this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.ink)
    this.doc.setFontSize(13)
    this.doc.text(title, this.margin + 9, this.y)
    this.y += 3.5
    this.setColor(this.doc.setDrawColor.bind(this.doc), PDF_COLORS.hairline)
    this.doc.setLineWidth(0.4)
    this.doc.line(this.margin, this.y, this.margin + this.contentWidth, this.y)
    this.y += 7
  }

  kpiCardGrid(items: Array<{ label: string; value: string | number; color?: RGB }>) {
    const gap = 5
    const cardW = (this.contentWidth - gap * (items.length - 1)) / items.length
    const cardH = 22
    items.forEach((item, idx) => {
      const x = this.margin + idx * (cardW + gap)
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
    })
    this.y += cardH + 8
  }
}

function tableHeadStyles() {
  return { fillColor: [...PDF_COLORS.panelBg] as [number, number, number], textColor: [...PDF_COLORS.ink] as [number, number, number], fontStyle: 'bold' as const }
}

export async function downloadApiReportPdf(execution: ApiExecutionDetail): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const layout = new PdfLayout(doc)
  const c = PDF_COLORS
  const margin = layout.margin
  const contentWidth = layout.contentWidth
  const setColor = (fn: (r: number, g: number, b: number) => jsPDF, rgb: RGB) => fn.call(doc, rgb[0], rgb[1], rgb[2])
  const logoDataUrl = await getNovalantisLogoDataUrl()

  const isPassed = execution.status === 'PASSED'
  const palette = pdfDecisionPalette(isPassed ? 'PASSED' : 'FAILED')
  const steps = execution.stepLogs ?? []
  const passedSteps = steps.filter((s) => s.status === 'PASSED').length
  const failedSteps = steps.filter((s) => s.status === 'FAILED').length

  setColor(doc.setFillColor.bind(doc), c.ink)
  doc.rect(0, 0, layout.pageWidth, 64, 'F')

  const logoW = 34, logoH = 12.3
  if (logoDataUrl) {
    setColor(doc.setFillColor.bind(doc), c.white)
    doc.roundedRect(margin, 15, logoW + 3, logoH + 3, 2, 2, 'F')
    doc.addImage(logoDataUrl, 'JPEG', margin + 1.5, 16.5, logoW, logoH)
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
  doc.text('API Test Report', margin, 46)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  doc.text(`Execution #${execution.id} - Generated ${new Date().toLocaleString()}`, margin, 54)

  layout.y = 76
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  setColor(doc.setTextColor.bind(doc), c.ink)
  doc.text(execution.name, margin, layout.y)
  layout.y += 10

  const decisionTitle = isPassed ? 'RELEASE DECISION: PASSED' : 'RELEASE DECISION: FAILED - INVESTIGATE'
  const heroTop = layout.y
  const heroH = 18
  setColor(doc.setFillColor.bind(doc), palette.bg)
  setColor(doc.setDrawColor.bind(doc), palette.border)
  doc.setLineWidth(0.6)
  doc.roundedRect(margin, heroTop, contentWidth, heroH, 2, 2, 'FD')
  layout.statusDot(margin + 8, heroTop + 10, palette.accent, 2.2)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  setColor(doc.setTextColor.bind(doc), palette.text)
  doc.text(decisionTitle, margin + 14, heroTop + 11)
  layout.y = heroTop + heroH + 8

  layout.kpiCardGrid([
    { label: 'Steps', value: steps.length, color: c.ink },
    { label: 'Passed', value: passedSteps, color: c.emerald },
    { label: 'Failed', value: failedSteps, color: c.rose },
    { label: 'Duration', value: execution.durationMs != null ? `${(execution.durationMs / 1000).toFixed(1)}s` : '-', color: c.ink },
  ])

  const scorecard = apiDbQualityScorecard(steps)
  const summaryText = buildApiExecutiveSummary(execution)

  doc.addPage()
  layout.y = margin + 4
  let section = 1

  layout.sectionTitle('Executive Summary', section++)
  layout.bodyText(summaryText, { size: 9.5 })

  layout.sectionTitle('Quality Scorecard', section++)
  layout.kpiCardGrid([
    { label: 'Step Pass Rate', value: `${scorecard.stepPassRate}%`, color: c.brandIndigo },
    { label: 'Assertion Pass Rate', value: scorecard.assertionPassRate != null ? `${scorecard.assertionPassRate}%` : 'N/A', color: c.brandCyan },
  ])

  layout.sectionTitle('Request Definition', section++)
  autoTable(doc, {
    startY: layout.y,
    margin: { left: margin, right: margin },
    head: [['Method', 'URL', 'Assertions']],
    body: execution.steps.map((s) => [s.method, s.url, String(s.assertions?.length ?? 0)]),
    styles: { fontSize: 8, textColor: [...c.inkSoft], overflow: 'linebreak' },
    headStyles: tableHeadStyles(),
  })
  layout.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10

  layout.sectionTitle('Step-by-Step Execution', section++)
  if (steps.length > 0) {
    autoTable(doc, {
      startY: layout.y,
      margin: { left: margin, right: margin },
      head: [['Action', 'Status', 'Duration', 'Detail']],
      body: steps.map((s) => [s.action, s.status, s.durationMs != null ? `${s.durationMs}ms` : '-', (s.details || s.value || '').slice(0, 80)]),
      styles: { fontSize: 8, textColor: [...c.inkSoft], valign: 'top', overflow: 'linebreak' },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 1 && cellData.section === 'body') {
          const status = String(cellData.cell.raw)
          if (status === 'PASSED') cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (status === 'FAILED') cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
  } else {
    layout.doc.setFont('helvetica', 'normal')
    layout.doc.setFontSize(9)
    layout.doc.text('No steps recorded.', margin, layout.y)
    layout.y += 10
  }

  layout.sectionTitle('Technical Appendix', section++)
  autoTable(doc, {
    startY: layout.y,
    margin: { left: margin, right: margin },
    head: [['Field', 'Value']],
    body: [
      ['Execution ID', String(execution.id)],
      ['Raw status', execution.status],
      ['Started', execution.startedAt ?? '-'],
      ['Completed', execution.completedAt ?? '-'],
      ['Error', execution.error ?? '-'],
      ['Jira ticket', execution.jiraTicketId ?? '-'],
    ],
    styles: { fontSize: 8.5, textColor: [...c.inkSoft] },
    headStyles: tableHeadStyles(),
  })

  const pageCount = doc.getNumberOfPages()
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i)
    setColor(doc.setDrawColor.bind(doc), c.hairline)
    doc.setLineWidth(0.3)
    doc.line(margin, 12, layout.pageWidth - margin, 12)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    setColor(doc.setTextColor.bind(doc), c.inkMuted)
    doc.text('NOVATEST AI - API TEST REPORT', margin, 9)
    doc.text(`Page ${i - 1} of ${pageCount - 1}`, layout.pageWidth - margin, 9, { align: 'right' })
  }

  doc.save(`NovaTest_API_Execution_${execution.id}.pdf`)
}
