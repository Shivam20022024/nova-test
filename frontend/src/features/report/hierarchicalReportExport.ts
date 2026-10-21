import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import novalantisLogoUrl from '../../assets/novalantis-logo.jpg'
import { PDF_COLORS, PDF_MARGIN } from './pdfDesignSystem'
import { api } from '../../lib/api'
import type { SprintReport, ReportExecutionDetail } from '../../lib/types'

/**
 * Downloadable Project -> Release -> Sprint reports - the "click a project,
 * see everything under it" report, drillable down to just one release or
 * just one sprint. Structurally parallel to reportExport.js (web) and
 * mobileReportExport.ts (mobile): same PDF_COLORS, same cover-page +
 * numbered-section shape, same "fetch a screenshot URL, embed it, silently
 * skip if unreachable" evidence contract - but this file renders a TREE of
 * results rather than one execution, so it intentionally does NOT reuse
 * reportTransform.js's normalizeExecutionReport() (which also fetches a
 * separate AI-report JSON per execution - fine for one execution, too slow
 * once "one execution" can mean "every failure in a whole project").
 * Instead it renders directly from the lean ReportExecutionDetail shape the
 * new /report backend endpoints already return.
 *
 * Evidence policy (deliberate, keeps a project-wide report a sane size): a
 * PASSED test case is one summary row in a table. A FAILED one gets a full
 * detail block - step log, self-heal events, and up to 3 embedded
 * screenshots - exactly like today's single-execution report, just repeated
 * per failure instead of being the whole document.
 */

const EVIDENCE_CAP_PER_EXECUTION = 3

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

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  triggerBrowserDownload(blob, filename)
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

/** Same never-throw contract as the other two exporters: evidence lives on
 *  Supabase Storage, which can be briefly unreachable or CORS-blocked - a
 *  missing screenshot must degrade to "not embedded", never break the PDF. */
async function fetchImageDataUrl(url: string | null | undefined): Promise<string | null> {
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

/** A step log's shape isn't strictly typed on the backend (it's whatever the
 *  worker recorded) - extract the common fields defensively, the same way
 *  reportTransform.js does for the single-execution report. */
function stepFields(step: unknown): { action: string; target: string; status: string; detail: string } {
  const s = (step ?? {}) as Record<string, unknown>
  const action = String(s.action ?? 'STEP')
  const target = String(s.selector ?? s.target ?? s.rawSelector ?? s.url ?? '-')
  const status = String(s.status ?? '-')
  const detail = String(s.value ?? s.details ?? s.error ?? '')
  return { action, target, status, detail }
}

type RGB = readonly [number, number, number]

/** Same thin stateful drawing layer as mobileReportExport.ts's PdfLayout -
 *  kept as its own copy here rather than imported, matching this codebase's
 *  existing convention of not sharing the stateful cursor class across
 *  report files (each is proven independently; a shared refactor is a
 *  separate, deliberate change, not a side effect of adding a new report). */
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

  /** A level DOWN from sectionTitle - used for "this release" / "this
   *  sprint" inside a bigger report, without stealing the numbered-section
   *  counter from the document's own top-level structure. */
  subheading(title: string, indent = 0) {
    this.ensureSpace(10)
    this.setColor(this.doc.setTextColor.bind(this.doc), PDF_COLORS.ink)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(10.5)
    this.doc.text(title, this.margin + indent, this.y)
    this.y += 6
  }

  bodyText(text: string, opts: { size?: number; color?: RGB; bold?: boolean; lineHeight?: number; indent?: number } = {}) {
    const { size = 9, color = PDF_COLORS.inkSoft, bold = false, lineHeight = 4.2, indent = 0 } = opts
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal')
    this.doc.setFontSize(size)
    this.setColor(this.doc.setTextColor.bind(this.doc), color)
    const lines = this.doc.splitTextToSize(text, this.contentWidth - indent) as string[]
    this.ensureSpace(lines.length * lineHeight + 2)
    this.doc.text(lines, this.margin + indent, this.y)
    this.y += lines.length * lineHeight
  }

  kpiCardGrid(items: Array<{ label: string; value: string | number; color?: RGB }>) {
    const gap = 5
    const cardW = (this.contentWidth - gap * (items.length - 1)) / items.length
    const cardH = 22
    this.ensureSpace(cardH + 4)
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
      this.doc.setFontSize(14)
      this.setColor(this.doc.setTextColor.bind(this.doc), item.color ?? PDF_COLORS.ink)
      this.doc.text(String(item.value), x + 4, this.y + 16)
    })
    this.y += cardH + 8
  }

  finishAutoTableCursor() {
    this.y = (this.doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
  }
}

function tableHeadStyles() {
  return { fillColor: [...PDF_COLORS.panelBg] as [number, number, number], textColor: [...PDF_COLORS.ink] as [number, number, number], fontStyle: 'bold' as const }
}

/** One failed execution's full detail block - steps, self-heal events, and
 *  a capped set of embedded screenshots. Reused for every failing test case
 *  and ad-hoc run at every report level. */
async function renderFailureDetail(layout: PdfLayout, label: string, detail: ReportExecutionDetail) {
  const doc = layout.doc
  const c = PDF_COLORS
  layout.ensureSpace(14)
  layout.subheading(`✗ ${label}`, 4)
  layout.bodyText(
    `Execution #${detail.executionId} - ${detail.browser ?? 'unknown browser'} - ${detail.durationMs != null ? `${(detail.durationMs / 1000).toFixed(1)}s` : 'duration unknown'} - ${new Date(detail.createdAt).toLocaleString()}`,
    { size: 8, indent: 4 },
  )

  const steps = Array.isArray(detail.stepLogs) ? detail.stepLogs : []
  if (steps.length > 0) {
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin + 4, right: layout.margin },
      head: [['#', 'Action', 'Target', 'Status', 'Detail']],
      body: steps.map((s, i) => {
        const f = stepFields(s)
        return [String(i + 1), f.action, f.target.length > 40 ? `${f.target.slice(0, 40)}...` : f.target, f.status, f.detail.slice(0, 60)]
      }),
      styles: { fontSize: 7.5, textColor: [...c.inkSoft], valign: 'top', overflow: 'linebreak' },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 3 && cellData.section === 'body') {
          const status = String(cellData.cell.raw).toUpperCase()
          if (status.includes('PASS') || status.includes('HEAL')) cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (status.includes('FAIL') || status.includes('BLOCK')) cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.finishAutoTableCursor()
  }

  if (detail.healingEvents.length > 0) {
    layout.bodyText(`Self-healing: ${detail.healingEvents.length} locator(s) healed during this run.`, { size: 8, indent: 4, color: c.brandCyan, bold: true })
  }

  const screenshots = (detail.screenshots || []).slice(0, EVIDENCE_CAP_PER_EXECUTION)
  if (screenshots.length > 0) {
    const thumbW = (layout.contentWidth - 4 - 5 * (screenshots.length - 1)) / Math.max(screenshots.length, 1)
    const thumbH = thumbW * (9 / 16)
    layout.ensureSpace(thumbH + 6)
    const dataUrls = await Promise.all(screenshots.map((s) => fetchImageDataUrl(s.url)))
    dataUrls.forEach((dataUrl, idx) => {
      const x = layout.margin + 4 + idx * (thumbW + 5)
      if (dataUrl) {
        try {
          doc.addImage(dataUrl, 'PNG', x, layout.y, thumbW, thumbH)
        } catch {
          // Corrupt/unsupported image data - leave the slot blank.
        }
      }
    })
    layout.y += thumbH + 8
  } else {
    layout.y += 2
  }
}

/** Every test case + ad-hoc run inside ONE sprint - the block shared by all
 *  three report levels (a sprint report IS this; a release/project report
 *  repeats it once per sprint). */
async function renderSprintContent(layout: PdfLayout, sprint: SprintReport) {
  const doc = layout.doc
  const c = PDF_COLORS

  layout.kpiCardGrid([
    { label: 'Assigned', value: sprint.assignedTestCount, color: c.ink },
    { label: 'Passed', value: sprint.passedTestCount, color: c.emerald },
    { label: 'Failed', value: sprint.failedTestCount, color: c.rose },
    { label: 'Not run', value: sprint.notRunTestCount, color: c.inkMuted },
    { label: 'Ad-hoc runs', value: sprint.adHocSummary.total, color: c.ink },
  ])

  if (sprint.testCases.length > 0) {
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin, right: layout.margin },
      head: [['Test case', 'Code', 'Status', 'Assignment', 'Last run']],
      body: sprint.testCases.map((tc) => [
        tc.name ?? tc.testRunId,
        tc.code ?? '-',
        tc.aggregatedStatus,
        tc.assignmentSource,
        tc.lastExecutedAt ? new Date(tc.lastExecutedAt).toLocaleString() : 'Never run',
      ]),
      styles: { fontSize: 8, textColor: [...c.inkSoft] },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 2 && cellData.section === 'body') {
          const status = String(cellData.cell.raw)
          if (status === 'PASSED') cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (status === 'FAILED' || status === 'PARTIAL') cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.finishAutoTableCursor()
  } else {
    layout.bodyText('No test cases assigned to this sprint.', { size: 8.5 })
  }

  if (sprint.adHocRuns.length > 0) {
    layout.subheading('Ad-hoc runs (not tied to an assigned test case)')
    layout.bodyText(
      `Launched from Author Tests / One-Click without an assigned test case - ${sprint.adHocSummary.passed} passed, ${sprint.adHocSummary.failed} failed, ${sprint.adHocSummary.running} running of ${sprint.adHocSummary.total} total.`,
      { size: 8, indent: 0 },
    )
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin, right: layout.margin },
      head: [['Run', 'Status', 'Browser', 'Created']],
      body: sprint.adHocRuns.map((r) => [r.testName ?? r.targetUrl ?? r.executionId, r.status, r.browser ?? '-', new Date(r.createdAt).toLocaleString()]),
      styles: { fontSize: 8, textColor: [...c.inkSoft] },
      headStyles: tableHeadStyles(),
    })
    layout.finishAutoTableCursor()
  }

  if (sprint.mobileRuns.length > 0) {
    layout.subheading('Mobile runs (Appium engine)')
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin, right: layout.margin },
      head: [['Run', 'Status', 'Device', 'Started']],
      body: sprint.mobileRuns.map((r) => [
        r.testName ?? `Execution #${r.executionId}`,
        r.status,
        r.deviceId != null ? `#${r.deviceId}` : '-',
        r.startedAt ? new Date(r.startedAt).toLocaleString() : '-',
      ]),
      styles: { fontSize: 8, textColor: [...c.inkSoft] },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 1 && cellData.section === 'body') {
          const status = String(cellData.cell.raw).toUpperCase()
          if (status === 'PASSED') cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (/(FAILED|INFRA_FAILURE|TIMEOUT|BLOCKED)/.test(status)) cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.finishAutoTableCursor()
  }

  if (sprint.apiRuns.length > 0) {
    layout.subheading('API runs')
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin, right: layout.margin },
      head: [['Run', 'Status', 'Started']],
      body: sprint.apiRuns.map((r) => [
        r.testName ?? `Execution #${r.executionId}`, r.status, r.startedAt ? new Date(r.startedAt).toLocaleString() : '-',
      ]),
      styles: { fontSize: 8, textColor: [...c.inkSoft] },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 1 && cellData.section === 'body') {
          const status = String(cellData.cell.raw)
          if (status === 'PASSED') cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (status === 'FAILED') cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.finishAutoTableCursor()
  }

  if (sprint.dbRuns.length > 0) {
    layout.subheading('Database runs')
    autoTable(doc, {
      startY: layout.y,
      margin: { left: layout.margin, right: layout.margin },
      head: [['Run', 'Status', 'Started']],
      body: sprint.dbRuns.map((r) => [
        r.testName ?? `Execution #${r.executionId}`, r.status, r.startedAt ? new Date(r.startedAt).toLocaleString() : '-',
      ]),
      styles: { fontSize: 8, textColor: [...c.inkSoft] },
      headStyles: tableHeadStyles(),
      didParseCell: (cellData) => {
        if (cellData.column.index === 1 && cellData.section === 'body') {
          const status = String(cellData.cell.raw)
          if (status === 'PASSED') cellData.cell.styles.textColor = [...c.emeraldDark]
          else if (status === 'FAILED') cellData.cell.styles.textColor = [...c.roseDark]
        }
      },
    })
    layout.finishAutoTableCursor()
  }

  // Failure detail - one block per failed test case, then per failed ad-hoc run.
  for (const tc of sprint.testCases) {
    for (const detail of tc.failureDetails) {
      await renderFailureDetail(layout, tc.name ?? tc.testRunId, detail)
    }
  }
  for (const r of sprint.adHocRuns) {
    if (r.executionDetail) await renderFailureDetail(layout, r.testName ?? r.executionId, r.executionDetail)
  }
}

function coverPage(doc: jsPDF, layout: PdfLayout, opts: { kicker: string; title: string; subtitle: string; totals: Array<{ label: string; value: string | number; color?: RGB }> }, logoDataUrl: string | null) {
  const c = PDF_COLORS
  const margin = layout.margin
  const setColor = (fn: (r: number, g: number, b: number) => jsPDF, rgb: RGB) => fn.call(doc, rgb[0], rgb[1], rgb[2])

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
  doc.text(opts.kicker, brandTextX, 26)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  setColor(doc.setTextColor.bind(doc), c.white)
  const titleLines = doc.splitTextToSize(opts.title, layout.contentWidth) as string[]
  doc.text(titleLines.slice(0, 2), margin, 44)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  setColor(doc.setTextColor.bind(doc), c.inkMuted)
  doc.text(`${opts.subtitle} - Generated ${new Date().toLocaleString()}`, margin, 56)

  layout.y = 76
  layout.kpiCardGrid(opts.totals)

  setColor(doc.setDrawColor.bind(doc), c.hairline)
  doc.setLineWidth(0.3)
  doc.line(margin, layout.y, margin + layout.contentWidth, layout.y)
  layout.y += 8
}

function runningHeaderFooter(doc: jsPDF, layout: PdfLayout, title: string) {
  const c = PDF_COLORS
  const setColor = (fn: (r: number, g: number, b: number) => jsPDF, rgb: RGB) => fn.call(doc, rgb[0], rgb[1], rgb[2])
  const pageCount = doc.getNumberOfPages()
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i)
    setColor(doc.setDrawColor.bind(doc), c.hairline)
    doc.setLineWidth(0.3)
    doc.line(layout.margin, 12, layout.pageWidth - layout.margin, 12)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    setColor(doc.setTextColor.bind(doc), c.inkMuted)
    doc.text(title, layout.margin, 9)
    doc.text(`Page ${i - 1} of ${pageCount - 1}`, layout.pageWidth - layout.margin, 9, { align: 'right' })
  }
}

/* ─────────────────────────── Sprint level ─────────────────────────── */

export async function downloadSprintReportPdf(sprintId: string): Promise<void> {
  const sprint = await api.getSprintReport(sprintId)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const layout = new PdfLayout(doc)
  const logoDataUrl = await getNovalantisLogoDataUrl()

  coverPage(
    doc, layout,
    {
      kicker: 'SPRINT REPORT',
      title: sprint.sprint.name,
      subtitle: `Release: ${sprint.release.name}`,
      totals: [
        { label: 'Assigned', value: sprint.assignedTestCount },
        { label: 'Passed', value: sprint.passedTestCount, color: PDF_COLORS.emerald },
        { label: 'Failed', value: sprint.failedTestCount, color: PDF_COLORS.rose },
        { label: 'Not run', value: sprint.notRunTestCount, color: PDF_COLORS.inkMuted },
        { label: 'Mobile runs', value: sprint.mobileSummary.total },
        { label: 'API runs', value: sprint.apiSummary.total },
        { label: 'DB runs', value: sprint.dbSummary.total },
      ],
    },
    logoDataUrl,
  )

  doc.addPage()
  layout.y = layout.margin + 4
  layout.sectionTitle(sprint.sprint.name)
  await renderSprintContent(layout, sprint)

  runningHeaderFooter(doc, layout, `NOVATEST AI - SPRINT REPORT - ${sprint.sprint.name.toUpperCase()}`)
  doc.save(`NovaTest_Sprint_${sprint.sprint.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`)
}

export async function downloadSprintReportJson(sprintId: string): Promise<void> {
  const sprint = await api.getSprintReport(sprintId)
  downloadJson(sprint, `NovaTest_Sprint_${sprint.sprint.name.replace(/[^a-z0-9]+/gi, '_')}.json`)
}

/* ─────────────────────────── Release level ─────────────────────────── */

export async function downloadReleaseReportPdf(releaseId: string): Promise<void> {
  const release = await api.getReleaseReport(releaseId)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const layout = new PdfLayout(doc)
  const logoDataUrl = await getNovalantisLogoDataUrl()

  coverPage(
    doc, layout,
    {
      kicker: 'RELEASE REPORT',
      title: release.release.name,
      subtitle: `${release.sprintCount} sprint${release.sprintCount === 1 ? '' : 's'}`,
      totals: [
        { label: 'Assigned', value: release.totals.assigned },
        { label: 'Passed', value: release.totals.passed, color: PDF_COLORS.emerald },
        { label: 'Failed', value: release.totals.failed, color: PDF_COLORS.rose },
        { label: 'Not run', value: release.totals.notRun, color: PDF_COLORS.inkMuted },
        { label: 'Ad-hoc runs', value: release.totals.adHocTotal },
        { label: 'Mobile runs', value: release.totals.mobileTotal },
        { label: 'API runs', value: release.totals.apiTotal },
        { label: 'DB runs', value: release.totals.dbTotal },
      ],
    },
    logoDataUrl,
  )

  doc.addPage()
  layout.y = layout.margin + 4
  for (const sprint of release.sprints) {
    layout.sectionTitle(sprint.sprint.name)
    await renderSprintContent(layout, sprint)
  }
  if (release.sprints.length === 0) {
    layout.sectionTitle('No sprints')
    layout.bodyText('This release has no sprints yet.')
  }

  runningHeaderFooter(doc, layout, `NOVATEST AI - RELEASE REPORT - ${release.release.name.toUpperCase()}`)
  doc.save(`NovaTest_Release_${release.release.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`)
}

export async function downloadReleaseReportJson(releaseId: string): Promise<void> {
  const release = await api.getReleaseReport(releaseId)
  downloadJson(release, `NovaTest_Release_${release.release.name.replace(/[^a-z0-9]+/gi, '_')}.json`)
}

/* ─────────────────────────── Project level ─────────────────────────── */

export async function downloadProjectReportPdf(projectId: string): Promise<void> {
  const project = await api.getProjectReport(projectId)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const layout = new PdfLayout(doc)
  const logoDataUrl = await getNovalantisLogoDataUrl()

  coverPage(
    doc, layout,
    {
      kicker: 'CONSOLIDATED PROJECT REPORT',
      title: project.project.name,
      subtitle: `${project.releaseCount} release${project.releaseCount === 1 ? '' : 's'}`,
      totals: [
        { label: 'Assigned', value: project.totals.assigned },
        { label: 'Passed', value: project.totals.passed, color: PDF_COLORS.emerald },
        { label: 'Failed', value: project.totals.failed, color: PDF_COLORS.rose },
        { label: 'Not run', value: project.totals.notRun, color: PDF_COLORS.inkMuted },
        { label: 'Ad-hoc runs', value: project.totals.adHocTotal },
        { label: 'Mobile runs', value: project.totals.mobileTotal },
        { label: 'API runs', value: project.totals.apiTotal },
        { label: 'DB runs', value: project.totals.dbTotal },
      ],
    },
    logoDataUrl,
  )

  doc.addPage()
  layout.y = layout.margin + 4
  for (const release of project.releases) {
    layout.sectionTitle(release.release.name)
    layout.bodyText(
      `${release.sprintCount} sprint${release.sprintCount === 1 ? '' : 's'} - ${release.totals.passed} passed - ${release.totals.failed} failed - ${release.totals.notRun} not run - ${release.totals.adHocTotal} ad-hoc run${release.totals.adHocTotal === 1 ? '' : 's'} (${release.totals.adHocPassed} passed, ${release.totals.adHocFailed} failed)`,
      { size: 8.5, bold: true },
    )
    layout.y += 2
    for (const sprint of release.sprints) {
      layout.subheading(sprint.sprint.name, 4)
      await renderSprintContent(layout, sprint)
    }
    if (release.sprints.length === 0) {
      layout.bodyText('No sprints in this release yet.', { indent: 4 })
    }
  }
  if (project.releases.length === 0) {
    layout.sectionTitle('No releases')
    layout.bodyText('This project has no releases yet.')
  }

  runningHeaderFooter(doc, layout, `NOVATEST AI - CONSOLIDATED REPORT - ${project.project.name.toUpperCase()}`)
  doc.save(`NovaTest_Project_${project.project.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`)
}

export async function downloadProjectReportJson(projectId: string): Promise<void> {
  const project = await api.getProjectReport(projectId)
  downloadJson(project, `NovaTest_Project_${project.project.name.replace(/[^a-z0-9]+/gi, '_')}.json`)
}
