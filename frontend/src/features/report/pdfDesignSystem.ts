/**
 * Shared visual language for every NovaTest AI PDF report — one source of
 * truth for the brand palette and the pass/fail/at-risk colour treatment,
 * used by both the web report (reportExport.js) and the mobile report
 * (mobileReportExport.ts) so the two documents read as one product's output
 * rather than two independently-designed ones.
 *
 * Deliberately just the palette + pure colour logic, not the stateful
 * drawing helpers (sectionTitle/kpiCardGrid/etc.) — those close over a
 * mutable cursor position per-document and stay local to each export file,
 * but both files build them with these same colours.
 */

export const PDF_COLORS = {
  ink: [15, 23, 42] as const, // slate-900 — primary text
  inkSoft: [71, 85, 105] as const, // slate-600 — secondary text
  inkMuted: [148, 163, 184] as const, // slate-400 — tertiary text
  hairline: [226, 232, 240] as const, // slate-200 — dividers
  panelBg: [248, 250, 252] as const, // slate-50 — subtle panel fill
  brandIndigo: [79, 70, 229] as const,
  brandCyan: [8, 145, 178] as const,
  emerald: [16, 185, 129] as const,
  emeraldDark: [22, 101, 52] as const,
  emeraldBg: [236, 253, 245] as const,
  emeraldBorder: [110, 231, 183] as const,
  rose: [244, 63, 94] as const,
  roseDark: [159, 18, 57] as const,
  roseBg: [255, 241, 242] as const,
  roseBorder: [251, 165, 178] as const,
  amber: [217, 119, 6] as const,
  amberDark: [133, 77, 14] as const,
  amberBg: [255, 251, 235] as const,
  amberBorder: [252, 211, 77] as const,
  white: [255, 255, 255] as const,
}

export const PDF_MARGIN = 16

export type RgbColor = readonly [number, number, number]

export type DecisionPalette = {
  bg: RgbColor
  border: RgbColor
  text: RgbColor
  accent: RgbColor
}

/** Same three-way palette web's release-decision hero uses (APPROVED /
 *  BLOCKED / everything else, e.g. CONDITIONAL) — reused as-is for mobile's
 *  PASSED / FAILED decision hero so "green means good" reads identically
 *  across both reports. */
export function pdfDecisionPalette(decision: string | null | undefined): DecisionPalette {
  const isApproved = decision === 'APPROVED' || decision === 'PASSED'
  const isBlocked = decision === 'BLOCKED' || decision === 'FAILED'
  if (isApproved) {
    return { bg: PDF_COLORS.emeraldBg, border: PDF_COLORS.emeraldBorder, text: PDF_COLORS.emeraldDark, accent: PDF_COLORS.emerald }
  }
  if (isBlocked) {
    return { bg: PDF_COLORS.roseBg, border: PDF_COLORS.roseBorder, text: PDF_COLORS.roseDark, accent: PDF_COLORS.rose }
  }
  return { bg: PDF_COLORS.amberBg, border: PDF_COLORS.amberBorder, text: PDF_COLORS.amberDark, accent: PDF_COLORS.amber }
}
