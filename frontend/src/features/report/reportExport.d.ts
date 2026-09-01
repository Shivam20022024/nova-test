/**
 * Type surface for `reportExport.js`, carried over verbatim from the previous
 * frontend. Builds the executive PDF (jsPDF + autotable), a standalone HTML
 * document, the normalised JSON, and a zip bundle of all of them.
 */
import type { NormalizedReport } from './reportTransform'

export type PdfExportOptions = {
  /** When true (the default) the file is handed to the browser to save. */
  download?: boolean
}

/**
 * Renders the multi-section executive PDF. With `download: false` the jsPDF
 * document is returned instead of being saved, so callers can embed it.
 */
export function generateReportPdf(
  report: NormalizedReport,
  options?: PdfExportOptions,
): Promise<any>;

/** Renders the report as a standalone HTML document string. */
export function generateReportHtml(report: NormalizedReport): string;

/** Triggers a download of the normalised report JSON. */
export function generateReportJson(report: NormalizedReport): void;

/** Bundles PDF + HTML + JSON into a single zip and downloads it. */
export function generateReportZip(report: NormalizedReport): Promise<void>;
